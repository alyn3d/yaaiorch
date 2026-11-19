// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

// Repo groups: one goal planned across a backend and a frontend repo. A group is a small config file,
// ~/.yaaiorch/groups/<name>.json (home overridable with YAAIORCH_HOME), naming the repos and how to start the
// backend for the browser checks. Used by orch.ts; bundled into orch.mjs.
//
// Version 1 is exactly one backend and one frontend. Repo paths are stored resolved and are not checked for
// existence here: the run checks them.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isLocalUrl } from "./orch-browser";

export type GroupRole = "backend" | "frontend";
export type GroupRepo = {
  path: string;
  role: GroupRole;
  serve?: { command?: string; url: string; baseUrl?: string; timeout?: number };
  env?: Record<string, string>;
};
export type GroupConfig = { name: string; repos: GroupRepo[]; contract?: string; integrationRounds?: number };

const NAME_RE = /^[a-z0-9-]+$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function groupsDir(): string {
  return join(process.env.YAAIORCH_HOME || join(homedir(), ".yaaiorch"), "groups");
}

function validateRepo(v: unknown, i: number): GroupRepo {
  const at = `group repos[${i}]`;
  if (!isObj(v)) throw new Error(`${at} must be an object`);
  if (typeof v.path !== "string" || !v.path) throw new Error(`${at}: path must be a non-empty string`);
  if (!isAbsolute(v.path)) throw new Error(`${at}: path must be absolute, got "${v.path}"`);
  if (v.role !== "backend" && v.role !== "frontend") throw new Error(`${at}: role must be "backend" or "frontend", got "${String(v.role)}"`);
  const repo: GroupRepo = { path: resolve(v.path), role: v.role };
  if (v.serve !== undefined) {
    const s = v.serve;
    if (!isObj(s)) throw new Error(`${at}: serve must be an object`);
    if (typeof s.url !== "string" || !isLocalUrl(s.url))
      throw new Error(`${at}: serve.url must be a local URL (localhost, 127.0.0.1, [::1] or *.localhost), got "${String(s.url)}"`);
    const serve: NonNullable<GroupRepo["serve"]> = { url: s.url };
    if (s.command !== undefined) {
      if (typeof s.command !== "string" || !s.command.trim()) throw new Error(`${at}: serve.command must be a non-empty string`);
      serve.command = s.command;
    }
    if (s.baseUrl !== undefined) {
      if (typeof s.baseUrl !== "string" || !isLocalUrl(s.baseUrl)) throw new Error(`${at}: serve.baseUrl must be a local URL, got "${String(s.baseUrl)}"`);
      serve.baseUrl = s.baseUrl;
    }
    if (s.timeout !== undefined) {
      if (typeof s.timeout !== "number" || !(s.timeout > 0)) throw new Error(`${at}: serve.timeout must be a positive number of seconds`);
      serve.timeout = s.timeout;
    }
    repo.serve = serve;
  }
  if (v.env !== undefined) {
    if (!isObj(v.env)) throw new Error(`${at}: env must be an object of NAME: value`);
    const env: Record<string, string> = {};
    for (const [k, val] of Object.entries(v.env)) {
      if (!ENV_RE.test(k)) throw new Error(`${at}: env name "${k}" must match ${ENV_RE}`);
      if (typeof val !== "string") throw new Error(`${at}: env ${k} must be a string`);
      env[k] = val;
    }
    repo.env = env;
  }
  return repo;
}

/** Check a group config read from disk or built from the CLI; throws a readable Error. */
export function validateGroup(v: unknown): GroupConfig {
  if (!isObj(v)) throw new Error("group config must be an object");
  if (typeof v.name !== "string" || !NAME_RE.test(v.name))
    throw new Error(`group name must match ${NAME_RE} (lowercase letters, digits, "-"), got "${String(v.name)}"`);
  if (!Array.isArray(v.repos)) throw new Error("group repos must be a list");
  const repos = v.repos.map(validateRepo);
  const backends = repos.filter((r) => r.role === "backend").length;
  const frontends = repos.filter((r) => r.role === "frontend").length;
  if (repos.length !== 2 || backends !== 1 || frontends !== 1) throw new Error("a group has exactly one backend and one frontend repo");
  if (repos[0].path === repos[1].path) throw new Error("a group's backend and frontend must be different repos");
  const g: GroupConfig = { name: v.name, repos };
  if (v.contract !== undefined) {
    if (typeof v.contract !== "string" || !v.contract) throw new Error("group contract must be a non-empty string");
    g.contract = v.contract;
  }
  if (v.integrationRounds !== undefined) {
    if (typeof v.integrationRounds !== "number" || !Number.isInteger(v.integrationRounds) || v.integrationRounds < 1)
      throw new Error("group integrationRounds must be a whole number, at least 1");
    g.integrationRounds = v.integrationRounds;
  }
  return g;
}

const groupFile = (name: string) => {
  if (!NAME_RE.test(name)) throw new Error(`group name must match ${NAME_RE}, got "${name}"`);
  return join(groupsDir(), `${name}.json`);
};

export function readGroup(name: string): GroupConfig {
  const file = groupFile(name);
  if (!existsSync(file)) throw new Error(`no group "${name}" (${file})`);
  try {
    return validateGroup(JSON.parse(readFileSync(file, "utf8")));
  } catch (e) {
    throw new Error(`group "${name}": ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** orch-group.ts cannot import orch.ts's writeFileAtomic (a cycle), so orch.ts passes it in; the default is a plain tmp + rename. */
export function writeGroup(g: GroupConfig, write?: (path: string, data: string) => void): void {
  const v = validateGroup(g);
  const file = groupFile(v.name);
  const data = JSON.stringify(v, null, 2) + "\n";
  if (write) return write(file, data);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function listGroups(): GroupConfig[] {
  const dir = groupsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => readGroup(f.slice(0, -5)));
}

export function removeGroup(name: string): void {
  const file = groupFile(name);
  if (!existsSync(file)) throw new Error(`no group "${name}" (${file})`);
  rmSync(file);
}

export function memberOf(g: GroupConfig, role: GroupRole): GroupRepo {
  const r = g.repos.find((x) => x.role === role);
  if (!r) throw new Error(`group "${g.name}" has no ${role} repo`);
  return r;
}

/** Where the frontend reaches the backend: serve.baseUrl, else the origin of serve.url. */
export function backendBaseUrl(g: GroupConfig): string | undefined {
  const s = memberOf(g, "backend").serve;
  if (!s) return undefined;
  return s.baseUrl ?? new URL(s.url).origin;
}

/** The frontend's env with "{backend}" replaced by the backend's base URL. */
export function groupEnv(g: GroupConfig): Record<string, string> {
  const base = backendBaseUrl(g);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(memberOf(g, "frontend").env ?? {})) out[k] = base === undefined ? v : v.split("{backend}").join(base);
  return out;
}
