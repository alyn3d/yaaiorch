// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Local server for the YAAIORCH UI, for several repos at once (one session per repo).
 *   ORCH_REPO=<repo> or ORCH_REPOS=<repo>;<repo>…  repos to open at start (the list is also remembered)
 *   ORCH_PATH=<orch.ts> (default: ../orch.ts; an orch.mjs bundle runs without tsx)   PORT (4317; 0: any free port)
 *   MAX_PARALLEL (default 2)
 * Started by the desktop app (src-tauri) as its backend: YAAIORCH_APP=1 (print `@@READY@@ {"port":N,"token":"..."}` on
 * stdout, which only the app reads, once listening; /api/token is then closed), YAAIORCH_APP_ORIGINS (the app's webview
 * origins, allowed cross-origin), YAAIORCH_UI_SETTINGS (the settings file) and YAAIORCH_PARENT_PID (exit, stopping every
 * run, once that process is gone).
 * Each session spawns orch.ts in its repo and streams output over SSE, tagged with the repo. At most
 * `maxParallel` sessions run at once; further starts wait for a free slot. One run per repo at a time.
 */
import http from "node:http";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream, statSync, readdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, join, extname, dirname, delimiter, relative, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
// Every agent call reports its cost once: the plan (architect, critic), each task_end, diff reviews, learn, notes tidy,
// share; a repo group's coordinator in group_plan and group_fault. A group member's events arrive wrapped (unwrapGroupEvent).
import { COST_EVENTS } from "../orch-events";
import { Remote, cookieValue, deviceCookie, remoteRefusal, type Device } from "./remote";
import { Tunnel } from "./tunnel";

const here = dirname(fileURLToPath(import.meta.url));
const ORCH = resolve(process.env.ORCH_PATH ?? join(here, "..", "orch.ts"));
const PORT = Number(process.env.PORT ?? 4317);
/** How to start orch: the TypeScript source through tsx, or the bundled orch.mjs directly (the desktop app). */
const ORCH_CMD = ORCH.endsWith(".ts") ? [createRequire(import.meta.url).resolve("tsx/cli"), ORCH] : [ORCH];
const DIST = resolve(process.env.YAAIORCH_DIST || join(here, "dist"));
/** Remembered open repos and the parallel limit. */
const SETTINGS_FILE = process.env.YAAIORCH_UI_SETTINGS || join(homedir(), ".yaaiorch", "ui.json");

// ---------- request guard: only the UI served by this process may drive it ----------
// The server listens on 127.0.0.1, but any web page in the user's browser can still send requests to it.
// Three checks stop that: the Host header must name this machine (defeats DNS rebinding), a browser's
// Origin header must be a local page, and every /api call must carry this process's random token, which
// only a same-origin page can read (from /api/token).
const TOKEN = randomBytes(32).toString("hex");
// The desktop app reads the token from this process's stdout and hands it to its webview, whose origins are not local
// http(s) pages: tauri://localhost on macOS and Linux, http(s)://tauri.localhost on Windows. Only those get CORS headers.
const APP = process.env.YAAIORCH_APP === "1";
const APP_ORIGINS = new Set(
  (process.env.YAAIORCH_APP_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const localHost = (host: string | undefined) => {
  try {
    return !!host && LOCAL_HOSTS.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
};
const localOrigin = (origin: string | undefined) => {
  if (!origin) return true; // not sent by every request (same-origin GETs, curl); the token still applies
  if (APP_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && LOCAL_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};
const tokenOk = (given: unknown) => typeof given === "string" && given.length === TOKEN.length && timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
/** Why this request is refused, or null. */
function refuse(req: http.IncomingMessage, url: URL): string | null {
  if (!localHost(req.headers.host)) return "forbidden host";
  if (!localOrigin(req.headers.origin)) return "forbidden origin";
  if (!url.pathname.startsWith("/api/")) return null;
  // The app hands its token to its webview itself; nothing else may ask for it then.
  if (url.pathname === "/api/token") return APP ? "forbidden" : req.headers["sec-fetch-site"] === "cross-site" ? "forbidden" : null;
  return tokenOk(req.headers["x-orch-token"] ?? url.searchParams.get("token")) ? null : "missing or wrong session token; reload the page";
}
const MARK = "@@ORCH@@ ";
const MAX_LOG = 5000;

type Item = { id: number; goal: string; status: string; note?: string };
type Running = { pid: number; label: string; startedAt: number };
/** A repo group (`orch group list --json`); `dir` is its run dir, which keys its session. */
type GroupCfg = {
  name: string;
  dir: string;
  repos: { path: string; role: string; serve?: unknown; env?: unknown }[];
  contract?: string;
  integrationRounds?: number;
};
type Session = {
  /** A repo's folder, or a group's run dir. */
  repo: string;
  /** Set on a repo group's session: its config. Its process is `orch group run|rollback NAME`. */
  group?: GroupCfg;
  child: ChildProcess | null;
  running: Running | null;
  /** A start waiting for a free slot under maxParallel. */
  pending: { args: string[]; label: string } | null;
  log: string[];
  /** Structured events since the last goal_start. */
  events: unknown[];
};

const sessions = new Map<string, Session>();
const startQueue: string[] = []; // repo keys waiting for a slot, oldest first
let maxParallel = Math.max(1, Number(process.env.MAX_PARALLEL) || 2);
/** Open event streams; a remote one carries its device, so revoking the device can close it. */
const clients = new Map<http.ServerResponse, { device?: string }>();

// ---------- global state shared by all repos: the Claude usage limit and a daily budget ----------
/** Set when any repo hits the usage limit; new starts in every repo wait until `until`. */
let usageLimit: { repo: string; until: number } | null = null;
/** Daily budget in USD across all repos (null: none), and what agent calls cost today. */
let dailyBudget: number | null = null;
let spent = { day: today(), usd: 0 };
/** The subscription's usage windows: latest reading from any repo's agent calls, and the caps (percent, null: none). */
type Window = "fiveHour" | "week";
type Reading = { pct: number; resetsAt: number };
let usage: Partial<Record<Window, Reading>> = {};
let usageCap: Record<Window, number | null> = { fiveHour: null, week: null };
/** Keep the computer from sleeping while a run, loop, new project or group goal works (--keep-awake). On by default. */
let keepAwake = true;
const WINDOW_LABEL: Record<Window, string> = { fiveHour: "5-hour", week: "weekly" };
const WINDOW_CLI: Record<Window, string> = { fiveHour: "5h", week: "week" };

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const globalState = () => ({
  usageLimit,
  budget: { limit: dailyBudget, spent: Math.round(spent.usd * 10_000) / 10_000, day: spent.day },
  usage,
  usageCap,
  keepAwake,
});
/** The first window whose latest reading is at or over its cap and has not reset yet. */
function overCap(): (Reading & { window: Window }) | null {
  for (const window of ["fiveHour", "week"] as Window[]) {
    const u = usage[window],
      c = usageCap[window];
    if (u && c !== null && u.pct >= c && u.resetsAt > Date.now()) return { window, ...u };
  }
  return null;
}
/** Why new runs may not start right now, or null. */
function gate(): string | null {
  if (usageLimit && usageLimit.until > Date.now()) return `usage limit (resets ${new Date(usageLimit.until).toLocaleTimeString()})`;
  if (dailyBudget !== null && spent.usd >= dailyBudget) return `daily budget of $${dailyBudget} used up`;
  const o = overCap();
  if (o) return `${WINDOW_LABEL[o.window]} usage at ${o.pct}% (cap ${usageCap[o.window]}%, resets ${new Date(o.resetsAt).toLocaleString()})`;
  return null;
}
/** Remaining budget to pass on as --max-cost, or undefined when there is no budget. */
const budgetLeft = () => (dailyBudget === null ? undefined : Math.max(0.01, dailyBudget - spent.usd));

const readJson = <T>(p: string, fallback: T): T => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};
/** Windows paths are case-insensitive: one session per folder. */
const keyOf = (repo: string) => (process.platform === "win32" ? resolve(repo).toLowerCase() : resolve(repo));

function saveSettings() {
  try {
    mkdirSync(dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(
      SETTINGS_FILE,
      JSON.stringify(
        { repos: [...sessions.values()].filter((s) => !s.group).map((s) => s.repo), maxParallel, dailyBudget, spent, usageCap, keepAwake },
        null,
        2,
      ),
    );
  } catch {
    /* not fatal: the list just is not remembered */
  }
}

// Long polling for paired devices: Cloudflare's quick tunnels hold back a streamed response (the event stream gets its
// headers through, never its body), so a device asks GET /api/poll?since=N instead and gets every event after N in one
// complete response, at once or as soon as there is one (up to POLL_WAIT). Only `send` events go into the ring, never
// `sendLocal` ones. A device too far behind gets a fresh init.
type Polled = { seq: number; event: string; data: unknown };
const RING = 3000;
const POLL_WAIT = 25_000;
const ring: Polled[] = [];
let seq = 0;
const pollers = new Set<{ since: number; device?: string; done: (events: Polled[] | null) => void }>();

const send = (event: string, data: unknown) => {
  for (const c of clients.keys()) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  ring.push({ seq: ++seq, event, data });
  if (ring.length > RING) ring.splice(0, ring.length - RING);
  for (const p of pollers) p.done(ring.filter((e) => e.seq > p.since));
};
/** To the PC's own windows only (pairing requests, devices): never to a remote device. */
const sendLocal = (event: string, data: unknown) => {
  for (const [c, who] of clients) if (!who.device) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// ---------- remote access: a phone through a Cloudflare quick tunnel (remote.ts, tunnel.ts) ----------
/** On (the tunnel runs) while the PC has turned remote access on. Never remembered: every start begins with it off. */
let remoteEnabled = false;
let listenPort = 0;
const remote = new Remote(join(dirname(SETTINGS_FILE), "devices.json"));
// Devices paired before this start belong to a tunnel address that is gone: they pair again (their role is offered back).
remote.forget();
const remoteStatus = () => ({ enabled: remoteEnabled, tunnel: tunnel.state, requests: remote.requests(), devices: remote.list(), cleared: remote.cleared });
const tunnel = new Tunnel(
  join(homedir(), ".yaaiorch", "bin"),
  (state) => {
    // A new address (every start, every restart of cloudflared): the devices' cookies belong to the old one.
    if (state.status === "on" && state.url) remote.addressChanged(state.url);
    sendLocal("remote", remoteStatus());
  },
  (line) => console.log(`remote: ${line}`),
);
/** Close a revoked device's event streams at once. */
const dropDevice = (id: string) => {
  for (const [c, who] of clients) if (who.device === id) c.end();
  for (const p of pollers) if (p.device === id) p.done(null);
};
/**
 * A request that came through the tunnel: cloudflared forwards Cloudflare's headers (which no remote client can strip)
 * and the tunnel's host name. Such a request never gets the local guard's trust, whatever its Host says.
 */
const viaTunnel = (req: http.IncomingMessage) =>
  !!(req.headers["cf-connecting-ip"] || req.headers["cf-ray"]) || (!!tunnel.host && req.headers.host === tunnel.host);

/** The running (or waiting) group that has this repo as a member, if any. */
const busyGroupOf = (repo: string) =>
  [...sessions.values()].find((g) => g.group && (g.child || g.pending) && g.group.repos.some((r) => keyOf(r.path) === keyOf(repo)));
/** The open sessions of a group's member repos. */
const membersOf = (g: Session) => (g.group?.repos ?? []).map((r) => sessions.get(keyOf(r.path))).filter((m): m is Session => !!m);

function snapshot(s: Session) {
  const dir = join(s.repo, ".orchestrator");
  return {
    repo: s.repo,
    ...(s.group ? { group: s.group } : { inGroup: busyGroupOf(s.repo)?.group?.name }),
    running: s.running,
    queued: !!s.pending,
    /** Why a queued start waits: a free slot, the usage limit or the budget. */
    waitReason: s.pending ? (gate() ?? "free slot") : undefined,
    queue: readJson<Item[]>(join(dir, "queue.json"), []),
    lastRun: readJson<unknown>(join(dir, "last-run.json"), null),
  };
}
const initPayload = () => ({
  sessions: [...sessions.values()].map((s) => ({ state: snapshot(s), log: s.log, events: s.events })),
  maxParallel,
  global: globalState(),
});
/** A group's members show "in group" while it runs or waits: their state changes with the group's. */
const sendSession = (s: Session) => {
  send("session", snapshot(s));
  if (s.group) for (const m of membersOf(s)) send("session", snapshot(m));
};
const sendInit = () => send("init", initPayload());
const sendGlobal = () => {
  send("global", globalState());
  for (const s of sessions.values()) if (s.pending) sendSession(s); // their wait reason may have changed
};

/** A line from the orch process as parsed: loose, since an older or newer orch may send other fields (types: orch-events.ts). */
type OrchEvent = { type: string; [k: string]: unknown };
/**
 * `orch group run` wraps each member's own event in `group_child {repo, role, event}`: the member repo's path and that event,
 * unchanged. Any other event comes back as it is, without a repo.
 */
export function unwrapGroupEvent(ev: OrchEvent): { repo?: string; ev: OrchEvent } {
  const inner = ev.type === "group_child" ? (ev.event as OrchEvent | undefined) : undefined;
  if (!inner || typeof inner !== "object" || typeof inner.type !== "string") return { ev };
  return { repo: typeof ev.repo === "string" && ev.repo ? ev.repo : undefined, ev: inner };
}
function onEvent(s: Session, wrapped: OrchEvent) {
  // A group member's event whose repo has no session of its own: handled as the group session's.
  const ev = unwrapGroupEvent(wrapped).ev as { type: string; cost?: number; resetAt?: number; until?: number; reason?: string } & Partial<
    Record<Window, Reading>
  >;
  if (ev.type === "usage") {
    // The windows are per account, so the latest reading from any repo holds for all of them.
    const next: Partial<Record<Window, Reading>> = {};
    for (const w of ["fiveHour", "week"] as Window[]) if (ev[w] && typeof ev[w]!.pct === "number") next[w] = ev[w];
    usage = { ...usage, ...next };
    sendGlobal();
  }
  if (COST_EVENTS.has(ev.type) && typeof ev.cost === "number") addSpent(ev.cost);
  // The loop changed queue.json: send the queue again, so statuses and the brief's progress stay current.
  if (["queue_item", "queue_changed", "blocked", "coverage"].includes(ev.type)) sendSession(s);
  if (ev.type === "queue_item" && dailyBudget !== null && spent.usd >= dailyBudget && s.child?.pid) {
    // A queue loop is about to start its next goal with the day's budget used up: stop it now,
    // before the goal's first agent call. The goal stays pending for later.
    pushLine(s, `-- daily budget of $${dailyBudget} used up: stopping the queue before its next goal --`);
    killTree(s.child.pid);
  }
  // A run pausing at its own usage cap needs no extra hold: the reading over the cap already holds new starts.
  if (ev.type === "usage_limit" || (ev.type === "waiting" && ev.until && ev.reason !== "usage_cap")) {
    // The limit is per account: hold new starts in every repo until it resets.
    const until = (ev.type === "waiting" ? ev.until : ev.resetAt) ?? Date.now() + 30 * 60_000;
    if (!usageLimit || until > usageLimit.until) usageLimit = { repo: s.repo, until };
    pushLine(s, `-- usage limit: new runs in all repos wait until ${new Date(usageLimit.until).toLocaleString()} --`);
    sendGlobal();
  }
}

function pushLine(s: Session, line: string) {
  if (line.startsWith(MARK)) {
    try {
      const ev = JSON.parse(line.slice(MARK.length));
      if (ev && typeof ev === "object" && typeof ev.type === "string") return pushEvent(s, ev);
    } catch {
      /* fall through to plain log */
    }
  }
  s.log.push(line);
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
  send("log", { repo: s.repo, line });
}

/**
 * One structured event from `s`'s process. A group member's wrapped event goes to the session of that member's repo
 * as if its own process had printed it; without such a session, or while that session has its own run (live or waiting
 * to start), it stays with `s` (the group's), still wrapped, so it never mixes into that run.
 */
function pushEvent(s: Session, ev: OrchEvent) {
  const { repo, ev: inner } = unwrapGroupEvent(ev);
  const member = repo === undefined ? undefined : sessions.get(keyOf(repo));
  if (member && member !== s && !member.child && !member.pending) return pushEvent(member, inner);
  if (ev.type === "goal_start" || ev.type === "group_start") s.events = [];
  s.events.push(ev);
  send("ev", { repo: s.repo, ev });
  onEvent(s, ev);
}

function addRepo(path: string): Session {
  const repo = resolve(path);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`not a folder: ${path}`);
  const key = keyOf(repo);
  let s = sessions.get(key);
  if (!s) {
    s = { repo, child: null, running: null, pending: null, log: [], events: [] };
    sessions.set(key, s);
  }
  return s;
}

function mustGet(repo: unknown): Session {
  const s = typeof repo === "string" ? sessions.get(keyOf(repo)) : undefined;
  if (!s) throw new Error(`unknown repo: ${String(repo)}`);
  return s;
}

const runningCount = () => [...sessions.values()].filter((s) => s.child).length;

/** Start now if a slot is free and nothing holds new runs, else queue the start. One run per repo. */
function requestStart(s: Session, args: string[], label: string) {
  if (s.child || s.pending) throw new Error(`this ${s.group ? "group" : "repo"} already has a run (or one waiting to start)`);
  const inGroup = s.group ? undefined : busyGroupOf(s.repo);
  if (inGroup) throw new Error(`this repo is busy in group "${inGroup.group!.name}"; stop the group first`);
  const busy = s.group ? membersOf(s).find((m) => m.child || m.pending) : undefined;
  if (busy) throw new Error(`${busy.repo} has a run of its own (or one waiting to start); stop it first`);
  const held = gate();
  if (!held && runningCount() < maxParallel) return startNow(s, args, label);
  s.pending = { args, label };
  startQueue.push(keyOf(s.repo));
  pushLine(s, `-- waiting: ${held ?? `free slot (${maxParallel} repo(s) may run at once)`} --`);
  sendSession(s);
}

function startNext() {
  while (startQueue.length && runningCount() < maxParallel && !gate()) {
    const s = sessions.get(startQueue.shift()!);
    if (!s?.pending) continue;
    const { args, label } = s.pending;
    s.pending = null;
    startNow(s, args, label);
  }
}

/**
 * Run and loop get the global limits: --usage-cap from the caps, and with a daily budget a --max-cost of
 * at most what is left today (their own --max-cost, if lower).
 */
function withBudget(args: string[]): string[] {
  if (args[0] === "group" && args[1] === "run") {
    // `orch group run` takes no usage caps (the holds still stop new starts); it gets the day's budget left as --max-cost,
    // before its goal, which comes last.
    const left = budgetLeft();
    if (left === undefined) return args;
    const i = args.indexOf("--max-cost");
    const own = i >= 0 ? Number(args[i + 1]) : Infinity;
    const rest = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
    return [...rest.slice(0, -1), "--max-cost", Math.min(own, left).toFixed(2), rest.at(-1)!];
  }
  if (!["run", "loop", "learn", "share", "split", "new"].includes(args[0])) return args;
  const caps = (["fiveHour", "week"] as Window[]).filter((w) => usageCap[w] !== null).map((w) => `${WINDOW_CLI[w]}=${usageCap[w]}`);
  if (caps.length && !args.includes("--usage-cap")) args = [...args, "--usage-cap", caps.join(",")];
  const left = budgetLeft();
  if (left === undefined) return args;
  // A loop (or a new project that starts building) gets what is left today as its budget for all goals together,
  // so the goal it runs out in stays pending instead of failing; a single call or goal gets it as its own cap.
  const key = args[0] === "loop" || (args[0] === "new" && args.includes("--start")) ? "--max-cost-total" : "--max-cost";
  const i = args.indexOf(key);
  const own = i >= 0 ? Number(args[i + 1]) : Infinity;
  const rest = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
  return [...rest, key, Math.min(own, left).toFixed(2)];
}

/**
 * The commands that work for a long time keep the computer awake (`--keep-awake`) while the switch is on. The flag goes
 * right after the command words (`group run --keep-awake ...`), so whatever reads them stays as it was.
 */
export function withAwake(args: string[], on: boolean): string[] {
  if (!on || args.includes("--keep-awake")) return args;
  const long = ["run", "loop"].includes(args[0]) || (args[0] === "new" && args.includes("--start")) || (args[0] === "group" && args[1] === "run");
  const at = args[0] === "group" ? 2 : 1;
  return long ? [...args.slice(0, at), "--keep-awake", ...args.slice(at)] : args;
}

function startNow(s: Session, rawArgs: string[], label: string) {
  const args = withAwake(withBudget(rawArgs), keepAwake);
  const p = spawn(process.execPath, [...ORCH_CMD, ...args], {
    cwd: s.repo,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "0", ORCH_EVENTS: "1" },
  });
  s.child = p;
  s.running = { pid: p.pid!, label, startedAt: Date.now() };
  pushLine(s, `$ orch ${args.join(" ")}`);
  // Chunks do not end on line boundaries: keep the partial last line until the rest arrives.
  for (const stream of [p.stdout!, p.stderr!]) {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      lines.filter(Boolean).forEach((l) => pushLine(s, l));
    });
    stream.on("end", () => rest && pushLine(s, rest));
  }
  p.on("close", (code) => {
    pushLine(s, `-- exited (${code}) --`);
    s.child = null;
    s.running = null;
    sendSession(s);
    startNext();
  });
  sendSession(s);
}

function killTree(pid: number) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGTERM");
  } catch {
    /* already gone */
  }
}

function stop(s: Session) {
  if (s.pending) {
    s.pending = null;
    pushLine(s, "-- start cancelled --");
    sendSession(s);
  }
  if (!s.child?.pid) return;
  if (s.group && s.running?.label.startsWith("group:")) {
    // The group parks both repos when asked through `orch group stop`; killing its tree would leave them unparked.
    // Only when the ask fails (it has not taken its locks yet, or orch cannot start) is the tree killed.
    const pid = s.child.pid;
    pushLine(s, "-- stopping: the group parks both repos' work --");
    execFile(process.execPath, [...ORCH_CMD, "group", "stop", s.group.name], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err) => {
      if (err && s.child?.pid === pid) killTree(pid);
    });
    return;
  }
  killTree(s.child.pid);
}

/** `orch group list --json`: one session per group (keyed by its run dir), added, updated or (when idle) dropped. */
async function syncGroups() {
  const out = await orchOutput(homedir(), ["group", "list", "--json"]);
  const list = JSON.parse(out.trim().split(/\r?\n/).pop() || "[]") as GroupCfg[];
  const seen = new Set<string>();
  for (const g of list) {
    if (typeof g?.dir !== "string" || !g.name) continue;
    mkdirSync(g.dir, { recursive: true });
    const key = keyOf(g.dir);
    seen.add(key);
    const s = sessions.get(key);
    if (s) s.group = g;
    else sessions.set(key, { repo: resolve(g.dir), group: g, child: null, running: null, pending: null, log: [], events: [] });
  }
  for (const [key, s] of sessions) if (s.group && !seen.has(key) && !s.child && !s.pending) sessions.delete(key);
  sendInit();
}

const GROUP_NAME = /^[a-z0-9-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
/** `orch group add` from the group form: a name, two absolute folders, the backend's serve, the frontend's env (NAME: value). */
export function groupAddArgs(b: Record<string, unknown>): string[] {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const name = str(b.name);
  if (!GROUP_NAME.test(name)) throw new Error("group name: lowercase letters, digits and dashes");
  const be = str(b.backend),
    fe = str(b.frontend);
  if (!isAbsolute(be) || !isAbsolute(fe)) throw new Error("the backend and frontend folders must be absolute paths");
  const args = ["group", "add", name, "--repo", `${resolve(be)}:backend`, "--repo", `${resolve(fe)}:frontend`];
  if (str(b.serveUrl)) args.push("--serve-url", str(b.serveUrl));
  if (str(b.serveCommand)) args.push("--serve-command", str(b.serveCommand).slice(0, 500));
  if (str(b.baseUrl)) args.push("--base-url", str(b.baseUrl));
  const env = b.env && typeof b.env === "object" && !Array.isArray(b.env) ? (b.env as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k) || typeof v !== "string") throw new Error(`env ${k}: a NAME in capitals and a text value`);
    args.push("--env", `${k}=${v}`);
  }
  return args;
}

/** `orch group run NAME <goal>` with the options a group run takes; the goal comes last. */
export function groupRunArgs(name: string, b: Record<string, unknown>): string[] {
  return [
    "group",
    "run",
    name,
    "--power",
    typeof b.power === "string" && /^[a-z]+$/.test(b.power) ? b.power : "heavy",
    "--max-rounds",
    String(Math.min(20, Math.max(1, Math.round(Number(b.maxRounds)) || 5))),
    ...(typeof b.maxCost === "number" && b.maxCost > 0 ? ["--max-cost", String(b.maxCost)] : []),
    ...(typeof b.models === "string" && MODEL_SPEC.test(b.models) ? ["--model", b.models] : []),
    ...(b.approvePlan ? ["--approve-plan"] : []),
    ...(b.fast === true ? ["--fast"] : b.fast === false ? ["--no-fast"] : []),
    ...(b.onLimit === "wait" || b.onLimit === "stop" ? ["--on-limit", b.onLimit] : []),
    ...(b.pr === true ? ["--pr"] : b.branch === true ? ["--branch"] : []),
    String(b.goal).trim(),
  ];
}

/** Model spec ("architect=opus,be=sonnet"): only key=value pairs of safe characters reach orch. */
const MODEL_SPEC = /^[\w-]+=[\w.:[\]-]+(,[\w-]+=[\w.:[\]-]+)*$/;

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
type PluginOpts = { off?: boolean; disable?: unknown; hooks?: boolean };
/** --plugins off, --disable-plugins a,b, --no-hooks; ids that are not plain plugin ids are dropped. */
const pluginFlags = (p?: PluginOpts) => {
  if (!p || typeof p !== "object") return [];
  const ids = Array.isArray(p.disable) ? p.disable.filter((x): x is string => typeof x === "string" && PLUGIN_ID.test(x)) : [];
  return [...(p.off ? ["--plugins", "off"] : []), ...(ids.length ? ["--disable-plugins", ids.join(",")] : []), ...(p.hooks === false ? ["--no-hooks"] : [])];
};
/** A GitHub label name with safe characters only (orch checks it again). */
const LABEL = /^[\w .:/-]{1,50}$/;
/** Agent names, comma-separated (orch checks them against the agents it finds). */
const REVIEWERS = /^[A-Za-z0-9][A-Za-z0-9._:-]*(,[A-Za-z0-9][A-Za-z0-9._:-]*)*$/;
const flags = (b: {
  power?: string;
  maxRounds?: number;
  dryRun?: boolean;
  maxCost?: number;
  /** A loop's budget for all its goals together (--max-cost-total). */
  maxCostTotal?: number;
  models?: string;
  onLimit?: string;
  fast?: boolean;
  critic?: boolean;
  diffCritic?: boolean;
  review?: boolean;
  reviewers?: string;
  branch?: boolean;
  worktrees?: boolean;
  pr?: boolean;
  approvePlan?: boolean;
  ask?: boolean;
  /** Agent M: implementers may run shell commands a human approves (--commands). */
  commands?: boolean;
  /** A GitHub label: loops pull new issues with it in (--intake github:LABEL). */
  intakeLabel?: string;
  plugins?: PluginOpts;
}) => [
  "--power",
  b.power ?? "heavy",
  "--max-rounds",
  String(b.maxRounds ?? 5),
  ...(b.dryRun ? ["--dry-run"] : []),
  ...(typeof b.maxCost === "number" && b.maxCost > 0 ? ["--max-cost", String(b.maxCost)] : []),
  ...(typeof b.maxCostTotal === "number" && b.maxCostTotal > 0 ? ["--max-cost-total", String(b.maxCostTotal)] : []),
  ...(typeof b.models === "string" && MODEL_SPEC.test(b.models) ? ["--model", b.models] : []),
  ...(b.onLimit === "wait" || b.onLimit === "stop" ? ["--on-limit", b.onLimit] : []),
  ...(b.fast === true ? ["--fast"] : b.fast === false ? ["--no-fast"] : []),
  ...(b.critic ? ["--critic"] : []),
  ...(b.diffCritic ? ["--diff-critic"] : []),
  ...(b.review ? ["--review"] : []),
  ...(b.review && typeof b.reviewers === "string" && REVIEWERS.test(b.reviewers) ? ["--reviewers", b.reviewers] : []),
  ...(b.branch ? ["--branch"] : []),
  ...(b.worktrees === true ? ["--worktrees"] : b.worktrees === false ? ["--no-worktrees"] : []),
  ...(b.pr ? ["--pr"] : []),
  ...(b.approvePlan ? ["--approve-plan"] : []),
  ...(b.ask === true ? ["--ask"] : b.ask === false ? ["--no-ask"] : []),
  ...(b.commands === true ? ["--commands"] : b.commands === false ? ["--no-commands"] : []),
  ...(typeof b.intakeLabel === "string" && LABEL.test(b.intakeLabel) ? ["--intake", `github:${b.intakeLabel}`] : []),
  ...pluginFlags(b.plugins),
];

/** `orch plugins --json --details` in a repo (slow: one CLI call per plugin), cached for 10 minutes. */
const pluginCache = new Map<string, { at: number; list: Promise<unknown> }>();
const plugins = (s: Session, fresh: boolean) => {
  const key = keyOf(s.repo);
  const hit = pluginCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 10 * 60_000) return hit.list;
  const list = new Promise<unknown>((ok, fail) =>
    execFile(
      process.execPath,
      [...ORCH_CMD, "plugins", "--json", "--details"],
      { cwd: s.repo, encoding: "utf8", windowsHide: true, timeout: 120_000 },
      (err, stdout, stderr) => {
        const line = stdout.split(/\r?\n/).find((l) => l.startsWith("["));
        try {
          ok(JSON.parse(line ?? ""));
        } catch {
          pluginCache.delete(key);
          fail(new Error((stderr || err?.message || "could not list plugins").trim().split(/\r?\n/).pop()));
        }
      },
    ),
  );
  pluginCache.set(key, { at: Date.now(), list });
  return list;
};

/** `orch doctor --json` in a repo, without blocking the event loop (SSE keeps flowing). `pr`: the UI opens pull requests. */
const doctor = (s: Session, pr = false) =>
  new Promise<unknown>((ok) =>
    execFile(
      process.execPath,
      [...ORCH_CMD, "doctor", "--json", ...(pr ? ["--pr"] : [])],
      { cwd: s.repo, encoding: "utf8", windowsHide: true },
      (_err, stdout) => {
        // exit 1 just means a "fail" finding; the JSON is still on stdout
        try {
          ok(JSON.parse(stdout));
        } catch {
          ok([{ name: "orchestrator", level: "fail", detail: "could not run orch doctor" }]);
        }
      },
    ),
  );

/** Through `orch add`, which edits the queue under its lock, so a running loop never loses the new goal. */
const addGoal = (s: Session, goal: string) =>
  new Promise<void>((ok, fail) =>
    execFile(process.execPath, [...ORCH_CMD, "add", goal], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
    ),
  );

/** `orch split --accept`: queue the (edited) goals of a split brief; brief and goals go on stdin. */
const acceptSplit = (s: Session, b: { brief?: unknown; goals?: unknown }) =>
  new Promise<void>((ok, fail) => {
    const child = execFile(process.execPath, [...ORCH_CMD, "split", "--accept"], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
    );
    child.stdin?.end(JSON.stringify({ brief: b.brief, goals: b.goals }));
  });

/** `orch approve` for a run waiting with --approve-plan: an edited plan goes on stdin, never on the command line. */
const approvePlan = (s: Session, b: { plan?: unknown; reject?: string }) =>
  new Promise<void>((ok, fail) => {
    const args = [
      ...(typeof b.reject === "string" ? ["--reject", b.reject.slice(0, 4000)] : b.plan ? ["--plan-stdin"] : []),
      ...(s.group ? ["--group", s.group.name] : []),
    ];
    const child = execFile(process.execPath, [...ORCH_CMD, "approve", ...args], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
    );
    child.stdin?.end(b.plan && typeof b.reject !== "string" ? JSON.stringify(b.plan) : "");
  });

const answerQuestion = (s: Session, id: string, answer: string) =>
  new Promise<void>((ok, fail) => {
    const child = execFile(process.execPath, [...ORCH_CMD, "answer", id], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
    );
    child.stdin?.end(answer);
  });

/** Agent M: allow, deny or always-allow a command an agent wants to run (`orch decide`, which checks the ID). */
const decideCommand = (s: Session, id: string, decision: string) =>
  new Promise<void>((ok, fail) =>
    execFile(process.execPath, [...ORCH_CMD, "decide", id, decision], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
    ),
  );

/** Run `orch <args>` in a repo without blocking the server (SSE keeps flowing for every repo); resolves with its stdout. */
const orchOutput = (repo: string, args: string[], input?: string) =>
  new Promise<string>((ok, fail) => {
    const child = execFile(
      process.execPath,
      [...ORCH_CMD, ...args],
      { cwd: repo, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, out, stderr) => (err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(out)),
    );
    child.stdin?.end(input ?? "");
  });

/** Count money spent today toward the daily budget. */
function addSpent(cost: number) {
  if (!(cost > 0)) return;
  if (spent.day !== today()) spent = { day: today(), usd: 0 };
  spent.usd += cost;
  saveSettings();
  sendGlobal();
}

/** Agent M chat: `orch chat` with the question and every open repo (it reads their status); its cost counts toward the daily budget. */
const askAgentM = (question: string, session?: string) =>
  new Promise<{ answer: string; session?: string; cost: number }>((ok, fail) => {
    const list = [...sessions.values()].filter((s) => !s.group);
    const input = JSON.stringify({ question, session, repos: list.map((s) => s.repo), running: list.filter((s) => s.child).map((s) => s.repo) });
    const child = execFile(
      process.execPath,
      [...ORCH_CMD, "chat"],
      { cwd: homedir(), encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
      (err, out, stderr) => {
        if (err) return fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message));
        try {
          const r = JSON.parse(out.trim().split(/\r?\n/).pop() ?? "");
          addSpent(Number(r.cost));
          ok(r);
        } catch {
          fail(new Error("Agent M returned no answer"));
        }
      },
    );
    child.stdin?.end(input);
  });

/** Agent M: gather the machine status in the background (`orch chat --warm`), one at a time, so the first question is quick. */
let warming = false;
const warmAgentM = () => {
  if (warming) return;
  warming = true;
  const child = execFile(process.execPath, [...ORCH_CMD, "chat", "--warm"], { cwd: homedir(), encoding: "utf8", windowsHide: true, timeout: 180_000 }, () => {
    warming = false;
  });
  child.stdin?.end(JSON.stringify({ repos: [...sessions.values()].filter((s) => !s.group).map((s) => s.repo) }));
};

/** Request bodies are small JSON (a brief at most): anything over 2 MB is refused, so nobody can fill the memory. */
const MAX_BODY = 2 * 1024 * 1024;
const body = (req: http.IncomingMessage) =>
  new Promise<any>((ok, bad) => {
    let s = "";
    req.on("data", (d) => {
      s += d;
      if (s.length > MAX_BODY) {
        bad(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch (e) {
        bad(e);
      }
    });
  });

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Open the remembered repos, then the ones from the environment.
const stored = readJson<{
  repos?: string[];
  maxParallel?: number;
  dailyBudget?: number | null;
  spent?: { day: string; usd: number };
  usageCap?: Partial<Record<Window, number | null>>;
  keepAwake?: boolean;
}>(SETTINGS_FILE, {});
if (stored.keepAwake === false) keepAwake = false;
if (!process.env.MAX_PARALLEL && stored.maxParallel) maxParallel = Math.max(1, stored.maxParallel);
if (typeof stored.dailyBudget === "number" && stored.dailyBudget > 0) dailyBudget = stored.dailyBudget;
if (stored.spent?.day === today() && typeof stored.spent.usd === "number") spent = stored.spent;
for (const w of ["fiveHour", "week"] as Window[]) {
  const c = stored.usageCap?.[w];
  if (typeof c === "number" && c > 0 && c <= 100) usageCap[w] = c;
}

// Lift holds when they expire: the usage-limit reset time, and a new day for the budget.
setInterval(() => {
  let changed = false;
  if (usageLimit && usageLimit.until <= Date.now()) {
    usageLimit = null;
    changed = true;
  }
  for (const w of ["fiveHour", "week"] as Window[]) {
    if (usage[w] && usage[w]!.resetsAt <= Date.now()) {
      delete usage[w]; // that window has reset; the next agent call brings a fresh reading
      changed = true;
    }
  }
  if (spent.day !== today()) {
    spent = { day: today(), usd: 0 };
    saveSettings();
    changed = true;
  }
  if (changed) {
    sendGlobal();
    startNext();
  }
}, 30_000).unref();
const fromEnv = [process.env.ORCH_REPO, ...(process.env.ORCH_REPOS ?? "").split(delimiter)].filter((r): r is string => !!r);
for (const r of [...(stored.repos ?? []), ...fromEnv]) {
  try {
    addRepo(r);
  } catch {
    /* a remembered repo that no longer exists is dropped */
  }
}
saveSettings();
syncGroups().catch((e) => console.error(`could not list repo groups: ${(e as Error).message}`));

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    // The desktop app's webview calls from its own origin: allow it (and only it) to read the answers. A preflight
    // carries no token; the real request still needs it.
    const origin = req.headers.origin;
    if (origin && APP_ORIGINS.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "origin");
      if (req.method === "OPTIONS" && localHost(req.headers.host)) {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type, x-orch-token",
          "access-control-max-age": "600",
        });
        return res.end();
      }
    }
    // Through the tunnel: pairing, or a paired device's cookie; never the local token or the local guard.
    let device: Device | null = null;
    let parsed: any = undefined;
    if (viaTunnel(req)) {
      const host = tunnel.host;
      if (!remoteEnabled || !host || req.headers.host !== host) return json(403, { error: "remote access is off" });
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
      // A browser's writes must come from the tunnel's own page (the cookie is SameSite=Strict as well).
      if (req.method !== "GET" && req.method !== "HEAD" && req.headers.origin !== `https://${host}`) return json(403, { error: "forbidden origin" });
      const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "?");
      try {
        if (url.pathname === "/api/pair" && req.method === "POST") {
          const b = await body(req);
          const r = remote.request(b.code, b.name, req.headers["user-agent"], ip);
          if ("error" in r) return json(r.error.startsWith("too many") ? 429 : 403, r);
          sendLocal("remote", remoteStatus());
          return json(200, r);
        }
        if (url.pathname === "/api/pair/status" && req.method === "POST") {
          const b = await body(req);
          const r = remote.status(b.id, b.poll);
          if (r.status === "allowed") {
            res.setHeader("set-cookie", deviceCookie(r.cookie));
            sendLocal("remote", remoteStatus());
            return json(200, { status: "allowed", device: r.device });
          }
          return json(200, r);
        }
        if (url.pathname.startsWith("/api/")) {
          device = remote.authenticate(req.headers.cookie);
          if (!device) return json(401, { error: "this device is not paired (or was removed); pair it again from the PC", pair: true });
          if (req.method === "POST") parsed = await body(req);
          const no = remoteRefusal(device.role, req.method ?? "GET", url.pathname, parsed?.decision);
          if (no) return json(403, { error: no });
          // Rolling: a device in use stays paired.
          res.setHeader("set-cookie", deviceCookie(cookieValue(req.headers.cookie)!));
        }
      } catch (e) {
        return json(400, { error: (e as Error).message });
      }
    } else {
      const refused = refuse(req, url);
      if (refused) return json(403, { error: refused });
    }
    try {
      if (url.pathname === "/api/token") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ token: TOKEN }));
      }
      if (url.pathname === "/api/events") {
        // no-transform: Cloudflare (the tunnel) would otherwise compress the stream and hold events back.
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
          connection: "keep-alive",
        });
        res.write(`event: init\ndata: ${JSON.stringify(initPayload())}\n\n`);
        clients.set(res, { device: device?.id });
        req.on("close", () => clients.delete(res));
        // Who this window is: the UI hides what a view-only device may not do.
        res.write(`event: client\ndata: ${JSON.stringify(device ? { remote: true, role: device.role, name: device.name } : { remote: false })}\n\n`);
        if (!device) res.write(`event: remote\ndata: ${JSON.stringify(remoteStatus())}\n\n`);
        return;
      }
      if (url.pathname === "/api/poll") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const who = device ? { remote: true, role: device.role, name: device.name } : { remote: false };
        const reply = (code: number, d: unknown) => {
          const b = JSON.stringify(d);
          res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(b), "cache-control": "no-store, no-transform" });
          res.end(b);
        };
        // First poll, or too far behind (the ring moved on, or the server restarted): the whole state again.
        const behind = !(since > 0) || since > seq || (ring.length > 0 ? since < ring[0].seq - 1 : since < seq);
        if (behind)
          return reply(200, {
            seq,
            events: [
              { seq, event: "client", data: who },
              { seq, event: "init", data: initPayload() },
            ],
          });
        const ready = ring.filter((e) => e.seq > since);
        if (ready.length) return reply(200, { seq, events: ready });
        const p = {
          since,
          device: device?.id,
          done: (events: Polled[] | null) => {
            pollers.delete(p);
            clearTimeout(timer);
            if (events === null) reply(401, { error: "this device was removed on the PC", pair: true });
            else reply(200, { seq, events });
          },
        };
        const timer = setTimeout(() => p.done([]), POLL_WAIT);
        pollers.add(p);
        req.on("close", () => {
          pollers.delete(p);
          clearTimeout(timer);
        });
        return;
      }
      if (url.pathname === "/api/state") return json(200, initPayload());
      if (url.pathname === "/api/doctor") return json(200, await doctor(mustGet(url.searchParams.get("repo")), url.searchParams.get("pr") === "1"));
      if (url.pathname === "/api/browser" && req.method === "GET") {
        const s = mustGet(url.searchParams.get("repo"));
        const result = await new Promise<string>((ok, fail) =>
          execFile(process.execPath, [...ORCH_CMD, "browser", "detect"], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) =>
            err ? fail(new Error((stderr || err.message).trim())) : ok(stdout),
          ),
        );
        return json(200, JSON.parse(result));
      }
      if (url.pathname === "/api/plugins") return json(200, await plugins(mustGet(url.searchParams.get("repo")), url.searchParams.has("fresh")));
      if (url.pathname === "/api/history" && req.method === "GET") {
        const s = mustGet(url.searchParams.get("repo"));
        const id = url.searchParams.get("id");
        const result = await new Promise<string>((ok, fail) =>
          execFile(
            process.execPath,
            [...ORCH_CMD, "history", "--json", ...(id === null ? [] : [id])],
            { cwd: s.repo, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
            (err, stdout, stderr) => (err ? fail(new Error((stderr || err.message).trim())) : ok(stdout)),
          ),
        );
        return json(200, JSON.parse(result));
      }
      if (url.pathname === "/api/visual" && req.method === "GET") {
        const s = mustGet(url.searchParams.get("repo"));
        const file = url.searchParams.get("file") ?? "";
        const parts = file.replaceAll("\\", "/").split("/");
        if (parts.length < 3 || parts[0] !== ".orchestrator" || parts[1] !== "visual" || parts.includes("..") || extname(file).toLowerCase() !== ".png") {
          return json(400, { error: "invalid screenshot path" });
        }
        const root = resolve(s.repo, ".orchestrator", "visual");
        const candidate = resolve(s.repo, file);
        if (!existsSync(root) || !existsSync(candidate)) return json(404, { error: "screenshot not found" });
        const pathWithinRoot = relative(root, candidate);
        if (!pathWithinRoot || pathWithinRoot.startsWith(`..${sep}`) || pathWithinRoot === ".." || isAbsolute(pathWithinRoot)) {
          return json(400, { error: "invalid screenshot path" });
        }
        const realRoot = realpathSync(root);
        const realFile = realpathSync(candidate);
        const realRelative = relative(realRoot, realFile);
        if (!realRelative || realRelative.startsWith(`..${sep}`) || realRelative === ".." || isAbsolute(realRelative) || !statSync(realFile).isFile()) {
          return json(400, { error: "invalid screenshot path" });
        }
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        createReadStream(realFile).pipe(res);
        return;
      }
      if (url.pathname === "/api/agents" && req.method === "GET") {
        const s = mustGet(url.searchParams.get("repo"));
        return json(200, JSON.parse(await orchOutput(s.repo, ["agents", "--json"])));
      }
      if (url.pathname === "/api/remote" && req.method === "GET") return json(200, remoteStatus());
      if (req.method === "POST") {
        const b = parsed ?? (await body(req));
        // Remote access, from the PC only (a device is refused before this by remoteRefusal).
        if (url.pathname === "/api/remote/enable") {
          remoteEnabled = b.on === true;
          saveSettings();
          if (remoteEnabled) void tunnel.start(listenPort);
          else tunnel.stop();
          sendLocal("remote", remoteStatus());
          return json(200, remoteStatus());
        }
        if (url.pathname === "/api/remote/pair-code") {
          if (tunnel.state.status !== "on" || !tunnel.state.url) return json(400, { error: "turn remote access on and wait for its address first" });
          // The code goes after #: browsers never send the fragment, so it stays out of logs and the address bar's history.
          return json(200, { url: `${tunnel.state.url}/pair#${remote.newCode()}`, expiresIn: 5 * 60 });
        }
        if (url.pathname === "/api/remote/decide") {
          if (!remote.decide(String(b.id), b.allow === true, b.role === "control" ? "control" : "view"))
            return json(400, { error: "no such pairing request (it may have expired)" });
          sendLocal("remote", remoteStatus());
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/remote/device") {
          const id = String(b.id);
          const ok = b.revoke === true ? remote.revoke(id) : remote.setRole(id, b.role);
          if (!ok) return json(400, { error: "no such device" });
          if (b.revoke === true) dropDevice(id);
          sendLocal("remote", remoteStatus());
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/agents") {
          const s = mustGet(typeof b.repo === "string" ? b.repo : null);
          if (typeof b.name !== "string" || typeof b.content !== "string") return json(400, { error: "agent name and content are required" });
          return json(200, JSON.parse(await orchOutput(s.repo, ["agents", "--save-agent", b.name], b.content)));
        }
        if (url.pathname === "/api/agents/swap") {
          const s = mustGet(typeof b.repo === "string" ? b.repo : null);
          if (typeof b.role !== "string") return json(400, { error: "built-in role is required" });
          if (b.target !== undefined && typeof b.target !== "string") return json(400, { error: "swap target must be an agent name" });
          const args = typeof b.target === "string" ? ["agents", "--swap", `${b.role}=${b.target}`] : ["agents", "--unswap", b.role];
          return json(200, JSON.parse(await orchOutput(s.repo, args)));
        }
        if (url.pathname === "/api/agents/toggle") {
          // Turn a skill or custom agent on or off in this repo (orch checks the name and refuses built-ins and swap targets).
          const s = mustGet(typeof b.repo === "string" ? b.repo : null);
          const flag = { skill: ["--disable-skill", "--enable-skill"], agent: ["--disable-agent", "--enable-agent"] }[b.kind as "skill" | "agent"];
          if (!flag || typeof b.name !== "string" || typeof b.enabled !== "boolean")
            return json(400, { error: "kind (skill or agent), name and enabled are required" });
          return json(200, JSON.parse(await orchOutput(s.repo, ["agents", flag[b.enabled ? 1 : 0], b.name])));
        }
        if (url.pathname === "/api/allow") {
          // The repo's always-allowed commands (config allow), optionally removing one first; orch writes the config.
          const s = mustGet(typeof b.repo === "string" ? b.repo : null);
          if (b.remove !== undefined && (typeof b.remove !== "string" || !b.remove)) return json(400, { error: "remove must be a rule" });
          return json(200, JSON.parse(await orchOutput(s.repo, ["allow", "--json", ...(b.remove ? ["--remove", b.remove] : [])])));
        }
        if (url.pathname === "/api/add-repo") {
          if (typeof b.path !== "string" || !b.path.trim()) return json(400, { error: "path required" });
          const s = addRepo(b.path.trim());
          saveSettings();
          sendInit();
          return json(200, { ok: true, repo: s.repo });
        }
        if (url.pathname === "/api/new-project") {
          // A new folder (parent + a plain name), opened as a repo tab, then `orch new` runs there like any run.
          const name = typeof b.name === "string" ? b.name.trim() : "";
          if (typeof b.parent !== "string" || !b.parent.trim()) return json(400, { error: "parent folder required" });
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return json(400, { error: "project name: letters, digits, dots, dashes and underscores" });
          if (typeof b.spec !== "string" || !b.spec.trim()) return json(400, { error: "spec required" });
          const parent = resolve(b.parent.trim());
          if (!existsSync(parent) || !statSync(parent).isDirectory()) return json(400, { error: `not a folder: ${parent}` });
          const dir = join(parent, name);
          if (existsSync(dir) && readdirSync(dir).length) return json(400, { error: `${dir} is not empty` });
          mkdirSync(dir, { recursive: true });
          const s = addRepo(dir);
          saveSettings();
          sendInit();
          const file = join(tmpdir(), `yaaiorch-brief-${process.pid}-${Date.now()}.md`);
          writeFileSync(file, b.spec);
          const setup = typeof b.setup === "string" && b.setup.trim() ? ["--setup", b.setup.trim().slice(0, 300)] : [];
          // orch checks the URL (never an option, no whitespace); any git host or a local path.
          const remote = typeof b.remote === "string" && b.remote.trim() ? ["--remote", b.remote.trim().slice(0, 500)] : [];
          requestStart(
            s,
            ["new", ".", "--brief-file", file, "--brief-file-temp", ...setup, ...remote, ...(b.start ? ["--start"] : []), ...flags({ ...b, dryRun: false })],
            "new project",
          );
          return json(200, { ok: true, repo: s.repo });
        }
        if (url.pathname === "/api/settings") {
          if ("maxParallel" in b) {
            const n = Number(b.maxParallel);
            if (!Number.isInteger(n) || n < 1 || n > 16) return json(400, { error: "maxParallel must be 1 to 16" });
            maxParallel = n;
          }
          if ("dailyBudget" in b) {
            const v = b.dailyBudget === null || b.dailyBudget === "" ? null : Number(b.dailyBudget);
            if (v !== null && !(v > 0)) return json(400, { error: "dailyBudget must be a positive amount, or empty for none" });
            dailyBudget = v;
          }
          if ("usageCap" in b) {
            const next = { ...usageCap };
            for (const w of ["fiveHour", "week"] as Window[]) {
              if (!b.usageCap || !(w in b.usageCap)) continue;
              const raw = b.usageCap[w];
              const v = raw === null || raw === "" ? null : Number(raw);
              if (v !== null && !(v > 0 && v <= 100)) return json(400, { error: `usageCap.${w} must be a percentage from 1 to 100, or empty for none` });
              next[w] = v;
            }
            usageCap = next;
          }
          if ("keepAwake" in b) {
            if (typeof b.keepAwake !== "boolean") return json(400, { error: "keepAwake must be true or false" });
            keepAwake = b.keepAwake;
          }
          saveSettings();
          sendInit();
          startNext();
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/agent-m/warm") {
          warmAgentM();
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/agent-m/ask") {
          if (typeof b.question !== "string" || !b.question.trim() || b.question.length > 4000)
            return json(400, { error: "question required (up to 4000 characters)" });
          if (b.session !== undefined && (typeof b.session !== "string" || !/^[\w-]{1,100}$/.test(b.session))) return json(400, { error: "invalid session" });
          return json(200, await askAgentM(b.question, b.session));
        }
        if (url.pathname === "/api/group-save") {
          await orchOutput(homedir(), groupAddArgs(b));
          await syncGroups();
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/group-remove") {
          const g = [...sessions.values()].find((s) => s.group && s.group.name === b.name);
          if (!g) return json(400, { error: `unknown group: ${String(b.name)}` });
          if (g.child || g.pending) return json(409, { error: "stop this group's run before removing it" });
          await orchOutput(homedir(), ["group", "remove", g.group!.name]);
          sessions.delete(keyOf(g.repo));
          await syncGroups();
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/clear-limit") {
          // "Try now": lift the usage-limit hold early, and forget readings over a cap; a run that hits
          // the limit (or reads usage over a cap) again sets it again.
          usageLimit = null;
          usage = {};
          sendGlobal();
          startNext();
          return json(200, { ok: true });
        }
        const s = mustGet(b.repo);
        if (s.group && !["/api/run", "/api/approve", "/api/rollback", "/api/stop", "/api/clear-log", "/api/reveal"].includes(url.pathname))
          return json(400, { error: "not available for a repo group" });
        if (url.pathname === "/api/browser") {
          if (s.child || s.pending) return json(409, { error: "wait until this repo is idle" });
          if (b.action === "login") {
            requestStart(s, ["browser", "login"], "browser login");
            return json(200, { ok: true });
          }
          if (b.action !== "enable" && b.action !== "disable") return json(400, { error: "invalid browser action" });
          if (b.action === "enable" && (typeof b.id !== "string" || !/^(?:[a-f0-9]{64}|manual)$/.test(b.id)))
            return json(400, { error: "invalid app selection" });
          await new Promise<void>((ok, fail) =>
            execFile(
              process.execPath,
              [...ORCH_CMD, "browser", b.action, ...(b.action === "enable" ? [b.id] : [])],
              { cwd: s.repo, encoding: "utf8", windowsHide: true },
              (err, _stdout, stderr) => (err ? fail(new Error((stderr || err.message).trim())) : ok()),
            ),
          );
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/remove-repo") {
          if (s.child || s.pending) return json(409, { error: "stop this repo's run before closing it" });
          if (busyGroupOf(s.repo)) return json(409, { error: "this repo is busy in a group run; stop the group first" });
          sessions.delete(keyOf(s.repo));
          saveSettings();
          sendInit();
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/reveal") {
          // The repo's folder in the system file manager. Only an open repo's path, passed as an argument (no shell).
          const [cmd, args] =
            process.platform === "win32"
              ? [join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"), [s.repo]]
              : process.platform === "darwin"
                ? ["open", [s.repo]]
                : ["xdg-open", [s.repo]];
          const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
          child.on("error", () => {}); // explorer.exe exits 1 even when it worked; a missing xdg-open has nothing to report to
          child.unref();
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/run" && s.group) {
          if (typeof b.goal !== "string" || !b.goal.trim()) return json(400, { error: "goal required" });
          // The members open as tabs first, so their own events show there.
          const before = sessions.size;
          for (const r of s.group.repos) addRepo(r.path);
          if (sessions.size !== before) {
            saveSettings();
            sendInit();
          }
          requestStart(s, groupRunArgs(s.group.name, b), `group: ${b.goal.trim().slice(0, 60)}`);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/run") {
          if (!b.goal?.trim()) return json(400, { error: "goal required" });
          requestStart(s, ["run", ...flags(b), b.goal], `run: ${b.goal.slice(0, 60)}`);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/intake") {
          // `orch intake --github LABEL`: open issues with the label, each queued once.
          if (typeof b.github !== "string" || !LABEL.test(b.github)) return json(400, { error: "a GitHub label is required" });
          await new Promise<void>((ok, fail) =>
            execFile(
              process.execPath,
              [...ORCH_CMD, "intake", "--github", b.github],
              { cwd: s.repo, encoding: "utf8", windowsHide: true },
              (err, _out, stderr) => (err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok()),
            ),
          );
          sendSession(s);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/retry") {
          const id = Number(b.id);
          if (!Number.isInteger(id)) return json(400, { error: "goal id required" });
          await new Promise<void>((ok, fail) =>
            execFile(process.execPath, [...ORCH_CMD, "retry", String(id)], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
              err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
            ),
          );
          sendSession(s);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/move") {
          const id = Number(b.id);
          if (!Number.isInteger(id) || (b.direction !== "up" && b.direction !== "down")) return json(400, { error: "goal id and direction are required" });
          await new Promise<void>((ok, fail) =>
            execFile(
              process.execPath,
              [...ORCH_CMD, "move", String(id), b.direction],
              { cwd: s.repo, encoding: "utf8", windowsHide: true },
              (err, _out, stderr) => (err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok()),
            ),
          );
          sendSession(s);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/add") {
          if (!b.goal?.trim()) return json(400, { error: "goal required" });
          await addGoal(s, b.goal);
          sendSession(s);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/loop") {
          requestStart(s, ["loop", ...flags(b), ...(b.untilEmpty ? ["--until-empty"] : [])], "queue loop");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/learn") {
          // `orch learn`: a read-only pass that writes the project brief; a run like any other (slot, budget, log).
          requestStart(s, ["learn", ...flags({ ...b, dryRun: false })], "learn repo");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/split") {
          // A brief can be long: it goes to orch in a temporary file, which orch deletes once read (--brief-file-temp).
          if (typeof b.brief !== "string" || !b.brief.trim()) return json(400, { error: "brief required" });
          const file = join(tmpdir(), `yaaiorch-brief-${process.pid}-${Date.now()}.md`);
          writeFileSync(file, b.brief);
          requestStart(s, ["split", "--propose", "--brief-file", file, "--brief-file-temp", ...flags({ ...b, dryRun: false })], "split brief");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/split-accept") {
          await acceptSplit(s, b);
          sendSession(s);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/approve") {
          await approvePlan(s, b);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/answer") {
          if (typeof b.id !== "string" || typeof b.answer !== "string") return json(400, { error: "question ID and answer required" });
          await answerQuestion(s, b.id, b.answer);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/decide-command") {
          if (typeof b.id !== "string" || !["allow", "deny", "always", "prefix"].includes(b.decision))
            return json(400, { error: "command ID and decision (allow, deny, always, prefix) required" });
          await decideCommand(s, b.id, b.decision);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/share") {
          // `orch share`: proposes a CLAUDE.md section on an orchestrator/claude-md-* branch; the working tree is untouched.
          requestStart(s, ["share", ...flags({ ...b, dryRun: false })], "share to CLAUDE.md");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/rollback") {
          // Runs as a normal orch process: one per repo, output streams to that repo's log.
          requestStart(s, s.group ? ["group", "rollback", s.group.name] : ["rollback"], "rollback");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/stop-after") {
          // The loop checks this file before each goal (see `orch stop-after`).
          if (!s.child) return json(400, { error: "nothing is running in this repo" });
          mkdirSync(join(s.repo, ".orchestrator"), { recursive: true });
          writeFileSync(join(s.repo, ".orchestrator", "stop-after-goal"), new Date().toISOString());
          pushLine(s, "-- the queue will stop after the current goal --");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/stop") {
          stop(s);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/clear-log") {
          s.log.length = 0;
          sendInit();
          return json(200, { ok: true });
        }
      }
      // static (built UI)
      let file = join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
      if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile()) file = join(DIST, "index.html");
      if (!existsSync(file)) return json(404, { error: "UI not built; run `npm run build` or use `npm run dev`" });
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch (e) {
      console.error("Server error:", e);
      json(500, { error: (e as Error).message });
    }
  })
  .listen(PORT, "127.0.0.1", function (this: http.Server) {
    const port = (this.address() as { port: number }).port;
    listenPort = port;
    if (APP) console.log(`@@READY@@ ${JSON.stringify({ port, token: TOKEN })}`);
    console.log(`YAAIORCH ui  ${sessions.size} repo(s), ${maxParallel} at a time\n             http://localhost:${port}`);
  });

process.on("exit", () => {
  tunnel.stop();
  for (const s of sessions.values()) if (s.child?.pid) killTree(s.child.pid);
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
// Started by the desktop app: when the app is gone (closed, or crashed), stop every run and exit.
const parent = Number(process.env.YAAIORCH_PARENT_PID);
if (parent > 0)
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();
