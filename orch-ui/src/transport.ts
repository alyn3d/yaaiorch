import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Finding, Global, OrchEvent, State } from "./types";

/** One repo's state, log and structured events since its last goal_start. */
export type SessionInit = { state: State; log: string[]; events: OrchEvent[] };
export type Init = { sessions: SessionInit[]; maxParallel: number; global: Global };
export type Handlers = {
  onInit(d: Init): void;
  onSession(s: State): void;
  onLog(repo: string, line: string): void;
  onEvent(repo: string, e: OrchEvent): void;
  onGlobal(g: Global): void;
  onConnection(ok: boolean): void;
};
export interface Transport {
  /** Desktop: a native folder picker. Browser: the user types a path. */
  canPickRepo: boolean;
  subscribe(h: Handlers): () => void;
  /** A repo command (run, add, loop, stop, clear-log, rollback); body carries `repo`. */
  call(path: string, body?: Record<string, unknown>): Promise<void>;
  /** Open a repo in a new tab: a picked folder (desktop) or the given path (browser). */
  addRepo(path?: string): Promise<void>;
  removeRepo(repo: string): Promise<void>;
  setMaxParallel(n: number): Promise<void>;
  /** Daily budget across all repos in USD; null removes it. */
  setDailyBudget(usd: number | null): Promise<void>;
  /** Lift the usage-limit hold now ("Try now"). */
  clearLimit(): Promise<void>;
  /** First-run checks (`orch doctor`) for one repo. */
  doctor(repo: string): Promise<Finding[]>;
}

// ---------- browser: local Node server (server.ts) over HTTP + SSE ----------
async function post(path: string, body: Record<string, unknown>) {
  const r = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
}

const web: Transport = {
  canPickRepo: false,
  subscribe(h) {
    const es = new EventSource("/api/events");
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);
    es.onopen = () => h.onConnection(true);
    es.onerror = () => h.onConnection(false);
    es.addEventListener("init", (e) => h.onInit(data(e)));
    es.addEventListener("session", (e) => h.onSession(data(e)));
    es.addEventListener("log", (e) => {
      const d = data(e);
      h.onLog(d.repo, d.line);
    });
    es.addEventListener("ev", (e) => {
      const d = data(e);
      h.onEvent(d.repo, d.ev);
    });
    es.addEventListener("global", (e) => h.onGlobal(data(e)));
    return () => es.close();
  },
  call: (path, body = {}) => post(path, body),
  async addRepo(path) {
    if (!path?.trim()) throw new Error("type the repo's folder path");
    await post("add-repo", { path: path.trim() });
  },
  removeRepo: (repo) => post("remove-repo", { repo }),
  setMaxParallel: (n) => post("settings", { maxParallel: n }),
  setDailyBudget: (usd) => post("settings", { dailyBudget: usd }),
  clearLimit: () => post("clear-limit", {}),
  async doctor(repo) {
    const r = await fetch(`/api/doctor?repo=${encodeURIComponent(repo)}`);
    return r.ok ? r.json() : [{ name: "server", level: "fail", detail: r.statusText }];
  },
};

// ---------- desktop: Tauri commands + events ----------
const COMMANDS: Record<string, string> = {
  run: "run_goal",
  add: "add_goal",
  loop: "run_loop",
  stop: "stop",
  "clear-log": "clear_log",
  rollback: "rollback",
};

async function tauriInvoke<T = void>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(cmd, args); // JS camelCase keys map to Rust snake_case args
  } catch (e) {
    throw new Error(String(e));
  }
}

const tauri: Transport = {
  canPickRepo: true,
  subscribe(h) {
    let cancelled = false;
    const unlisten: UnlistenFn[] = [];
    (async () => {
      const subs = await Promise.all([
        listen<Init>("orch-init", (e) => h.onInit(e.payload)),
        listen<State>("orch-session", (e) => h.onSession(e.payload)),
        listen<{ repo: string; line: string }>("orch-log", (e) => h.onLog(e.payload.repo, e.payload.line)),
        listen<{ repo: string; ev: OrchEvent }>("orch-ev", (e) => h.onEvent(e.payload.repo, e.payload.ev)),
        listen<Global>("orch-global", (e) => h.onGlobal(e.payload)),
      ]);
      if (cancelled) return subs.forEach((u) => u());
      unlisten.push(...subs);
      h.onInit(await invoke<Init>("snapshot"));
      h.onConnection(true);
    })();
    return () => {
      cancelled = true;
      unlisten.forEach((u) => u());
    };
  },
  async call(path, body = {}) {
    const cmd = COMMANDS[path];
    if (!cmd) throw new Error(`unknown command ${path}`);
    await tauriInvoke(cmd, body);
  },
  async addRepo() {
    const p = await open({ directory: true, multiple: false, title: "Open a repo" });
    if (typeof p === "string") await tauriInvoke("add_repo", { path: p });
  },
  removeRepo: (repo) => tauriInvoke("remove_repo", { repo }),
  setMaxParallel: (n) => tauriInvoke("set_max_parallel", { maxParallel: n }),
  setDailyBudget: (usd) => tauriInvoke("set_daily_budget", { dailyBudget: usd }),
  clearLimit: () => tauriInvoke("clear_limit"),
  doctor: (repo) => tauriInvoke<Finding[]>("doctor", { repo }),
};

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const transport: Transport = isTauri ? tauri : web;
