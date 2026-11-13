import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Finding, Global, OrchEvent, Plugin, State } from "./types";

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
  /** A repo command (run, add, loop, learn, share, approve, split, split-accept, stop, clear-log, rollback); body carries `repo`. */
  call(path: string, body?: Record<string, unknown>): Promise<void>;
  /** Open a repo in a new tab: a picked folder (desktop) or the given path (browser). */
  addRepo(path?: string): Promise<void>;
  /** A new folder `name` in `parent`, opened as a repo, where `orch new` splits `spec` into goals (and starts with `start`). Returns the repo path. */
  newProject(p: NewProject): Promise<string>;
  /** Tauri: a folder picker for the parent folder; browser mode: null (type the path). */
  pickFolder(): Promise<string | null>;
  removeRepo(repo: string): Promise<void>;
  setMaxParallel(n: number): Promise<void>;
  /** Daily budget across all repos in USD; null removes it. */
  setDailyBudget(usd: number | null): Promise<void>;
  /** Percent caps on the subscription's 5-hour and weekly usage; null removes one. */
  setUsageCap(cap: Global["usageCap"]): Promise<void>;
  /** Lift the usage-limit hold now ("Try now"). */
  clearLimit(): Promise<void>;
  /** First-run checks (`orch doctor`) for one repo. */
  doctor(repo: string): Promise<Finding[]>;
  /** The repo's Claude Code plugins with their token cost (slow; the browser server caches it). */
  plugins(repo: string, fresh?: boolean): Promise<Plugin[]>;
}

// ---------- browser: local Node server (server.ts) over HTTP + SSE ----------
// Every /api call carries the server's session token (see refuse() in server.ts); a restarted server has a
// new one, so a 403 fetches it again and retries once.
let tokenP: Promise<string> | null = null;
function sessionToken(): Promise<string> {
  tokenP ??= fetch("/api/token", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`could not get the session token (${r.status})`))))
    .then((d: { token: string }) => d.token)
    .catch((e) => {
      tokenP = null;
      throw e;
    });
  return tokenP;
}
async function api(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const r = await fetch(path, { ...init, headers: { ...(init.headers as Record<string, string>), "x-orch-token": await sessionToken() } });
  if (r.status === 403 && retry) {
    tokenP = null;
    return api(path, init, false);
  }
  return r;
}
async function post(path: string, body: Record<string, unknown>) {
  const r = await api(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json().catch(() => ({}));
}

export type NewProject = {
  parent: string;
  name: string;
  spec: string;
  setup?: string;
  start: boolean;
  power: string;
  maxCost?: number;
  plugins?: unknown;
};

const web: Transport = {
  canPickRepo: false,
  subscribe(h) {
    // EventSource cannot send headers, so the token goes in the URL. A refused or dropped stream closes;
    // reconnect with a fresh token (the server may have restarted with a new one).
    let es: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);
    const connect = async () => {
      let token: string;
      try {
        token = await sessionToken();
      } catch {
        h.onConnection(false);
        retry = setTimeout(connect, 2000);
        return;
      }
      if (stopped) return;
      es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      es.onopen = () => h.onConnection(true);
      es.onerror = () => {
        h.onConnection(false);
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          tokenP = null;
          retry = setTimeout(connect, 2000);
        }
      };
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
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      es?.close();
    };
  },
  call: (path, body = {}) => post(path, body),
  async addRepo(path) {
    if (!path?.trim()) throw new Error("type the repo's folder path");
    await post("add-repo", { path: path.trim() });
  },
  async newProject(p) {
    return (await post("new-project", p)).repo;
  },
  pickFolder: async () => null,
  removeRepo: (repo) => post("remove-repo", { repo }),
  setMaxParallel: (n) => post("settings", { maxParallel: n }),
  setDailyBudget: (usd) => post("settings", { dailyBudget: usd }),
  setUsageCap: (cap) => post("settings", { usageCap: cap }),
  clearLimit: () => post("clear-limit", {}),
  async doctor(repo) {
    const r = await api(`/api/doctor?repo=${encodeURIComponent(repo)}`);
    return r.ok ? r.json() : [{ name: "server", level: "fail", detail: r.statusText }];
  },
  async plugins(repo, fresh) {
    const r = await api(`/api/plugins?repo=${encodeURIComponent(repo)}${fresh ? "&fresh=1" : ""}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
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
  learn: "learn_repo",
  share: "share_repo",
  approve: "approve_plan",
  split: "split_brief",
  "split-accept": "accept_split",
  "stop-after": "stop_after",
};

async function tauriInvoke<T = void>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>(cmd, args); // JS camelCase keys map to Rust snake_case args
  } catch (e) {
    throw new Error(String(e), { cause: e });
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
  newProject: (p) => tauriInvoke<string>("new_project", p),
  async pickFolder() {
    const p = await open({ directory: true, multiple: false, title: "Where to create the project" });
    return typeof p === "string" ? p : null;
  },
  removeRepo: (repo) => tauriInvoke("remove_repo", { repo }),
  setMaxParallel: (n) => tauriInvoke("set_max_parallel", { maxParallel: n }),
  setDailyBudget: (usd) => tauriInvoke("set_daily_budget", { dailyBudget: usd }),
  setUsageCap: (cap) => tauriInvoke("set_usage_cap", { fiveHour: cap.fiveHour, week: cap.week }),
  clearLimit: () => tauriInvoke("clear_limit"),
  doctor: (repo) => tauriInvoke<Finding[]>("doctor", { repo }),
  plugins: (repo) => tauriInvoke<Plugin[]>("plugins", { repo }),
};

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const transport: Transport = isTauri ? tauri : web;
