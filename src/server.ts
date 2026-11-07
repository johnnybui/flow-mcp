import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import { HOME_DIR, holding } from "./chrome.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";

export const PORT = Number(process.env.FLOW_MCP_PORT ?? 8787);
export const TOKEN_FILE = join(HOME_DIR, "token");
// Each port gets its own token file: one process writing "token" for a second port would lock every client of the
// first one out (401).
const tokenFile = (port: number) => (port === PORT ? TOKEN_FILE : join(HOME_DIR, `token-${port}`));
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../studio/index.html", import.meta.url));
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!(inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR) || inside(file, CAPTIONS_DIR)) || !existsSync(file)) return json(res, 404, { error: "Not found." });
  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
}

export type ServerRole = "owner" | "client" | "none";
export interface Served {
  role: ServerRole;
  // Where the Studio panel this process uses is served (its own, or the owner's for a client).
  port?: number;
  note: string;
}

// Serves the Studio panel and a JSON API on localhost. Role "client" when another flow-mcp process already owns the
// port (that process owns the Flow tab and the queue), "none" when the port is taken by something else.
// `independent` is for a process pinned to its own project (flow_project, FLOW_MCP_PROJECT): it must never become
// someone else's client, so it serves on the next free port after PORT - leaving PORT, and today's owner/client
// behaviour, to unpinned processes - and simply goes without a panel when none is free. It never waits.
export async function startServer(core: Core, independent = false): Promise<Served> {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const token = randomBytes(24).toString("hex");
  let allowedHosts = new Set<string>();

  const server = createServer(async (req, res) => {
    try {
      // The Host check blocks DNS-rebinding; the token blocks other local pages from driving the queue.
      if (!allowedHosts.has(req.headers.host ?? "")) return json(res, 403, { error: "Bad host." });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { name: "flow-mcp" });
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token));
      }

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      if (given !== token) return json(res, 401, { error: "Missing or wrong token." });

      if (req.method === "GET" && url.pathname === "/media") return sendMedia(req, res, url.searchParams.get("path") ?? "");

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(UPLOAD_DIR, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, await readBody(req, MAX_UPLOAD));
        return json(res, 200, { path });
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && method && typeof core[method] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await holding((core[method] as (a: unknown) => Promise<unknown>)(args))); // Studio panel + forwarded calls keep the CDP connection too
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  const listen = (port: number) =>
    new Promise<boolean>((ok) => {
      server.once("error", () => ok(false));
      server.listen(port, "127.0.0.1", () => ok(true));
    });
  for (const port of independent ? Array.from({ length: 10 }, (_, i) => PORT + 1 + i) : [PORT]) {
    if (!(await listen(port))) continue;
    allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(tokenFile(port), token, { mode: 0o600 });
    return { role: "owner", port, note: `Flow Studio is served by this process at http://127.0.0.1:${port}.` };
  }
  if (independent) return { role: "none", note: `Flow Studio is not served by this process: ports ${PORT + 1}-${PORT + 10} are all taken.` };
  // The port is taken. Who has it matters enormously: becoming a second LOCAL core means two processes drive the same
  // Flow tab with separate queues, which is how a shot got generated and charged twice while flow_status reported an
  // empty queue (2026-09-20). Claude Desktop starts several of these at once and the owner is often still booting, or
  // busy inside a Playwright call, so one 2 s health check timing out proves nothing.
  const client: Served = {
    role: "client",
    port: PORT,
    note: `Another flow-mcp process owns port ${PORT}; this one passes its calls to it (same tab, same queue) until flow_project gives it a project of its own.`,
  };
  for (let attempt = 0; attempt < 8; attempt++) {
    const other = (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => r.json(),
      () => null,
    )) as { name?: string } | null;
    if (other?.name === "flow-mcp") return client;
    // A valid answer from something that is NOT us means the port belongs to an unrelated program, and driving Flow
    // locally is safe.
    if (other) return { role: "none", note: `Port ${PORT} is used by another program, so Flow Studio is not served; this process drives Flow itself.` };
    await new Promise((r) => setTimeout(r, 1500));
  }
  // Never confirmed, but something holds the port and it is most likely a busy sibling. Defer to it: a client whose
  // calls fail loudly is far better than a second process silently spending the user's credits.
  return client;
}
