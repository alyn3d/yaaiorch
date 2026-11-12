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
import { readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join, extname, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ORCH = resolve(process.env.ORCH_PATH ?? join(here, "..", "orch.ts"));
const PORT = Number(process.env.PORT ?? 4317);
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const DIST = join(here, "dist");
/** Remembered open repos and the parallel limit. */
const SETTINGS_FILE = join(homedir(), ".yaaiorch", "ui.json");
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
    writeFileSync(SETTINGS_FILE, JSON.stringify({ repos: [...sessions.values()].map((s) => s.repo), maxParallel }, null, 2));
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
    queue: readJson<Item[]>(join(dir, "queue.json"), []),
    lastRun: readJson<unknown>(join(dir, "last-run.json"), null),
  };
}
const initPayload = () => ({
  sessions: [...sessions.values()].map((s) => ({ state: snapshot(s), log: s.log, events: s.events })),
  maxParallel,
});
const sendSession = (s: Session) => send("session", snapshot(s));
const sendInit = () => send("init", initPayload());

function pushLine(s: Session, line: string) {
  if (line.startsWith(MARK)) {
    try {
      const ev = JSON.parse(line.slice(MARK.length));
      if (ev.type === "goal_start") s.events = [];
      s.events.push(ev);
      send("ev", { repo: s.repo, ev });
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

/** Start now if a slot is free, else queue the start. One run per repo. */
function requestStart(s: Session, args: string[], label: string) {
  if (s.child || s.pending) throw new Error("this repo already has a run (or one waiting to start)");
  if (runningCount() < maxParallel) return startNow(s, args, label);
  s.pending = { args, label };
  startQueue.push(keyOf(s.repo));
  pushLine(s, `-- waiting for a free slot (${maxParallel} repo(s) may run at once) --`);
  sendSession(s);
}

function startNext() {
  while (startQueue.length && runningCount() < maxParallel) {
    const s = sessions.get(startQueue.shift()!);
    if (!s?.pending) continue;
    const { args, label } = s.pending;
    s.pending = null;
    startNow(s, args, label);
  }
}

function startNow(s: Session, args: string[], label: string) {
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

const flags = (b: { power?: string; maxRounds?: number; dryRun?: boolean; maxCost?: number; models?: string; onLimit?: string; fast?: boolean }) => [
  "--power", b.power ?? "heavy",
  "--max-rounds", String(b.maxRounds ?? 5),
  ...(b.dryRun ? ["--dry-run"] : []),
  ...(typeof b.maxCost === "number" && b.maxCost > 0 ? ["--max-cost", String(b.maxCost)] : []),
  ...(typeof b.models === "string" && MODEL_SPEC.test(b.models) ? ["--model", b.models] : []),
  ...(b.onLimit === "wait" || b.onLimit === "stop" ? ["--on-limit", b.onLimit] : []),
  ...(b.fast ? ["--fast"] : []),
];

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

function addGoal(s: Session, goal: string) {
  const queuePath = join(s.repo, ".orchestrator", "queue.json");
  const q = readJson<Item[]>(queuePath, []);
  q.push({ id: Math.max(0, ...q.map((i) => i.id)) + 1, goal, status: "pending" });
  mkdirSync(dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, JSON.stringify(q, null, 2));
}

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

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// Open the remembered repos, then the ones from the environment.
const stored = readJson<{ repos?: string[]; maxParallel?: number }>(SETTINGS_FILE, {});
if (!process.env.MAX_PARALLEL && stored.maxParallel) maxParallel = Math.max(1, stored.maxParallel);
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
    try {
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`event: init\ndata: ${JSON.stringify(initPayload())}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/api/state") return json(200, initPayload());
      if (url.pathname === "/api/doctor") return json(200, await doctor(mustGet(url.searchParams.get("repo"))));
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
        if (url.pathname === "/api/settings") {
          const n = Number(b.maxParallel);
          if (!Number.isInteger(n) || n < 1 || n > 16) return json(400, { error: "maxParallel must be 1 to 16" });
          maxParallel = n;
          saveSettings();
          sendInit();
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
        if (url.pathname === "/api/add") {
          if (!b.goal?.trim()) return json(400, { error: "goal required" });
          addGoal(s, b.goal);
          sendSession(s);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/loop") {
          requestStart(s, ["loop", ...flags(b), ...(b.untilEmpty ? ["--until-empty"] : [])], "queue loop");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/rollback") {
          // Runs as a normal orch process: one per repo, output streams to that repo's log.
          requestStart(s, ["rollback"], "rollback");
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
  .listen(PORT, "127.0.0.1", () =>
    console.log(`YAAIORCH ui  ${sessions.size} repo(s), ${maxParallel} at a time\n             http://localhost:${PORT}`),
  );

process.on("exit", () => {
  for (const s of sessions.values()) if (s.child?.pid) killTree(s.child.pid);
});
process.on("SIGINT", () => process.exit(0));
