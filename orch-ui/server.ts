/**
 * Local server for the orchestrator UI.
 *   ORCH_REPO=<target repo>  (default: cwd)   ORCH_PATH=<orch.ts> (default: ../orch.ts)   PORT (4317)
 * Spawns orch.ts as a child process in the target repo, streams its output over SSE,
 * and reads .orchestrator/queue.json + last-run.json for state.
 */
import http from "node:http";
import { spawn, execFile, execFileSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, existsSync, mkdirSync, writeFileSync, createReadStream, statSync } from "node:fs";
import { resolve, join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(process.env.ORCH_REPO ?? process.cwd());
const ORCH = resolve(process.env.ORCH_PATH ?? join(here, "..", "orch.ts"));
const PORT = Number(process.env.PORT ?? 4317);
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const DIST = join(here, "dist");

type Item = { id: number; goal: string; status: string };
type Running = { pid: number; label: string; startedAt: number };

let child: ChildProcess | null = null;
let running: Running | null = null;
const log: string[] = [];
const MARK = "@@ORCH@@ ";
let events: unknown[] = []; // structured events since the last goal_start
const clients = new Set<http.ServerResponse>();

const send = (event: string, data: unknown) => {
  for (const c of clients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
const pushLine = (line: string) => {
  if (line.startsWith(MARK)) {
    try {
      const ev = JSON.parse(line.slice(MARK.length));
      if (ev.type === "goal_start") events = [];
      events.push(ev);
      send("ev", ev);
      return;
    } catch {
      /* fall through to plain log */
    }
  }
  log.push(line);
  if (log.length > 5000) log.splice(0, log.length - 5000);
  send("log", line);
};

const queuePath = join(REPO, ".orchestrator", "queue.json");
const lastRunPath = join(REPO, ".orchestrator", "last-run.json");
const readJson = <T>(p: string, fallback: T): T => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
};
const snapshot = () => ({
  repo: REPO,
  running,
  queue: readJson<Item[]>(queuePath, []),
  lastRun: readJson<unknown>(lastRunPath, null),
});

function spawnOrch(args: string[], label: string) {
  if (child) throw new Error("something is already running");
  const p = spawn(process.execPath, [TSX_CLI, ORCH, ...args], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env, FORCE_COLOR: "0", ORCH_EVENTS: "1" },
  });
  child = p;
  running = { pid: p.pid!, label, startedAt: Date.now() };
  pushLine(`$ orch ${args.join(" ")}`);
  // Chunks do not end on line boundaries: keep the partial last line until the rest arrives.
  for (const stream of [p.stdout!, p.stderr!]) {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop() ?? "";
      lines.filter(Boolean).forEach(pushLine);
    });
    stream.on("end", () => rest && pushLine(rest));
  }
  p.on("close", (code) => {
    pushLine(`-- exited (${code}) --`);
    child = null;
    running = null;
    send("state", snapshot());
  });
  send("state", snapshot());
}

function stop() {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
    } catch {
      /* already gone */
    }
  } else {
    process.kill(-child.pid, "SIGTERM");
  }
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

/** `orch doctor --json`, without blocking the event loop (SSE keeps flowing). */
const doctor = () =>
  new Promise<unknown>((ok) =>
    execFile(process.execPath, [TSX_CLI, ORCH, "doctor", "--json"], { cwd: REPO, encoding: "utf8", windowsHide: true }, (_err, stdout) => {
      // exit 1 just means a "fail" finding; the JSON is still on stdout
      try {
        ok(JSON.parse(stdout));
      } catch {
        ok([{ name: "orchestrator", level: "fail", detail: "could not run orch doctor" }]);
      }
    }),
  );

function addGoal(goal: string) {
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
        res.write(`event: init\ndata: ${JSON.stringify({ state: snapshot(), log, events })}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (url.pathname === "/api/state") return json(200, snapshot());
      if (url.pathname === "/api/doctor") return json(200, await doctor());
      if (url.pathname === "/api/agents") {
        const out = execFileSync(process.execPath, [TSX_CLI, ORCH, "agents"], { cwd: REPO, encoding: "utf8" });
        return json(200, { text: out });
      }
      if (req.method === "POST") {
        const b = await body(req);
        if (url.pathname === "/api/run") {
          if (!b.goal?.trim()) return json(400, { error: "goal required" });
          spawnOrch(["run", ...flags(b), b.goal], `run: ${b.goal.slice(0, 60)}`);
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/add") {
          if (!b.goal?.trim()) return json(400, { error: "goal required" });
          addGoal(b.goal);
          send("state", snapshot());
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/loop") {
          spawnOrch(["loop", ...flags(b), ...(b.untilEmpty ? ["--until-empty"] : [])], "queue loop");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/rollback") {
          // Runs as a normal orch process: refused while a goal runs, output streams to the log.
          spawnOrch(["rollback"], "rollback");
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/stop") {
          stop();
          return json(200, { ok: true });
        }
        if (url.pathname === "/api/clear-log") {
          log.length = 0;
          send("init", { state: snapshot(), log, events });
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
  .listen(PORT, "127.0.0.1", () => console.log(`YAAIORCH ui  repo=${REPO}\n             http://localhost:${PORT}`));

process.on("exit", stop);
process.on("SIGINT", () => process.exit(0));
