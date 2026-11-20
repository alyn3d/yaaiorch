// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { AgentRoster, Finding, Global, HistoryEntry, HistoryRecording, OrchEvent, Plugin, State } from "./types";

/** One repo's state, log and structured events since its last goal_start. */
/** Agent M's answer: the text, the session to continue, and what it cost. */
export type AgentMReply = { answer: string; session?: string; cost: number };

export type SessionInit = { state: State; log: string[]; events: OrchEvent[] };
export type Init = { sessions: SessionInit[]; maxParallel: number; global: Global };
export type BrowserCandidate = { id: string; directory: string; script: string; scriptCommand: string; command: string; lifecycle: string[] };
export type BrowserSetup = {
  candidates: BrowserCandidate[];
  serve: { url: string; command?: string; auto?: BrowserCandidate } | null;
  enabled: boolean;
  browser: { path: string; via: string } | null;
};
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
  /** A repo command (run, add, loop, learn, share, approve, answer, decide-command, split, split-accept, stop, clear-log, rollback); body carries `repo`. */
  call(path: string, body?: Record<string, unknown>): Promise<void>;
  /** Open a repo in a new tab: a picked folder (desktop) or the given path (browser). */
  addRepo(path?: string): Promise<void>;
  /** A new folder `name` in `parent`, opened as a repo, where `orch new` splits `spec` into goals (and starts with `start`). Returns the repo path. */
  newProject(p: NewProject): Promise<string>;
  /** Tauri: a folder picker for the parent folder; browser mode: null (type the path). */
  pickFolder(): Promise<string | null>;
  removeRepo(repo: string): Promise<void>;
  /** Show the repo's folder in the system file manager. */
  revealRepo(repo: string): Promise<void>;
  setMaxParallel(n: number): Promise<void>;
  /** Daily budget across all repos in USD; null removes it. */
  setDailyBudget(usd: number | null): Promise<void>;
  /** Percent caps on the subscription's 5-hour and weekly usage; null removes one. */
  setUsageCap(cap: Global["usageCap"]): Promise<void>;
  /** Lift the usage-limit hold now ("Try now"). */
  clearLimit(): Promise<void>;
  /** First-run checks (`orch doctor`) for one repo; `pr`: the repo opens pull requests (`--pr`). */
  doctor(repo: string, pr?: boolean): Promise<Finding[]>;
  browserSetup(repo: string): Promise<BrowserSetup>;
  configureBrowser(repo: string, action: "enable" | "disable" | "login", id?: string): Promise<void>;
  /** The repo's Claude Code plugins with their token cost (slow; the browser server caches it). */
  plugins(repo: string, fresh?: boolean): Promise<Plugin[]>;
  /** Agents and skills discovered for a repo. */
  agents(repo: string): Promise<AgentRoster>;
  history(repo: string): Promise<HistoryEntry[]>;
  historyRun(repo: string, id: string): Promise<HistoryRecording>;
  /** Fetch a screenshot path reported by orch, scoped to this repo's visual output directory. Returns an object URL. */
  visualImage(repo: string, file: string): Promise<string>;
  /** Save a project-level agent definition (also creates an override of a built-in or user agent). */
  saveAgent(repo: string, name: string, content: string): Promise<void>;
  /** Use a custom agent in a built-in role, or undo the mapping when `target` is omitted. */
  swapAgent(repo: string, role: string, target?: string): Promise<void>;
  /** The repo's always-allowed commands (config allow); `remove` drops one rule first. */
  allowed(repo: string, remove?: string): Promise<{ allow: string[] }>;
  /** Turn a skill or a custom agent on or off in this repo (config skills.disable / agents.disable). */
  toggleRoster(repo: string, kind: "skill" | "agent", name: string, enabled: boolean): Promise<void>;
  /** Agent M: ask about the setup and the open repos (Haiku, read-only); `session` continues a conversation. */
  agentMAsk(question: string, session?: string): Promise<AgentMReply>;
  /** Agent M: gather the machine status in the background so the first question is quick (fire and forget). */
  agentMWarm(): Promise<void>;
  /** Create a repo group, or save over one of that name (`orch group add`). */
  saveGroup(g: GroupForm): Promise<void>;
  /** Delete a repo group's config (refused while it runs); its repos are not touched. */
  removeGroup(name: string): Promise<void>;
}

/** A repo group as the form edits it: absolute folders, the backend's serve, the frontend's env ({backend}: its URL). */
export type GroupForm = {
  name: string;
  backend: string;
  frontend: string;
  serveUrl?: string;
  serveCommand?: string;
  baseUrl?: string;
  env?: Record<string, string>;
};

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
  /** A git remote URL (any host) for origin; orch pushes main there. */
  remote?: string;
  start: boolean;
  power: string;
  maxCost?: number;
  /** With start: a budget for all the goals together. */
  maxCostTotal?: number;
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
  revealRepo: (repo) => post("reveal", { repo }),
  setMaxParallel: (n) => post("settings", { maxParallel: n }),
  setDailyBudget: (usd) => post("settings", { dailyBudget: usd }),
  setUsageCap: (cap) => post("settings", { usageCap: cap }),
  clearLimit: () => post("clear-limit", {}),
  async doctor(repo, pr) {
    const r = await api(`/api/doctor?repo=${encodeURIComponent(repo)}${pr ? "&pr=1" : ""}`);
    return r.ok ? r.json() : [{ name: "server", level: "fail", detail: r.statusText }];
  },
  async browserSetup(repo) {
    const r = await api(`/api/browser?repo=${encodeURIComponent(repo)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  },
  configureBrowser: (repo, action, id) => post("browser", { repo, action, id }),
  async plugins(repo, fresh) {
    const r = await api(`/api/plugins?repo=${encodeURIComponent(repo)}${fresh ? "&fresh=1" : ""}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  },
  async agents(repo) {
    const r = await api(`/api/agents?repo=${encodeURIComponent(repo)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  },
  async history(repo) {
    const r = await api(`/api/history?repo=${encodeURIComponent(repo)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  },
  async historyRun(repo, id) {
    const r = await api(`/api/history?repo=${encodeURIComponent(repo)}&id=${encodeURIComponent(id)}`);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  },
  async visualImage(repo, file) {
    const query = new URLSearchParams({ repo, file });
    return api(`/api/visual?${query}`).then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
      return URL.createObjectURL(await r.blob());
    });
  },
  saveAgent: (repo, name, content) => post("agents", { repo, name, content }),
  swapAgent: (repo, role, target) => post("agents/swap", { repo, role, target }),
  toggleRoster: (repo, kind, name, enabled) => post("agents/toggle", { repo, kind, name, enabled }),
  allowed: (repo, remove) => post("allow", { repo, ...(remove ? { remove } : {}) }),
  agentMAsk: (question, session) => post("agent-m/ask", { question, session }),
  agentMWarm: () => post("agent-m/warm", {}),
  saveGroup: (g) => post("group-save", g),
  removeGroup: (name) => post("group-remove", { name }),
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
  answer: "answer_question",
  "decide-command": "decide_command",
  retry: "retry_goal",
  move: "move_goal",
  intake: "intake_goals",
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
  revealRepo: (repo) => revealItemInDir(repo).catch((e) => Promise.reject(new Error(`could not show the folder: ${e}`))),
  setMaxParallel: (n) => tauriInvoke("set_max_parallel", { maxParallel: n }),
  setDailyBudget: (usd) => tauriInvoke("set_daily_budget", { dailyBudget: usd }),
  setUsageCap: (cap) => tauriInvoke("set_usage_cap", { fiveHour: cap.fiveHour, week: cap.week }),
  clearLimit: () => tauriInvoke("clear_limit"),
  doctor: (repo, pr) => tauriInvoke<Finding[]>("doctor", { repo, pr: !!pr }),
  browserSetup: (repo) => tauriInvoke<BrowserSetup>("browser_detect", { repo }),
  configureBrowser: (repo, action, id) => tauriInvoke("browser_configure", { repo, action, id }),
  plugins: (repo) => tauriInvoke<Plugin[]>("plugins", { repo }),
  agents: (repo) => tauriInvoke<AgentRoster>("agents", { repo }),
  history: (repo) => tauriInvoke<HistoryEntry[]>("history", { repo }),
  historyRun: (repo, id) => tauriInvoke<HistoryRecording>("history", { repo, id }),
  visualImage(repo, file) {
    return tauriInvoke<number[]>("visual_image", { repo, file }).then((bytes) =>
      URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: "image/png" })),
    );
  },
  saveAgent: (repo, name, content) => tauriInvoke("save_agent", { repo, name, content }),
  swapAgent: (repo, role, target) => tauriInvoke("swap_agent", { repo, role, target }),
  toggleRoster: (repo, kind, name, enabled) => tauriInvoke("toggle_roster", { repo, kind, name, enabled }),
  allowed: (repo, remove) => tauriInvoke<{ allow: string[] }>("allowed_commands", { repo, remove: remove ?? null }),
  agentMAsk: (question, session) => tauriInvoke<AgentMReply>("agent_m_ask", { question, session }),
  agentMWarm: () => tauriInvoke("agent_m_warm"),
  saveGroup: (g) => tauriInvoke("save_group", g),
  removeGroup: (name) => tauriInvoke("remove_group", { name }),
};

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const transport: Transport = isTauri ? tauri : web;
