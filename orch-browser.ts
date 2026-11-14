// Browser checks for QA: find a Chromium-based browser, start the repo's dev server, open the pages a plan names
// over the Chrome DevTools Protocol (Node's built-in WebSocket, no dependencies) and save screenshots and
// measurements for the verifiers. Used by orch.ts; bundled into orch.mjs.
//
// Nothing here is a browser of our own: it uses Chrome, Edge, Chromium or Brave as installed, or Chrome for
// Testing that `orch browser install` downloaded into ~/.yaaiorch/browser. Each repo gets its own profile
// (~/.yaaiorch/browser-profiles/<hash>), so a login made with `orch browser login` is reused by the checks.
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Theme = "light" | "dark";
export type VisualAction = { click: string } | { wait: string | number };
/** One page to check, from a verify task's "visual" list. */
export type VisualTarget = { path: string; selector?: string; actions?: VisualAction[]; viewports?: number[]; themes?: Theme[] };
/** `file`: relative to the repo root, with forward slashes. */
export type Shot = { target: number; path: string; viewport: number; theme: Theme; file: string };
/**
 * `problems` fail the round (the page did not render, a selector or action failed, the app left localhost).
 * `observations` are measured facts QA weighs (page errors, console errors, failed requests, overflow, layout shift):
 * they may predate the change, so only QA can tell whether the goal caused them.
 */
export type VisualResult = { url: string; shots: Shot[]; problems: string[]; observations: string[]; ms: number };
/** Config "serve": how to start the app. Without `command`, something else must already serve `url`. */
export type ServeConfig = { command?: string; url: string; timeout?: number };

export const DEFAULT_VIEWPORTS = [1280, 375];
export const MAX_TARGETS = 5;
const MAX_ACTIONS = 10;
const MAX_VIEWPORTS = 3;
const NAV_TIMEOUT_MS = 30_000;
const SELECTOR_TIMEOUT_MS = 10_000;
const MAX_SHOT_HEIGHT = 8000;
const HOME = join(homedir(), ".yaaiorch");
export const INSTALL_DIR = join(HOME, "browser");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const clip = (s: string, n = 300) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// ---------- config and plan validation (pure) ----------
/** Only this machine: the checks must never drive a real site with the user's sessions. */
export function isLocalUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const h = url.hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
}

export function parseServe(v: unknown): ServeConfig {
  const s = v as ServeConfig;
  if (!s || typeof s !== "object" || typeof s.url !== "string") throw new Error('config "serve" must be {"url": "http://localhost:PORT", "command": "..."}');
  if (!isLocalUrl(s.url)) throw new Error(`config "serve": url must be on this machine (localhost, 127.0.0.1, [::1] or *.localhost), got "${s.url}"`);
  if (s.command !== undefined && (typeof s.command !== "string" || !s.command.trim())) throw new Error('config "serve": command must be a non-empty string');
  if (s.timeout !== undefined && !(typeof s.timeout === "number" && s.timeout > 0 && s.timeout <= 1800))
    throw new Error('config "serve": timeout must be a number of seconds (1 to 1800)');
  return { url: s.url, ...(s.command ? { command: s.command } : {}), ...(s.timeout ? { timeout: s.timeout } : {}) };
}

/** A verify task's "visual" list, checked and with defaults filled in. Throws with a reason the architect can act on. */
export function validateTargets(v: unknown, where: string): VisualTarget[] {
  if (!Array.isArray(v) || !v.length) throw new Error(`${where}: visual must be a non-empty list`);
  if (v.length > MAX_TARGETS) throw new Error(`${where}: visual lists ${v.length} pages; at most ${MAX_TARGETS}`);
  const sel = (s: unknown, what: string) => {
    if (typeof s !== "string" || !s.trim() || s.length > 300) throw new Error(`${where}: ${what} must be a CSS selector (1 to 300 characters)`);
    return s;
  };
  return v.map((raw, i) => {
    const t = raw as Record<string, unknown>;
    const at = `${where}: visual[${i}]`;
    if (!t || typeof t !== "object") throw new Error(`${at} must be an object`);
    const path = t.path;
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\\\s]/.test(path) || path.length > 300)
      throw new Error(`${at}: path must start with "/" and be a path in the app (no host, spaces or backslashes), got ${JSON.stringify(path)}`);
    const out: VisualTarget = { path };
    if (t.selector !== undefined) out.selector = sel(t.selector, `visual[${i}].selector`);
    if (t.actions !== undefined) {
      if (!Array.isArray(t.actions) || t.actions.length > MAX_ACTIONS) throw new Error(`${at}: actions must be a list of at most ${MAX_ACTIONS}`);
      out.actions = t.actions.map((a, j) => {
        const act = a as Record<string, unknown>;
        const keys = act && typeof act === "object" ? Object.keys(act) : [];
        if (keys.length === 1 && keys[0] === "click") return { click: sel(act.click, `actions[${j}].click`) };
        if (keys.length === 1 && keys[0] === "wait") {
          if (typeof act.wait === "number" && act.wait >= 0 && act.wait <= 30_000) return { wait: act.wait };
          return { wait: sel(act.wait, `actions[${j}].wait`) };
        }
        throw new Error(`${at}: actions[${j}] must be {"click": "<selector>"} or {"wait": "<selector>" | milliseconds}`);
      });
    }
    const vps = t.viewports ?? DEFAULT_VIEWPORTS;
    if (!Array.isArray(vps) || !vps.length || vps.length > MAX_VIEWPORTS || !vps.every((w) => Number.isInteger(w) && w >= 240 && w <= 3840))
      throw new Error(`${at}: viewports must be 1 to ${MAX_VIEWPORTS} widths in pixels (240 to 3840)`);
    out.viewports = [...new Set(vps as number[])];
    const themes = t.themes ?? ["light"];
    if (!Array.isArray(themes) || !themes.length || !themes.every((x) => x === "light" || x === "dark"))
      throw new Error(`${at}: themes must be ["light"], ["dark"] or ["light", "dark"]`);
    out.themes = [...new Set(themes as Theme[])];
    return out;
  });
}

/** File name for a screenshot: "2-settings-profile-375-dark.png". */
export function shotName(target: number, path: string, viewport: number, theme: Theme): string {
  const slug =
    path
      .split(/[?#]/)[0]
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "home";
  return `${target + 1}-${slug}-${viewport}-${theme}.png`;
}

/** What the verifiers are told: the screenshots to open and the measurements, for the pages of their own task. */
export function visualReport(r: VisualResult, targets: number[]): string {
  const shots = r.shots.filter((s) => targets.includes(s.target));
  if (!shots.length && !r.problems.length && !r.observations.length) return "";
  // One screenshot per page and theme must be looked at (the narrowest, where layouts break first); in a real run
  // QA otherwise opened only the two it found most telling and never saw one page's dark theme.
  const narrowest = new Map<string, Shot>();
  for (const s of shots) {
    const key = `${s.target} ${s.theme}`;
    const cur = narrowest.get(key);
    if (!cur || s.viewport < cur.viewport) narrowest.set(key, s);
  }
  const required = new Set(narrowest.values());
  return (
    `\n\n## Browser check\nThe orchestrator opened the app (${r.url}) in a real browser after the checks.` +
    (shots.length
      ? `\nScreenshots: open every one marked "required" with your Read tool (one per page and theme), and the others ` +
        `when something looks off or the goal is about that width. Judge them against the goal: layout, content, both themes.\n` +
        shots.map((s) => `- ${s.file}: ${s.path} at ${s.viewport}px, ${s.theme} theme${required.has(s) ? " (required)" : ""}`).join("\n")
      : "") +
    (r.problems.length ? `\nProblems (these already fail the round):\n- ${r.problems.join("\n- ")}` : "") +
    (r.observations.length
      ? `\nMeasured in the browser (fail for the ones this goal's change caused or should have fixed; ignore the rest):\n- ${r.observations.join("\n- ")}`
      : "\nMeasured in the browser: no page errors, console errors, failed requests or horizontal overflow.")
  );
}

// ---------- finding a browser ----------
/** Chrome for Testing's platform name for this machine, or undefined where it has no build. */
export function cftPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string | undefined {
  if (platform === "win32") return arch === "ia32" ? "win32" : "win64";
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : "mac-x64";
  if (platform === "linux" && arch === "x64") return "linux64";
  return undefined;
}

/** Where the usual Chromium browsers live, in order of preference: absolute paths, or bare names to look up on PATH. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string[] {
  if (platform === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    const rel = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Chromium\\Application\\chrome.exe",
      "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    ];
    return rel.flatMap((r) => roots.map((root) => win32.join(root, r)));
  }
  if (platform === "darwin") {
    const apps = ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser", "Google Chrome for Testing"];
    return apps.flatMap((a) => [`/Applications/${a}.app/Contents/MacOS/${a}`, join(home, "Applications", `${a}.app/Contents/MacOS/${a}`)]);
  }
  return ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

function onPosixPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) if (isFile(join(dir, name))) return join(dir, name);
  return undefined;
}

/** The browser `orch browser install` put in ~/.yaaiorch/browser, if any. */
function installedBrowser(): string | undefined {
  try {
    const cur = JSON.parse(readFileSync(join(INSTALL_DIR, "current.json"), "utf8")) as { path?: string };
    return cur.path && isFile(cur.path) ? cur.path : undefined;
  } catch {
    return undefined;
  }
}

/** YAAIORCH_BROWSER, else Chrome for Testing from `orch browser install`, else an installed Chrome, Edge, Chromium or Brave. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): { path: string; via: string } | undefined {
  if (env.YAAIORCH_BROWSER) return isFile(env.YAAIORCH_BROWSER) ? { path: env.YAAIORCH_BROWSER, via: "YAAIORCH_BROWSER" } : undefined;
  const own = installedBrowser();
  if (own) return { path: own, via: "orch browser install" };
  for (const c of browserCandidates(process.platform, env)) {
    const p = c.includes("/") || c.includes("\\") ? (isFile(c) ? c : undefined) : onPosixPath(c, env);
    if (p) return { path: p, via: "installed" };
  }
  return undefined;
}

/** This repo's browser profile: logins from `orch browser login` live here, apart from the user's own browser. */
export function profileDir(repo = process.cwd()): string {
  let real = repo;
  try {
    real = realpathSync(repo);
  } catch {
    /* use as given */
  }
  return join(HOME, "browser-profiles", createHash("sha256").update(real.toLowerCase()).digest("hex").slice(0, 12));
}

export const hasWebSocket = () => typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";

// ---------- processes ----------
function killProcessTree(p: ChildProcess) {
  if (!p.pid || p.exitCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-p.pid, "SIGTERM"); // started detached: its own process group
  } catch {
    try {
      p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

/** The repo's dev server: started once per goal (kept across rounds, since dev servers reload on change), stopped by orch. */
export class DevServer {
  private proc?: ChildProcess;
  private out = "";
  constructor(readonly cfg: ServeConfig) {}

  /** Null once `url` answers; else why not (with the server's last output), which fails the round. */
  async ensure(): Promise<string | null> {
    if (await answers(this.cfg.url)) return null;
    if (!this.cfg.command) return `nothing answers at ${this.cfg.url}, and config "serve" has no command to start the app`;
    if (!this.proc || this.proc.exitCode !== null) this.start();
    const limit = Date.now() + (this.cfg.timeout ?? 120) * 1000;
    while (Date.now() < limit) {
      if (await answers(this.cfg.url)) return null;
      if (this.proc!.exitCode !== null) return `the dev server (\`${this.cfg.command}\`) exited with code ${this.proc!.exitCode}:\n${this.tail()}`;
      await sleep(500);
    }
    return `the dev server (\`${this.cfg.command}\`) did not answer at ${this.cfg.url} within ${this.cfg.timeout ?? 120}s:\n${this.tail()}`;
  }

  /** After dependencies changed (config "setup" ran): a dev server does not pick up new packages by itself. */
  async restart(): Promise<string | null> {
    if (!this.proc) return this.ensure();
    this.stop();
    for (let i = 0; i < 20 && (await answers(this.cfg.url)); i++) await sleep(250);
    return this.ensure();
  }

  stop() {
    if (this.proc) killProcessTree(this.proc);
    this.proc = undefined;
  }

  private start() {
    console.log(`starting the dev server: ${this.cfg.command}`);
    this.out = "";
    // The user's own command from the repo's config, like the checks: through the shell.
    const p = spawn(this.cfg.command!, {
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
    });
    const keep = (d: Buffer) => (this.out = (this.out + d.toString()).slice(-8000));
    p.stdout?.on("data", keep);
    p.stderr?.on("data", keep);
    p.on("error", (e) => keep(Buffer.from(`\n${msg(e)}`)));
    this.proc = p;
  }

  private tail() {
    return this.out.trim().slice(-1500) || "(no output)";
  }
}

// ---------- Chrome DevTools Protocol ----------
type CdpMessage = { id?: number; method?: string; params?: Record<string, any>; result?: any; error?: { message: string }; sessionId?: string };

class Cdp {
  private seq = 0;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
  private handlers = new Set<(m: CdpMessage) => void>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as CdpMessage;
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.error) p.fail(new Error(m.error.message));
        else p.ok(m.result);
      } else for (const h of this.handlers) h(m);
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.fail(new Error("the browser closed the connection"));
      }
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => ok(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => fail(new Error(`cannot connect to the browser at ${url}`)), { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { ok, fail, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(fn: (m: CdpMessage) => void) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

type Browser = { cdp: Cdp; close: () => Promise<void> };

/** Start the browser headless on this repo's profile and connect to it. */
async function launch(exe: string, profile: string): Promise<Browser> {
  mkdirSync(profile, { recursive: true });
  const portFile = join(profile, "DevToolsActivePort");
  rmSync(portFile, { force: true });
  const proc = spawn(
    exe,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      "--disable-background-timer-throttling",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" },
  );
  let exited: number | null = null;
  proc.on("exit", (code) => (exited = code ?? -1));
  proc.on("error", () => (exited = -1));
  let ws = "";
  for (let i = 0; i < 100 && !ws; i++) {
    if (exited !== null)
      throw new Error(`the browser exited at once (code ${exited}); if "orch browser login" is still open for this repo, close that window first`);
    try {
      const [port, path] = readFileSync(portFile, "utf8").split(/\r?\n/);
      if (port && path) ws = `ws://127.0.0.1:${port}${path}`;
    } catch {
      /* not written yet */
    }
    if (!ws) await sleep(200);
  }
  if (!ws) {
    killProcessTree(proc);
    throw new Error(`the browser did not open its DevTools port within 20s (${exe})`);
  }
  const cdp = await Cdp.connect(ws);
  return {
    cdp,
    close: async () => {
      await cdp.send("Browser.close", {}, undefined, 5000).catch(() => undefined);
      cdp.close();
      for (let i = 0; i < 25 && exited === null; i++) await sleep(200);
      if (exited === null) killProcessTree(proc);
    },
  };
}

/** Injected into every page before its scripts: cumulative layout shift, as web-vitals counts it (without the session windows). */
const CLS_SCRIPT = `(() => { window.__orchCls = 0; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__orchCls += e.value; }).observe({ type: "layout-shift", buffered: true }); } catch {} })();`;

/** Measured in the page after load and actions. */
const PROBE = (selector: string | undefined, viewport: number, viewportHeight: number) => `(() => {
  const sel = ${JSON.stringify(selector ?? null)};
  const el = sel ? document.querySelector(sel) : null;
  const r = el ? el.getBoundingClientRect() : null;
  const w = ${viewport}; // mobile emulation widens innerWidth to the content, so measure against the width asked for
  const desc = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className.trim() ? "." + e.className.trim().split(/\\s+/).slice(0, 2).join(".") : "");
  const over = [];
  if (document.documentElement.scrollWidth > w + 1) {
    for (const e of document.body ? document.body.querySelectorAll("*") : []) {
      const b = e.getBoundingClientRect();
      if (b.width && b.right > w + 1 && !(e.parentElement && e.parentElement.getBoundingClientRect().right > w + 1)) over.push(desc(e) + " (right edge " + Math.round(b.right) + "px)");
      if (over.length >= 5) break;
    }
  }
  const text = document.body ? document.body.innerText.trim() : "";
  const media = document.querySelector("img, svg, canvas, video");
  const overlay = document.querySelector("vite-error-overlay, nextjs-portal, #webpack-dev-server-client-overlay, #react-refresh-overlay");
  return {
    href: location.href,
    title: document.title,
    blank: !text && !media,
    overlay: overlay ? (overlay.shadowRoot ? overlay.shadowRoot.textContent : overlay.textContent || "").trim().slice(0, 600) || overlay.tagName.toLowerCase() : null,
    scrollWidth: document.documentElement.scrollWidth,
    // The content's bottom, at least one screen: under mobile emulation scrollHeight follows the zoomed-out layout.
    height: Math.max(${viewportHeight}, Math.ceil(document.body ? document.body.getBoundingClientRect().bottom + scrollY + 16 : 0)),
    width: w,
    overflow: over,
    cls: Math.round((window.__orchCls || 0) * 1000) / 1000,
    rect: r && r.width > 0 && r.height > 0 ? { x: Math.max(0, r.left + scrollX - 8), y: Math.max(0, r.top + scrollY - 8), width: r.width + 16, height: r.height + 16 } : null,
  };
})()`;

type Probe = {
  href: string;
  title: string;
  blank: boolean;
  overlay: string | null;
  scrollWidth: number;
  height: number;
  width: number;
  overflow: string[];
  cls: number;
  rect: { x: number; y: number; width: number; height: number } | null;
};

/** Every page of the plan, at every width and theme it asks for. Never throws: a browser that cannot start is a problem. */
export async function captureVisual(o: {
  exe: string;
  profile: string;
  base: string;
  targets: VisualTarget[];
  outDir: string;
  relDir: string;
}): Promise<VisualResult> {
  const start = Date.now();
  const res: VisualResult = { url: o.base, shots: [], problems: [], observations: [], ms: 0 };
  const origin = new URL(o.base).origin;
  rmSync(o.outDir, { recursive: true, force: true });
  mkdirSync(o.outDir, { recursive: true });
  let browser: Browser;
  try {
    browser = await launch(o.exe, o.profile);
  } catch (e) {
    res.problems.push(`could not start the browser: ${msg(e)}`);
    res.ms = Date.now() - start;
    return res;
  }
  try {
    for (const [i, t] of o.targets.entries()) await captureTarget(browser.cdp, i, t, origin, o, res);
  } finally {
    await browser.close();
  }
  res.ms = Date.now() - start;
  return res;
}

async function captureTarget(cdp: Cdp, i: number, t: VisualTarget, origin: string, o: { base: string; outDir: string; relDir: string }, res: VisualResult) {
  const url = new URL(t.path, o.base).href;
  const { targetId } = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const send = <T = any>(m: string, p: Record<string, unknown> = {}, ms?: number) => cdp.send<T>(m, p, sessionId, ms);
  const pageErrors = new Set<string>();
  const consoleErrors = new Set<string>();
  const failed = new Set<string>();
  const requests = new Map<string, string>();
  let docStatus: number;
  let loaded: (() => void) | null = null;
  const off = cdp.on((m) => {
    if (m.sessionId !== sessionId || !m.params) return;
    const p = m.params;
    switch (m.method) {
      case "Page.loadEventFired":
        loaded?.();
        break;
      case "Runtime.exceptionThrown":
        pageErrors.add(clip(p.exceptionDetails?.exception?.description?.split("\n")[0] ?? p.exceptionDetails?.text ?? "uncaught error"));
        break;
      case "Runtime.consoleAPICalled":
        if (p.type === "error") consoleErrors.add(clip((p.args ?? []).map((a: any) => a.value ?? a.description ?? "").join(" ")));
        break;
      case "Log.entryAdded":
        // Failed loads are reported once, as failed requests.
        if (p.entry?.level === "error" && p.entry.source !== "network") consoleErrors.add(clip(`${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ""}`));
        break;
      case "Network.requestWillBeSent":
        requests.set(p.requestId, `${p.request?.method ?? "GET"} ${p.request?.url ?? ""}`);
        break;
      case "Network.responseReceived":
        if (p.type === "Document" && p.response?.url?.startsWith(origin)) docStatus = p.response.status;
        else if (p.response?.status >= 400 && !/\/favicon\.ico$/.test(p.response.url))
          failed.add(clip(`${p.response.status} ${requests.get(p.requestId) ?? p.response.url}`, 200));
        break;
      case "Network.loadingFailed":
        if (!p.canceled && !/\/favicon\.ico$/.test(requests.get(p.requestId) ?? "")) failed.add(clip(`${p.errorText} ${requests.get(p.requestId) ?? ""}`, 200));
        break;
    }
  });
  const where = (vw: number, theme: Theme) => `${t.path} at ${vw}px, ${theme}`;
  let maxCls = 0;
  const overflow = new Map<string, string[]>();
  try {
    await Promise.all(["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"].map((m) => send(m)));
    await send("Page.addScriptToEvaluateOnNewDocument", { source: CLS_SCRIPT });
    const evaluate = async <T>(expression: string): Promise<T> =>
      (await send<{ result: { value: T } }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
    const waitFor = async (selector: string, ms = SELECTOR_TIMEOUT_MS) => {
      const until = Date.now() + ms;
      do {
        if (await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`)) return true;
        await sleep(200);
      } while (Date.now() < until);
      return false;
    };
    combos: for (const theme of t.themes ?? ["light"])
      for (const vw of t.viewports ?? DEFAULT_VIEWPORTS) {
        const vh = vw < 768 ? 844 : 900;
        await send("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: 1, mobile: vw < 768 });
        await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        docStatus = 0;
        const load = new Promise<boolean>((ok) => {
          loaded = () => ok(true);
          setTimeout(() => ok(false), NAV_TIMEOUT_MS);
        });
        const nav = await send<{ errorText?: string }>("Page.navigate", { url }, NAV_TIMEOUT_MS).catch((e) => ({ errorText: msg(e) }));
        if (nav.errorText) {
          res.problems.push(`${t.path} did not load: ${nav.errorText}`);
          break combos;
        }
        if (!(await load)) res.observations.push(`${where(vw, theme)}: the load event did not fire within ${NAV_TIMEOUT_MS / 1000}s`);
        loaded = null;
        if (docStatus >= 400) {
          res.problems.push(`${t.path} answered HTTP ${docStatus}`);
          break combos;
        }
        let ok = true;
        if (t.selector && !(await waitFor(t.selector))) {
          res.problems.push(`${where(vw, theme)}: selector ${JSON.stringify(t.selector)} not found within ${SELECTOR_TIMEOUT_MS / 1000}s`);
          ok = false;
        }
        for (const a of ok ? (t.actions ?? []) : []) {
          if ("click" in a) {
            const clicked =
              (await waitFor(a.click)) &&
              (await evaluate<boolean>(
                `(() => { const e = document.querySelector(${JSON.stringify(a.click)}); if (!e) return false; e.scrollIntoView({ block: "center" }); e.click(); return true; })()`,
              ));
            if (!clicked) {
              res.problems.push(`${where(vw, theme)}: could not click ${JSON.stringify(a.click)} (not found)`);
              ok = false;
              break;
            }
            await sleep(300);
          } else if (typeof a.wait === "number") await sleep(a.wait);
          else if (!(await waitFor(a.wait))) {
            res.problems.push(`${where(vw, theme)}: ${JSON.stringify(a.wait)} did not appear within ${SELECTOR_TIMEOUT_MS / 1000}s`);
            ok = false;
            break;
          }
        }
        await sleep(400); // fonts, transitions and late layout
        const probe = await evaluate<Probe>(PROBE(ok ? t.selector : undefined, vw, vh));
        if (new URL(probe.href).origin !== origin) {
          res.problems.push(`${where(vw, theme)}: the page left the app (now at ${new URL(probe.href).origin}); no screenshot taken`);
          break combos;
        }
        if (probe.overlay) res.problems.push(`${where(vw, theme)}: the dev server shows a build error: ${clip(probe.overlay, 600)}`);
        else if (probe.blank) res.problems.push(`${where(vw, theme)}: the page is blank (no text, images or canvas)`);
        if (probe.overflow.length || probe.scrollWidth > probe.width + 1)
          overflow.set(`${vw}px ${theme}`, probe.overflow.length ? probe.overflow : [`page is ${probe.scrollWidth}px wide`]);
        maxCls = Math.max(maxCls, probe.cls);
        // The changed part when it has a size, else the whole page (capped, so a feed does not make a 50,000px image).
        const area = probe.rect ?? { x: 0, y: 0, width: vw, height: Math.max(1, probe.height) };
        const shot = await send<{ data: string }>(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: true, clip: { ...area, height: Math.min(area.height, MAX_SHOT_HEIGHT), scale: 1 } },
          60_000,
        );
        const name = shotName(i, t.path, vw, theme);
        writeFileSync(join(o.outDir, name), Buffer.from(shot.data, "base64"));
        res.shots.push({ target: i, path: t.path, viewport: vw, theme, file: `${o.relDir}/${name}` });
      }
  } catch (e) {
    res.problems.push(`${t.path}: the browser check broke off: ${msg(e)}`);
  } finally {
    off();
    await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined);
  }
  const list = (s: Set<string>) => [...s].slice(0, 8).join("; ") + (s.size > 8 ? ` (and ${s.size - 8} more)` : "");
  if (pageErrors.size) res.observations.push(`${t.path}: uncaught page errors: ${list(pageErrors)}`);
  if (consoleErrors.size) res.observations.push(`${t.path}: console errors: ${list(consoleErrors)}`);
  if (failed.size) res.observations.push(`${t.path}: failed requests: ${list(failed)}`);
  for (const [k, els] of overflow) res.observations.push(`${t.path} at ${k}: horizontal overflow: ${els.join(", ")}`);
  if (maxCls > 0.1) res.observations.push(`${t.path}: cumulative layout shift ${maxCls} (over 0.1)`);
}

// ---------- orch browser login / install ----------
/**
 * A visible window on this repo's profile, for logging in to the app once; the checks reuse the session. Without
 * the automation flag, so bot checks (Turnstile and the like) treat it as a normal browser. Waits until it closes.
 */
export async function browserLogin(exe: string, profile: string, url: string): Promise<number | null> {
  mkdirSync(profile, { recursive: true });
  const p = spawn(exe, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled", url], {
    stdio: "ignore",
  });
  return new Promise((ok, fail) => {
    p.on("error", fail);
    p.on("exit", (code) => ok(code));
  });
}

const CFT_INDEX = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

/** Where Chrome for Testing's executable is inside its zip, per platform. */
export function cftExecutable(platform: string): string {
  if (platform.startsWith("win")) return join(`chrome-${platform}`, "chrome.exe");
  if (platform.startsWith("mac")) return join(`chrome-${platform}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
  return join(`chrome-${platform}`, "chrome");
}

/** Download the current stable Chrome for Testing into ~/.yaaiorch/browser (only from Google's storage, over HTTPS). */
export async function installBrowser(log: (s: string) => void = console.log): Promise<string> {
  const platform = cftPlatform();
  if (!platform) throw new Error(`Chrome for Testing has no build for ${process.platform}/${process.arch}; install Chromium and set YAAIORCH_BROWSER`);
  const index = (await (await fetch(CFT_INDEX)).json()) as {
    channels?: { Stable?: { version: string; downloads?: { chrome?: { platform: string; url: string }[] } } };
  };
  const stable = index.channels?.Stable;
  const dl = stable?.downloads?.chrome?.find((d) => d.platform === platform);
  if (!stable || !dl) throw new Error(`no Chrome for Testing download for ${platform} in ${CFT_INDEX}`);
  const src = new URL(dl.url);
  if (src.protocol !== "https:" || src.hostname !== "storage.googleapis.com") throw new Error(`refusing a download from ${src.origin}`);
  const dir = join(INSTALL_DIR, stable.version);
  const exe = join(dir, cftExecutable(platform));
  if (!isFile(exe)) {
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, "chrome.zip");
    log(`downloading Chrome for Testing ${stable.version} (${platform}, about 150 MB) from ${src.origin}`);
    const r = await fetch(src);
    if (!r.ok || !r.body) throw new Error(`download failed: HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body as import("node:stream/web").ReadableStream), createWriteStream(zip));
    log("unpacking");
    // bsdtar reads zip files (Windows 10+, macOS); GNU tar does not, so Linux uses unzip.
    const x =
      process.platform === "linux"
        ? spawnSync("unzip", ["-q", "-o", zip, "-d", dir], { stdio: "inherit" })
        : spawnSync("tar", ["-xf", zip, "-C", dir], { stdio: "inherit", windowsHide: true });
    unlinkSync(zip);
    if (x.status !== 0 || !isFile(exe)) throw new Error(`could not unpack ${zip}${process.platform === "linux" ? " (is unzip installed?)" : ""}`);
  }
  writeFileSync(join(INSTALL_DIR, "current.json"), JSON.stringify({ version: stable.version, path: exe }, null, 2));
  return exe;
}
