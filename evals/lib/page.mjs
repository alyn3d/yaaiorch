// Browser grading for the web-* eval cases: start the repo's site, open pages in a headless Chrome/Edge/Chromium
// over the DevTools protocol (Node's built-in WebSocket) and evaluate expressions in them. Standalone on purpose:
// graders must not depend on the code under test (orch-browser.ts).
//
//   const site = await startSite(repoDir);           // node server.mjs <free port>
//   const b = await openBrowser();
//   const v = await b.evaluate(site.url + "/pricing", { width: 375, theme: "dark" }, "document.title");
//   await b.close(); site.stop();
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

export function findBrowser() {
  if (process.env.YAAIORCH_BROWSER) return process.env.YAAIORCH_BROWSER;
  const env = process.env;
  const candidates =
    process.platform === "win32"
      ? ["Google\\Chrome\\Application\\chrome.exe", "Microsoft\\Edge\\Application\\msedge.exe", "Chromium\\Application\\chrome.exe"].flatMap((r) =>
          [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean).map((root) => join(root, r)),
        )
      : process.platform === "darwin"
        ? ["Google Chrome", "Microsoft Edge", "Chromium"].map((a) => `/Applications/${a}.app/Contents/MacOS/${a}`)
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].flatMap((n) =>
            (env.PATH ?? "").split(delimiter).map((d) => join(d, n)),
          );
  const found = candidates.find(isFile);
  if (!found) throw new Error("no Chrome, Edge or Chromium found for browser grading; set YAAIORCH_BROWSER");
  return found;
}

const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

const kill = (p) => {
  if (!p.pid || p.exitCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill("SIGKILL");
  } catch {
    /* gone */
  }
};

/** `node server.mjs PORT` in the repo, waited for. */
export async function startSite(dir) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const p = spawn(process.execPath, ["server.mjs", String(port)], { cwd: dir, stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 100; i++) {
    if (p.exitCode !== null) throw new Error(`server.mjs exited with code ${p.exitCode}`);
    try {
      await fetch(url);
      return { url, stop: () => kill(p) };
    } catch {
      await sleep(100);
    }
  }
  kill(p);
  throw new Error(`server.mjs did not answer at ${url}`);
}

export async function openBrowser() {
  const profile = mkdtempSync(join(tmpdir(), "yaaiorch-grade-"));
  const proc = spawn(
    findBrowser(),
    [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "--headless=new", "--no-first-run", "--hide-scrollbars", "about:blank"],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  let ws = "";
  for (let i = 0; i < 100 && !ws; i++) {
    try {
      const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
      if (port && path) ws = `ws://127.0.0.1:${port}${path}`;
    } catch {
      await sleep(200);
    }
  }
  if (!ws) throw (kill(proc), new Error("the browser did not start"));
  const sock = new WebSocket(ws);
  await new Promise((ok, fail) => ((sock.onopen = ok), (sock.onerror = () => fail(new Error("cannot connect to the browser")))));
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  sock.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) {
      const { ok, fail } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) fail(new Error(m.error.message));
      else ok(m.result);
    } else for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((ok, fail) => {
      const id = ++seq;
      pending.set(id, { ok, fail });
      sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  return {
    /** Open `url` at this width and color scheme, wait for load, and return the value of `expression`. */
    async evaluate(url, { width = 1280, theme = "light" } = {}, expression) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      try {
        await send("Page.enable", {}, sessionId);
        await send("Emulation.setDeviceMetricsOverride", { width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1, mobile: width < 768 }, sessionId);
        await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] }, sessionId);
        const loaded = new Promise((ok) => {
          const l = (m) => m.sessionId === sessionId && m.method === "Page.loadEventFired" && (listeners.delete(l), ok());
          listeners.add(l);
          setTimeout(ok, 15_000);
        });
        await send("Page.navigate", { url }, sessionId);
        await loaded;
        await sleep(200);
        const r = await send("Runtime.evaluate", { expression: `(${HELPERS})(); ${expression}`, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      } finally {
        await send("Target.closeTarget", { targetId }).catch(() => {});
      }
    },
    async close() {
      await send("Browser.close").catch(() => {});
      sock.close();
      await sleep(500);
      kill(proc);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

/**
 * In-page helpers, defined on window before each expression:
 *   overflowX(width)  how far the document is wider than `width` (0 when it fits)
 *   rect(sel)         the element's box {left, top, right, bottom, width, height}, or null
 *   contrast(sel)     WCAG contrast of the element's text color against its effective background
 *   luminance(sel)    relative luminance of the element's effective background (0 black to 1 white)
 */
const HELPERS = `function () {
  const parse = (c) => { const m = c.match(/[\\d.]+/g) || []; return { r: +m[0] || 0, g: +m[1] || 0, b: +m[2] || 0, a: m[3] === undefined ? 1 : +m[3] }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const q = (sel) => { const e = document.querySelector(sel); if (!e) throw new Error("not found: " + sel); return e; };
  window.overflowX = (w) => Math.max(0, document.documentElement.scrollWidth - w);
  window.rect = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  window.rects = (sel) => [...document.querySelectorAll(sel)].map((e) => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, width: r.width }; });
  window.contrast = (sel) => { const e = q(sel); const a = lum(parse(getComputedStyle(e).color)); const b = lum(bgOf(e)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  window.luminance = (sel) => lum(bgOf(q(sel)));
  window.colorOf = (sel, prop) => getComputedStyle(q(sel))[prop];
}`;
