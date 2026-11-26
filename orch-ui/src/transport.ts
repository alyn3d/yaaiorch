// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { invoke } from "@tauri-apps/api/core";
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
  /** `error`: why the server cannot be reached (it is still being retried). */
  onConnection(ok: boolean, error?: string): void;
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
  /** Long runs keep the computer awake (applies to runs started from now on). */
  setKeepAwake(on: boolean): Promise<void>;
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

// ---------- the server (server.ts) over HTTP + SSE ----------
// Browser mode: the page and the API share the server's origin, and the page asks the server for its session token.
// Desktop: the app starts the same server (bundled as server.mjs) on a free port and hands its address and token to
// the webview (`server_info`). Every /api call carries the token (see refuse() in server.ts). A restarted server has a
// new token (and in the app a new port), so a 403 or a dropped connection asks again and retries once.
type Endpoint = { url: string; token: string };
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const findEndpoint = (): Promise<Endpoint> =>
  isTauri
    ? invoke<Endpoint>("server_info").catch((e) => Promise.reject(new Error(String(e))))
    : fetch("/api/token", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`could not get the session token (${r.status})`))))
        .then((d: { token: string }) => ({ url: "", token: d.token }));
let endpointP: Promise<Endpoint> | null = null;
function endpoint(): Promise<Endpoint> {
  endpointP ??= findEndpoint().catch((e) => {
    endpointP = null;
    throw e;
  });
  return endpointP;
}
async function api(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const { url, token } = await endpoint();
  let r: Response;
  try {
    r = await fetch(`${url}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), "x-orch-token": token } });
  } catch (e) {
    if (!retry) throw e;
    endpointP = null; // the app's server restarted on another port
    return api(path, init, false);
  }
  if (r.status === 403 && retry) {
    endpointP = null;
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
      let ep: Endpoint;
      try {
        ep = await endpoint();
      } catch (e) {
        h.onConnection(false, String((e as Error).message ?? e));
        retry = setTimeout(connect, 2000);
        return;
      }
      if (stopped) return;
      es = new EventSource(`${ep.url}/api/events?token=${encodeURIComponent(ep.token)}`);
      es.onopen = () => h.onConnection(true);
      es.onerror = () => {
        h.onConnection(false);
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          endpointP = null;
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
  setKeepAwake: (on) => post("settings", { keepAwake: on }),
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

// ---------- desktop: the same server, plus the native folder picker and file manager ----------
const desktop: Transport = {
  ...web,
  canPickRepo: true,
  async addRepo() {
    const p = await open({ directory: true, multiple: false, title: "Open a repo" });
    if (typeof p === "string") await web.addRepo(p);
  },
  async pickFolder() {
    const p = await open({ directory: true, multiple: false, title: "Where to create the project" });
    return typeof p === "string" ? p : null;
  },
  revealRepo: (repo) => revealItemInDir(repo).catch((e) => Promise.reject(new Error(`could not show the folder: ${e}`))),
};

export { isTauri };
export const transport: Transport = isTauri ? desktop : web;
