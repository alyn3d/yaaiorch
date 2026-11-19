// Tests for repo groups: the config format (orch-group.ts via orch.ts), `orch group add|list|remove` and the run lock
// a group holds in each member repo (inherited by its children through ORCH_GROUP_LOCK).
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(root, "orch-ui", "node_modules", "tsx", "dist", "cli.mjs");
const ORCH = join(root, "orch.ts");
let o;

before(async () => {
  process.env.ORCH_NO_MAIN = "1";
  const api = createRequire(join(root, "orch-ui", "package.json")).resolve("tsx/esm/api");
  const { tsImport } = await import(pathToFileURL(api).href);
  o = await tsImport(pathToFileURL(join(root, "orch.ts")).href, import.meta.url);
});

const tmp = () => mkdtempSync(join(tmpdir(), "orch-group-"));

function example(be, fe) {
  return {
    name: "shop",
    repos: [
      { path: be, role: "backend", serve: { command: "node server.js", url: "http://localhost:3000/health", timeout: 60 } },
      { path: fe, role: "frontend", env: { VITE_API_URL: "{backend}" } },
    ],
    contract: "openapi.yaml",
  };
}

describe("validateGroup", () => {
  const be = resolve(tmpdir(), "be");
  const fe = resolve(tmpdir(), "fe");
  test("accepts the example, integrationRounds undefined", () => {
    const g = o.validateGroup(example(be, fe));
    assert.equal(g.name, "shop");
    assert.equal(g.integrationRounds, undefined);
    assert.equal(o.memberOf(g, "backend").path, be);
    assert.equal(o.memberOf(g, "frontend").path, fe);
  });
  const bad = (what, change, re) =>
    test(`rejects ${what}`, () => {
      const g = example(be, fe);
      change(g);
      assert.throws(() => o.validateGroup(g), re);
    });
  bad("a bad name", (g) => (g.name = "Shop!"), /name/);
  bad("two backends", (g) => (g.repos[1].role = "backend"), /backend/);
  bad("a worker role", (g) => (g.repos[1].role = "worker"), /role/);
  bad("a single repo", (g) => g.repos.pop(), /exactly/);
  bad("a non-local serve url", (g) => (g.repos[0].serve.url = "http://example.com"), /localhost|local/);
  bad("a bad env name", (g) => (g.repos[1].env = { "vite-api": "x" }), /env/);
  bad("a relative path", (g) => (g.repos[0].path = "rel/be"), /absolute/);
  bad("integrationRounds 0", (g) => (g.integrationRounds = 0), /integrationRounds/);
  test("rejects a non-object", () => assert.throws(() => o.validateGroup(null), /group/));
});

describe("groupEnv", () => {
  const be = resolve(tmpdir(), "be");
  const fe = resolve(tmpdir(), "fe");
  test("origin of serve.url", () => {
    const g = o.validateGroup({
      name: "a",
      repos: [
        { path: be, role: "backend", serve: { url: "http://localhost:3000/health" } },
        { path: fe, role: "frontend", env: { VITE_API_URL: "{backend}" } },
      ],
    });
    assert.deepEqual(o.groupEnv(g), { VITE_API_URL: "http://localhost:3000" });
    assert.equal(o.backendBaseUrl(g), "http://localhost:3000");
  });
  test("baseUrl wins", () => {
    const g = o.validateGroup({
      name: "a",
      repos: [
        { path: be, role: "backend", serve: { url: "http://localhost:3000/health", baseUrl: "http://localhost:3000/api" } },
        { path: fe, role: "frontend", env: { VITE_API_URL: "{backend}" } },
      ],
    });
    assert.deepEqual(o.groupEnv(g), { VITE_API_URL: "http://localhost:3000/api" });
  });
});

describe("orch group", () => {
  const run = (home, ...args) => {
    const r = spawnSync(process.execPath, [TSX, ORCH, "group", ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ORCH_NO_MAIN: "", YAAIORCH_HOME: home, FORCE_COLOR: "0" },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
  };
  test("add, list --json, remove", () => {
    const home = tmp();
    const be = join(home, "be");
    const fe = join(home, "fe");
    mkdirSync(be);
    mkdirSync(fe);
    try {
      const add = run(
        home,
        "add",
        "shop",
        "--repo",
        `${be}:backend`,
        "--repo",
        `${fe}:frontend`,
        "--serve-command",
        "node server.js",
        "--serve-url",
        "http://localhost:3999/",
        "--env",
        "VITE_API_URL={backend}",
      );
      assert.equal(add.code, 0, add.out);
      const file = join(home, "groups", "shop.json");
      const saved = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(saved.name, "shop");
      assert.deepEqual(saved.repos[0], { path: be, role: "backend", serve: { command: "node server.js", url: "http://localhost:3999/" } });
      assert.deepEqual(saved.repos[1], { path: fe, role: "frontend", env: { VITE_API_URL: "{backend}" } });
      const list = run(home, "list", "--json");
      assert.equal(list.code, 0, list.out);
      assert.deepEqual(JSON.parse(list.stdout), [saved]);
      const rm = run(home, "remove", "shop");
      assert.equal(rm.code, 0, rm.out);
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("a bad role exits non-zero with the message", () => {
    const home = tmp();
    try {
      const r = run(home, "add", "shop", "--repo", `${home}:worker`, "--repo", `${home}:frontend`);
      assert.notEqual(r.code, 0);
      assert.match(r.out, /role/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("run lock held by a group", () => {
  const FAKE = join(root, "test", "fake-claude", process.platform === "win32" ? "claude.cmd" : "claude");
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const repo = () => {
    const dir = tmp();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "user.email", "test@localhost");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
    return dir;
  };
  const orchRun = (dir, env = {}) => {
    const r = spawnSync(process.execPath, [TSX, ORCH, "run", "x", "--max-rounds", "1"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, ORCH_NO_MAIN: "", CLAUDE_BIN: FAKE, FAKE_QA: "pass", FAKE_LOG: `${dir}.fake.log`, FORCE_COLOR: "0", ...env },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const lockFile = (dir) => join(dir, ".orchestrator", "run.lock");
  const withLock = (fn) => {
    const dir = repo();
    const id = o.acquireRunLock("group", dir);
    try {
      fn(dir, id);
    } finally {
      o.releaseRunLock(id, dir);
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}.fake.log`, { force: true });
    }
  };

  test("acquireRunLock at another root writes the lock there, releaseRunLock removes it", () =>
    withLock((dir, id) => {
      assert.equal(typeof id, "string");
      assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).id, id);
      o.releaseRunLock("someone-else", dir);
      assert.ok(existsSync(lockFile(dir)), "a different id must not release the lock");
      o.releaseRunLock(id, dir);
      assert.equal(existsSync(lockFile(dir)), false);
    }));

  test("plain run refused while group holds the lock", () =>
    withLock((dir) => {
      const r = orchRun(dir);
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /another orch is already running in this repo \(group/);
    }));

  test("child with ORCH_GROUP_LOCK runs", () =>
    withLock((dir, id) => {
      const r = orchRun(dir, { ORCH_GROUP_LOCK: id });
      assert.equal(r.code, 0, r.out);
      assert.ok(existsSync(lockFile(dir)), "the child must not release the group's lock");
      assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).id, id);
    }));

  test("mismatched ORCH_GROUP_LOCK refused", () =>
    withLock((dir, id) => {
      const r = orchRun(dir, { ORCH_GROUP_LOCK: "not-the-id" });
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /group lock mismatch/);
      assert.equal(JSON.parse(readFileSync(lockFile(dir), "utf8")).id, id);
    }));

  test("ORCH_GROUP_LOCK without a lock refused", () => {
    const dir = repo();
    try {
      const r = orchRun(dir, { ORCH_GROUP_LOCK: "nothing-held" });
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /group lock mismatch/);
      assert.equal(existsSync(lockFile(dir)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}.fake.log`, { force: true });
    }
  });
});
