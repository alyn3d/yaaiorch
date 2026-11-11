import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Finding, OrchEvent, State } from "./types";

export type Init = { state: State; log: string[]; events: OrchEvent[] };
export type Handlers = {
  onInit(d: Init): void;
  onState(s: State): void;
  onLog(line: string): void;
  onEvent(e: OrchEvent): void;
  onConnection(ok: boolean): void;
};
export interface Transport {
  canPickRepo: boolean;
  subscribe(h: Handlers): () => void;
  call(path: string, body?: Record<string, unknown>): Promise<void>;
  pickRepo(): Promise<void>;
  /** First-run checks (`orch doctor`) for the current repo. */
  doctor(): Promise<Finding[]>;
}

// ---------- browser: local Node server (server.ts) over HTTP + SSE ----------
const web: Transport = {
  canPickRepo: false,
  subscribe(h) {
    const es = new EventSource("/api/events");
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);
    es.onopen = () => h.onConnection(true);
    es.onerror = () => h.onConnection(false);
    es.addEventListener("init", (e) => h.onInit(data(e)));
    es.addEventListener("state", (e) => h.onState(data(e)));
    es.addEventListener("log", (e) => h.onLog(data(e)));
    es.addEventListener("ev", (e) => h.onEvent(data(e)));
    return () => es.close();
  },
  async call(path, body = {}) {
    const r = await fetch(`/api/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json()).error ?? r.statusText);
  },
  async pickRepo() {},
  async doctor() {
    const r = await fetch("/api/doctor");
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

const tauri: Transport = {
  canPickRepo: true,
  subscribe(h) {
    let cancelled = false;
    const unlisten: UnlistenFn[] = [];
    (async () => {
      const subs = await Promise.all([
        listen<Init>("orch-init", (e) => h.onInit(e.payload)),
        listen<State>("orch-state", (e) => h.onState(e.payload)),
        listen<string>("orch-log", (e) => h.onLog(e.payload)),
        listen<OrchEvent>("orch-ev", (e) => h.onEvent(e.payload)),
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
    try {
      await invoke(cmd, body); // JS camelCase keys map to Rust snake_case args
    } catch (e) {
      throw new Error(String(e));
    }
  },
  async pickRepo() {
    const p = await open({ directory: true, multiple: false, title: "Choose target repo" });
    if (typeof p === "string") await invoke("set_repo", { path: p });
  },
  async doctor() {
    return invoke<Finding[]>("doctor");
  },
};

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const transport: Transport = isTauri ? tauri : web;
