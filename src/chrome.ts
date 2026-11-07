import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export const FLOW_URL = "https://flow.google.com/";
// Flow's buttons are found by their English names ("Start generation", "Download"...), so Flow has to show in English
// whatever language the Google account uses. `hl=en` on the address does that: `hl=es` turned every label Spanish on
// an English account (2026-10-13), the choice holds through Flow's in-app navigation, and the browser's own language
// changes nothing. It only lasts until the next full page load, so every load adds it and ensureEnglish re-checks.
export const inEnglish = (url: string): string => {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
};
const FLOW_HOSTS = /^https:\/\/(flow\.google\.com|labs\.google\/fx)/;
export const HOME_DIR = process.env.FLOW_MCP_HOME ?? join(homedir(), ".flow-mcp");
export const PROFILE_DIR = join(HOME_DIR, "chrome-profile");
export const CDP_PORT = Number(process.env.FLOW_MCP_CDP_PORT ?? 9333);
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

const CHROME_PATHS = [
  process.env.FLOW_MCP_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  // Windows also installs Chrome here: 32-bit builds, and per-user installs made without admin rights.
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
].filter((p): p is string => Boolean(p));

let browser: Browser | null = null;

async function cdpUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Real Chrome with a dedicated profile: Google sign-in works normally and the
// session persists, while the user's everyday profile is never touched.
export function chromeExecutable(): string {
  const chromePath = CHROME_PATHS.find((p) => existsSync(p));
  if (!chromePath) throw new Error("Google Chrome not found. Set FLOW_MCP_CHROME to the Chrome executable path.");
  return chromePath;
}

async function launchChrome(): Promise<void> {
  const chromePath = chromeExecutable();
  mkdirSync(PROFILE_DIR, { recursive: true });
  const child = spawn(
    chromePath,
    [
      `--user-data-dir=${PROFILE_DIR}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--no-first-run",
      "--no-default-browser-check",
      inEnglish(FLOW_URL),
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Chrome started but CDP port ${CDP_PORT} never came up.`);
}

// While a CDP client is attached, Chrome holds a "Capturing" NoDisplaySleep power assertion (Playwright turns on focus
// emulation for the pages it attaches to), so the Mac's display never sleeps, even with nothing running (seen
// 2026-11-07 with `pmset -g assertions`: ~10 h). So this process lets go of the CDP connection once it has been idle
// for IDLE_MS: Chrome, the Google sign-in and the tabs stay, and the next call reconnects on its own (the MCP
// connection to the app is untouched, nothing to reconnect by hand). Work in progress holds a lease (`holding`), so a
// generation, a download or a slow call is never cut off. FLOW_MCP_IDLE_DISCONNECT_S=0 keeps the old behaviour.
const IDLE_MS = Number(process.env.FLOW_MCP_IDLE_DISCONNECT_S ?? 180) * 1000;
let leases = 0;
let idleTimer: NodeJS.Timeout | undefined;
function armIdle(): void {
  clearTimeout(idleTimer);
  if (!IDLE_MS || leases > 0 || !browser) return;
  idleTimer = setTimeout(() => {
    if (leases > 0) return;
    const b = browser;
    browser = null;
    void b?.close().catch(() => {}); // over CDP, close() only disconnects: Chrome and its tabs keep running
  }, IDLE_MS);
  idleTimer.unref();
}
export async function holding<T>(work: Promise<T>): Promise<T> {
  leases++;
  clearTimeout(idleTimer);
  try {
    return await work;
  } finally {
    leases--;
    armIdle();
  }
}

export async function getBrowser(): Promise<Browser> {
  armIdle(); // a caller without a lease still gets the idle disconnect later
  if (browser?.isConnected()) return browser;
  if (!(await cdpUp())) await launchChrome();
  browser = await chromium.connectOverCDP(CDP_URL);
  armIdle();
  return browser;
}

// ONE Chrome, ONE Google sign-in, ONE TAB PER PROJECT. Two Claude sessions (two channels) each run their own flow-mcp
// process; each process works in its own project's tab and never touches another's. A process is pinned to a project by
// flow_project or by FLOW_MCP_PROJECT (a project URL, id or exact title); without either it keeps the old behaviour and
// drives the first Flow tab - but never one another live process has claimed. Claims are files in HOME/projects named
// after the project id, holding the pid; a claim whose pid is gone counts for nothing, so a crash leaves nothing stuck.
export const PINNED_PROJECT = process.env.FLOW_MCP_PROJECT?.trim() || undefined;
const PROJECT_RE = /\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export const projectIdOf = (url: string): string | undefined => url.match(PROJECT_RE)?.[1]?.toLowerCase();
const projectUrl = (id: string) => `${FLOW_URL}project/${id}`;
const CLAIMS_DIR = join(HOME_DIR, "projects");

export function alive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The live process (other than this one) that has this project, if any.
export function claimedBy(id: string | undefined): number | undefined {
  if (!id) return undefined;
  try {
    const pid = Number(readFileSync(join(CLAIMS_DIR, id), "utf8"));
    return pid !== process.pid && alive(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}
function claim(id: string): void {
  mkdirSync(CLAIMS_DIR, { recursive: true });
  writeFileSync(join(CLAIMS_DIR, id), String(process.pid));
}
function release(id: string | undefined): void {
  if (!id) return;
  const file = join(CLAIMS_DIR, id);
  try {
    if (Number(readFileSync(file, "utf8")) === process.pid) rmSync(file, { force: true });
  } catch {
    /* not ours, or already gone */
  }
}

type Binding = { id: string; page?: Page; by: "flow_project" | "FLOW_MCP_PROJECT" };
let bound: Binding | undefined;
// The project the unpinned process last drove, claimed so nobody pins it from under us.
let defaultClaim: string | undefined;

export const boundBy = (): string => bound?.by ?? "first Flow tab (no flow_project yet)";

async function flowContext(): Promise<BrowserContext> {
  const context = (await getBrowser()).contexts()[0];
  if (!context) throw new Error("Chrome has no browser context; restart the Flow Chrome window.");
  return context;
}

export async function getFlowPage(): Promise<Page> {
  if (!bound && PINNED_PROJECT) await bindProject(UUID_RE.test(PINNED_PROJECT) ? { id: PINNED_PROJECT } : { name: PINNED_PROJECT }, "FLOW_MCP_PROJECT");
  if (bound) return boundPage(bound);
  const context = await flowContext();
  const existing = context.pages().find((p) => FLOW_HOSTS.test(p.url()) && !claimedBy(projectIdOf(p.url())));
  const page = existing ?? (await context.newPage());
  if (!existing) await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
  await ensureEnglish(page);
  const id = projectIdOf(page.url());
  if (id !== defaultClaim) {
    release(defaultClaim);
    if (id) claim(id);
    defaultClaim = id;
  }
  return page;
}

// The pinned tab, reopened if it was closed and sent back to its project if someone navigated it away.
async function boundPage(b: Binding): Promise<Page> {
  if (!b.page || b.page.isClosed()) {
    const context = await flowContext();
    b.page = context.pages().find((p) => projectIdOf(p.url()) === b.id) ?? (await context.newPage());
  }
  if (projectIdOf(b.page.url()) !== b.id) await b.page.goto(inEnglish(projectUrl(b.id)), { waitUntil: "domcontentloaded" });
  await ensureEnglish(b.page);
  return b.page;
}

// Pins this process to one Flow project: by id/URL, or by EXACT title - opened when it exists, created (New project, then
// renamed) when it does not. The studio's convention is one project per channel, "<Channel> Arts". Reuses a tab already
// showing the project, else opens one. Refuses a project another live flow-mcp process holds: two processes in one
// project read each other's new tiles as their own.
export async function bindProject(target: { id?: string; name?: string }, by: Binding["by"]): Promise<{ id: string; title: string; url: string; created: boolean }> {
  const context = await flowContext();
  let id = target.id?.match(UUID_RE)?.[0]?.toLowerCase();
  if (target.id && !id) throw new Error(`"${target.id}" holds no Flow project id; pass the project's address (flow.google.com/project/<id>) or its title as name.`);
  let page: Page | undefined;
  let created = false;
  const name = target.name?.trim();
  if (!id) {
    if (!name) throw new Error("Pass name (opens or creates the project with that exact title), url or id.");
    // Flow's home page lists every project as <flow-project-card>: a link to /project/<id> and the title.
    page = await context.newPage();
    try {
      await page.goto(inEnglish(FLOW_URL), { waitUntil: "domcontentloaded" });
      await ensureEnglish(page);
      if (/\/about|accounts\.google\.com/.test(page.url())) throw new Error("Not signed in. Run `npm run login` and sign in to Google in the Flow Chrome window.");
      await page.locator("flow-project-card, button:has-text('New project')").first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1500);
      // ponytail: reads the cards the home page shows at once; scroll it if an account ever has more than one screenful.
      const cards = await page.evaluate(() =>
        [...document.querySelectorAll("flow-project-card")].map((c) => ({
          href: c.querySelector("a[href*='/project/']")?.getAttribute("href") ?? "",
          title: c.querySelector(".project-title-text")?.textContent?.trim() ?? "",
        })),
      );
      const same = cards.filter((c) => c.title.toLowerCase() === name.toLowerCase());
      if (same.length > 1) throw new Error(`${same.length} Flow projects are called "${name}". Rename one in Flow, or pass the url of the one you mean.`);
      id = projectIdOf(same[0]?.href ?? "");
      if (!id) {
        await page.getByRole("button", { name: "New project" }).click({ timeout: 10_000 });
        await page.waitForURL(PROJECT_RE, { timeout: 30_000 });
        id = projectIdOf(page.url())!;
        created = true;
        // The title is an <input aria-label="Editable text"> in the project's top bar (mapped 2026-11-07); Enter saves it.
        const title = page.getByRole("textbox", { name: "Editable text" });
        await title.click({ timeout: 15_000 });
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.type(name, { delay: 8 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1500);
        // Unrenamed, the next flow_project with this name would not find it and would make yet another project.
        if (!(await page.title()).endsWith(name)) {
          throw new Error(`Created a Flow project but could not name it "${name}" (${projectUrl(id)}). Rename it in Flow, then call flow_project again.`);
        }
      }
    } catch (err) {
      if (!created) await page.close().catch(() => {});
      throw err;
    }
  }
  const holder = claimedBy(id);
  if (holder) {
    if (page && !created) await page.close().catch(() => {});
    throw new Error(
      `Flow project ${name ? `"${name}" ` : ""}(${projectUrl(id)}) is in use by another flow-mcp process (pid ${holder}), most likely another Claude session. ` +
        `Pick a different project, or finish that session first.`,
    );
  }
  const shown = context.pages().find((p) => p !== page && projectIdOf(p.url()) === id);
  if (shown) {
    await page?.close().catch(() => {});
    page = shown;
  }
  page ??= await context.newPage();
  if (projectIdOf(page.url()) !== id) await page.goto(inEnglish(projectUrl(id)), { waitUntil: "domcontentloaded" });
  await ensureEnglish(page);
  if (bound?.id !== id) release(bound?.id);
  if (defaultClaim !== id) release(defaultClaim);
  defaultClaim = undefined;
  claim(id);
  bound = { id, page, by };
  // Right after a load the tab still has a generic title; the project's own arrives a moment later.
  await page.waitForFunction(() => document.title.startsWith("Google Flow - "), null, { timeout: 15_000 }).catch(() => {});
  return { id, title: projectTitle(await page.title()) ?? "", url: projectUrl(id), created };
}

// A project tab's title reads "Google Flow - <project title>"; anything else is a page still loading.
export const projectTitle = (tabTitle: string): string | undefined => tabTitle.match(/^Google Flow - (.+)$/)?.[1]?.trim();

// A mutex shared by every flow-mcp process on this machine: a file created exclusively (O_EXCL) holding the pid. A holder
// that died, or held it past staleMs, is taken over.
// ponytail: two waiters taking over the same stale lock in the same instant can both get in; fine for a few-second hold.
export async function withLock<T>(name: string, staleMs: number, work: () => Promise<T>): Promise<T> {
  const file = join(HOME_DIR, `${name}.lock`);
  mkdirSync(HOME_DIR, { recursive: true });
  for (;;) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const pid = Number(readFileSync(file, "utf8"));
        if ((pid !== process.pid && !alive(pid)) || Date.now() - statSync(file).mtimeMs > staleMs) rmSync(file, { force: true });
      } catch {
        /* released between the two reads: just try again */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  try {
    return await work();
  } finally {
    try {
      if (Number(readFileSync(file, "utf8")) === process.pid) rmSync(file, { force: true });
    } catch {
      /* taken over as stale */
    }
  }
}

// Reloads Flow in English when it is showing in another language (a page the user opened by hand, or Flow redirecting
// to an address without hl). Sign-in pages are left alone.
export async function ensureEnglish(page: Page): Promise<void> {
  if (!/^https:\/\/flow\.google\.com\//.test(page.url())) return;
  const lang = () => page.evaluate(() => document.documentElement.lang).catch(() => "");
  const now = await lang();
  if (!now || /^en\b/i.test(now)) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 15_000 }).catch(() => {});
  const after = await lang();
  if (after && !/^en\b/i.test(after)) {
    throw new Error(
      `Flow is showing in "${after}" and would not switch to English. flow-mcp finds Flow's buttons by their English names. ` +
        `Add ?hl=en to the end of Flow's address in the Flow Chrome window, or set your Google account's language to English (myaccount.google.com/language).`,
    );
  }
}
