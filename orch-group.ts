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

/**
 * What a member run's agents are told about the group (written by the group to a file, passed as --group-context):
 * the other repos, read-only, and the API contract both sides build against.
 */
export function groupSection(contract: string, others: { role: string; path: string }[]): string {
  return (
    `## Repo group\nThis repo is part of a group: one goal is built across several repos at once, against the API contract below. ` +
    `Build only this repo's part. Other repos (read-only, never write there; read them where the contract leaves something open):\n` +
    others.map((r) => `- ${r.role}: ${r.path}`).join("\n") +
    `\n\n## API contract\n${contract.trim()}\n`
  );
}

/** Parse the JSON object in a reply: a fenced json block if present, else the outermost {...}. */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/.exec(text)?.[1];
  for (const c of [fenced, text]) {
    if (!c) continue;
    const s = c.indexOf("{"),
      e = c.lastIndexOf("}");
    if (s < 0 || e < s) continue;
    try {
      return JSON.parse(c.slice(s, e + 1)) as T;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`no valid JSON in reply: ${text.slice(0, 200)}`);
}

// ---------- the coordinator: the API contract, one goal per repo, and who is at fault when integration fails ----------
export type GroupPlan = { contract: string; goals: Partial<Record<GroupRole, string>> };
export type FaultCall = { fault: GroupRole | "both"; goals: Partial<Record<GroupRole, string>>; contract?: string };

const ROLE_LIST: GroupRole[] = ["backend", "frontend"];

const repoLines = (g: GroupConfig) => g.repos.map((r) => `- ${r.role}: ${r.path}`).join("\n");

const COORDINATOR_PREAMBLE =
  `You are the group coordinator. One goal is built across two repos at once, a backend and a frontend, each by its own loop of ` +
  `agents. You never edit files: you read both repos (this one and the other, read-only) and reply with JSON.\n\nRepos:\n`;

const GOALS_NOTE =
  `Each goal is a complete, self-contained instruction for that repo's own planner: what to build there, against the contract, ` +
  `and how it is tested. A goal names no file in the other repo.`;

const PLAN_FORMAT = `

## Reply format
Do not edit any file. Reply with exactly one JSON object and nothing else:
{"contract": "<the API contract, in plain text: endpoints, methods, request and response shapes, status and error codes, auth>", "goals": {"backend": "<the backend repo's goal>", "frontend": "<the frontend repo's goal>"}}
Leave a repo out of "goals" only when the goal needs no change there.`;

const FAULT_FORMAT = `

## Reply format
Do not edit any file. Reply with exactly one JSON object and nothing else:
{"fault": "backend" | "frontend" | "both", "goals": {"<each repo at fault>": "<its fix goal>"}, "contract": "<the corrected contract; only when the contract itself was wrong>"}
"goals" has exactly one entry per repo named in "fault" ("both" means both). Leave "contract" out when it stands.`;

/** First call of a group goal: the contract and one sub-goal per repo. `existingContract` is the group's standing contract, if any. */
export function coordinatorPlanPrompt(g: GroupConfig, goal: string, briefs: Partial<Record<GroupRole, string>>, existingContract?: string): string {
  const brief = ROLE_LIST.filter((r) => briefs[r]?.trim())
    .map((r) => `### ${r} repo brief\n${briefs[r]!.trim()}`)
    .join("\n\n");
  return (
    COORDINATOR_PREAMBLE +
    repoLines(g) +
    `\n\nGoal for the whole group:\n${goal}\n\n` +
    (existingContract?.trim() ? `Existing API contract (keep what still holds, extend it for this goal):\n${existingContract.trim()}\n\n` : "") +
    (brief ? `Project briefs:\n${brief}\n\n` : "") +
    `Write the API contract both sides will build against, then one goal per repo. ${GOALS_NOTE}` +
    PLAN_FORMAT
  );
}

/** After a failed integration check: which side is at fault, and the fix goal for each. */
export function coordinatorFaultPrompt(g: GroupConfig, goal: string, contract: string, report: string): string {
  return (
    COORDINATOR_PREAMBLE +
    repoLines(g) +
    `\n\nGoal for the whole group:\n${goal}\n\nAPI contract both sides build against:\n${contract.trim()}\n\n` +
    `Integration failed: the frontend was checked in a browser against the running backend, and this is what was found:\n${report.trim()}\n\n` +
    `Read both repos and decide which side deviates from the contract (or whether the contract itself is wrong), then give the fix goal for each side at fault. ${GOALS_NOTE}` +
    FAULT_FORMAT
  );
}

function goalsOf(v: unknown, what: string): Partial<Record<GroupRole, string>> {
  if (!isObj(v)) throw new Error(`${what}: "goals" must be an object`);
  const goals: Partial<Record<GroupRole, string>> = {};
  for (const [k, val] of Object.entries(v)) {
    if (!ROLE_LIST.includes(k as GroupRole)) throw new Error(`${what}: unknown role "${k}" in goals (use backend or frontend)`);
    if (typeof val !== "string" || !val.trim()) throw new Error(`${what}: the ${k} goal must be a non-empty string`);
    goals[k as GroupRole] = val.trim();
  }
  return goals;
}

export function parseGroupPlan(text: string): GroupPlan {
  const r = extractJson<Record<string, unknown>>(text);
  if (typeof r.contract !== "string" || !r.contract.trim()) throw new Error("coordinator plan: no contract");
  const goals = goalsOf(r.goals, "coordinator plan");
  if (!Object.keys(goals).length) throw new Error("coordinator plan: no goals");
  return { contract: r.contract.trim(), goals };
}

export function parseFaultCall(text: string): FaultCall {
  const r = extractJson<Record<string, unknown>>(text);
  if (r.fault !== "backend" && r.fault !== "frontend" && r.fault !== "both") throw new Error(`coordinator fault call: unknown fault "${String(r.fault)}"`);
  const goals = goalsOf(r.goals, "coordinator fault call");
  for (const side of r.fault === "both" ? ROLE_LIST : [r.fault]) if (!goals[side]) throw new Error(`coordinator fault call: no goal for the ${side}`);
  const call: FaultCall = { fault: r.fault, goals };
  if (r.contract !== undefined) {
    if (typeof r.contract !== "string" || !r.contract.trim()) throw new Error("coordinator fault call: contract must be a non-empty string");
    call.contract = r.contract.trim();
  }
  return call;
}
