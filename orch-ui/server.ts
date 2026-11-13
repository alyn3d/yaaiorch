/**
 * Local server for the YAAIORCH UI, for several repos at once (one session per repo).
 *   ORCH_REPO=<repo> or ORCH_REPOS=<repo>;<repo>…  repos to open at start (the list is also remembered)
 *   ORCH_PATH=<orch.ts> (default: ../orch.ts)   PORT (4317)   MAX_PARALLEL (default 2)
 * Each session spawns orch.ts in its repo and streams output over SSE, tagged with the repo. At most
 * `maxParallel` sessions run at once; further starts wait for a free slot. One run per repo at a time.
 */
import http from "node:http";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream, statSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve, join, extname, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const ORCH = resolve(process.env.ORCH_PATH ?? join(here, "..", "orch.ts"));
const PORT = Number(process.env.PORT ?? 4317);
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const DIST = join(here, "dist");
/** Remembered open repos and the parallel limit. */
const SETTINGS_FILE = join(homedir(), ".yaaiorch", "ui.json");

// ---------- request guard: only the UI served by this process may drive it ----------
// The server listens on 127.0.0.1, but any web page in the user's browser can still send requests to it.
// Three checks stop that: the Host header must name this machine (defeats DNS rebinding), a browser's
// Origin header must be a local page, and every /api call must carry this process's random token, which
// only a same-origin page can read (from /api/token).
const TOKEN = randomBytes(32).toString("hex");
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
  if (url.pathname === "/api/token") return req.headers["sec-fetch-site"] === "cross-site" ? "forbidden" : null;
  return tokenOk(req.headers["x-orch-token"] ?? url.searchParams.get("token")) ? null : "missing or wrong session token; reload the page";
}
const MARK = "@@ORCH@@ ";
const MAX_LOG = 5000;

type Item = { id: number; goal: string; status: string; note?: string };
type Running = { pid: number; label: string; startedAt: number };
type Session = {
  repo: string;
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
const clients = new Set<http.ServerResponse>();

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
    writeFileSync(SETTINGS_FILE, JSON.stringify({ repos: [...sessions.values()].map((s) => s.repo), maxParallel, dailyBudget, spent, usageCap }, null, 2));
  } catch {
    /* not fatal: the list just is not remembered */
  }
}

const send = (event: string, data: unknown) => {
  for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

function snapshot(s: Session) {
  const dir = join(s.repo, ".orchestrator");
  return {
    repo: s.repo,
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
const sendSession = (s: Session) => send("session", snapshot(s));
const sendInit = () => send("init", initPayload());
const sendGlobal = () => {
  send("global", globalState());
  for (const s of sessions.values()) if (s.pending) sendSession(s); // their wait reason may have changed
};

/** Every agent call reports its cost once: the plan (architect, critic), each task_end, diff reviews, learn, notes tidy, share. */
const COST_EVENTS = new Set(["plan", "task_end", "review", "learn_end", "notes_tidy", "share_end", "split_proposal", "coverage"]);
function onEvent(s: Session, ev: { type: string; cost?: number; resetAt?: number; until?: number; reason?: string } & Partial<Record<Window, Reading>>) {
  if (ev.type === "usage") {
    // The windows are per account, so the latest reading from any repo holds for all of them.
    const next: Partial<Record<Window, Reading>> = {};
    for (const w of ["fiveHour", "week"] as Window[]) if (ev[w] && typeof ev[w]!.pct === "number") next[w] = ev[w];
    usage = { ...usage, ...next };
    sendGlobal();
  }
  if (COST_EVENTS.has(ev.type) && typeof ev.cost === "number" && ev.cost > 0) {
    if (spent.day !== today()) spent = { day: today(), usd: 0 };
    spent.usd += ev.cost;
    saveSettings();
    sendGlobal();
  }
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
      if (ev.type === "goal_start") s.events = [];
      s.events.push(ev);
      send("ev", { repo: s.repo, ev });
      onEvent(s, ev);
      return;
    } catch {
      /* fall through to plain log */
    }
  }
  s.log.push(line);
  if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
  send("log", { repo: s.repo, line });
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
  if (s.child || s.pending) throw new Error("this repo already has a run (or one waiting to start)");
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

function startNow(s: Session, rawArgs: string[], label: string) {
  const args = withBudget(rawArgs);
  const p = spawn(process.execPath, [TSX_CLI, ORCH, ...args], {
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
  if (s.child?.pid) killTree(s.child.pid);
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
  pr?: boolean;
  approvePlan?: boolean;
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
  ...(b.fast ? ["--fast"] : []),
  ...(b.critic ? ["--critic"] : []),
  ...(b.diffCritic ? ["--diff-critic"] : []),
  ...(b.review ? ["--review"] : []),
  ...(b.review && typeof b.reviewers === "string" && REVIEWERS.test(b.reviewers) ? ["--reviewers", b.reviewers] : []),
  ...(b.branch ? ["--branch"] : []),
  ...(b.pr ? ["--pr"] : []),
  ...(b.approvePlan ? ["--approve-plan"] : []),
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
      [TSX_CLI, ORCH, "plugins", "--json", "--details"],
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

/** `orch doctor --json` in a repo, without blocking the event loop (SSE keeps flowing). */
const doctor = (s: Session) =>
  new Promise<unknown>((ok) =>
    execFile(process.execPath, [TSX_CLI, ORCH, "doctor", "--json"], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (_err, stdout) => {
      // exit 1 just means a "fail" finding; the JSON is still on stdout
      try {
        ok(JSON.parse(stdout));
      } catch {
        ok([{ name: "orchestrator", level: "fail", detail: "could not run orch doctor" }]);
      }
    }),
  );

/** Through `orch add`, which edits the queue under its lock, so a running loop never loses the new goal. */
const addGoal = (s: Session, goal: string) =>
  new Promise<void>((ok, fail) =>
    execFile(process.execPath, [TSX_CLI, ORCH, "add", goal], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
    ),
  );

/** `orch split --accept`: queue the (edited) goals of a split brief; brief and goals go on stdin. */
const acceptSplit = (s: Session, b: { brief?: unknown; goals?: unknown }) =>
  new Promise<void>((ok, fail) => {
    const child = execFile(process.execPath, [TSX_CLI, ORCH, "split", "--accept"], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
    );
    child.stdin?.end(JSON.stringify({ brief: b.brief, goals: b.goals }));
  });

/** `orch approve` for a run waiting with --approve-plan: an edited plan goes on stdin, never on the command line. */
const approvePlan = (s: Session, b: { plan?: unknown; reject?: string }) =>
  new Promise<void>((ok, fail) => {
    const args = typeof b.reject === "string" ? ["--reject", b.reject.slice(0, 4000)] : b.plan ? ["--plan-stdin"] : [];
    const child = execFile(process.execPath, [TSX_CLI, ORCH, "approve", ...args], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
      err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
    );
    child.stdin?.end(b.plan && typeof b.reject !== "string" ? JSON.stringify(b.plan) : "");
  });

const body = (req: http.IncomingMessage) =>
  new Promise<any>((ok, bad) => {
    let s = "";
    req.on("data", (d) => (s += d));
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
}>(SETTINGS_FILE, {});
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

http
  .createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const json = (code: number, data: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const refused = refuse(req, url);
    if (refused) return json(403, { error: refused });
    try {
      if (url.pathname === "/api/token") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        return res.end(JSON.stringify({ token: TOKEN }));
      }
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: init\ndata: ${JSON.stringify(initPayload())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/api/state") return json(200, initPayload());
      if (url.pathname === "/api/doctor") return json(200, await doctor(mustGet(url.searchParams.get("repo"))));
      if (url.pathname === "/api/plugins") return json(200, await plugins(mustGet(url.searchParams.get("repo")), url.searchParams.has("fresh")));
      if (url.pathname === "/api/agents") {
        const s = mustGet(url.searchParams.get("repo"));
        return json(200, { text: execFileSync(process.execPath, [TSX_CLI, ORCH, "agents"], { cwd: s.repo, encoding: "utf8" }) });
      }
      if (req.method === "POST") {
        const b = await body(req);
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
          requestStart(
            s,
            ["new", ".", "--brief-file", file, "--brief-file-temp", ...setup, ...(b.start ? ["--start"] : []), ...flags({ ...b, dryRun: false })],
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
          saveSettings();
          sendInit();
          startNext();
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
        if (url.pathname === "/api/remove-repo") {
          if (s.child || s.pending) return json(409, { error: "stop this repo's run before closing it" });
          sessions.delete(keyOf(s.repo));
          saveSettings();
          sendInit();
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/run") {
          if (!b.goal?.trim()) return json(400, { error: "goal required" });
          requestStart(s, ["run", ...flags(b), b.goal], `run: ${b.goal.slice(0, 60)}`);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/retry") {
          const id = Number(b.id);
          if (!Number.isInteger(id)) return json(400, { error: "goal id required" });
          await new Promise<void>((ok, fail) =>
            execFile(process.execPath, [TSX_CLI, ORCH, "retry", String(id)], { cwd: s.repo, encoding: "utf8", windowsHide: true }, (err, _out, stderr) =>
              err ? fail(new Error(stderr.trim().split(/\r?\n/).pop() || err.message)) : ok(),
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
        if (url.pathname === "/api/share") {
          // `orch share`: proposes a CLAUDE.md section on an orchestrator/claude-md-* branch; the working tree is untouched.
          requestStart(s, ["share", ...flags({ ...b, dryRun: false })], "share to CLAUDE.md");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/rollback") {
          // Runs as a normal orch process: one per repo, output streams to that repo's log.
          requestStart(s, ["rollback"], "rollback");
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
      json(500, { error: (e as Error).message });
    }
  })
  .listen(PORT, "127.0.0.1", () => console.log(`YAAIORCH ui  ${sessions.size} repo(s), ${maxParallel} at a time\n             http://localhost:${PORT}`));

process.on("exit", () => {
  for (const s of sessions.values()) if (s.child?.pid) killTree(s.child.pid);
});
process.on("SIGINT", () => process.exit(0));
