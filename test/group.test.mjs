// Tests for repo groups: the config format (orch-group.ts via orch.ts), `orch group add|list|remove` and the run lock
// a group holds in each member repo (inherited by its children through ORCH_GROUP_LOCK).
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

  test("releaseRunLock drops the heartbeat and exit listener of that lock", () => {
    const dir = repo();
    try {
      const before = process.listenerCount("exit");
      for (let i = 0; i < 12; i++) {
        const id = o.acquireRunLock("group", dir);
        assert.equal(process.listenerCount("exit"), before + 1);
        o.releaseRunLock(id, dir);
        assert.equal(process.listenerCount("exit"), before, "release must remove the lock's exit listener");
        assert.equal(existsSync(lockFile(dir)), false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused inherited start creates no .orchestrator dir", () => {
    const dir = repo();
    const prev = process.env.ORCH_GROUP_LOCK;
    process.env.ORCH_GROUP_LOCK = "nothing-held";
    try {
      assert.throws(() => o.acquireRunLock("group", dir), /group lock mismatch/);
      assert.equal(existsSync(join(dir, ".orchestrator")), false);
    } finally {
      if (prev === undefined) delete process.env.ORCH_GROUP_LOCK;
      else process.env.ORCH_GROUP_LOCK = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

describe("member run flags", () => {
  const FAKE = join(root, "test", "fake-claude", process.platform === "win32" ? "claude.cmd" : "claude");
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  /** The absolute form of a deny rule's path, as Claude Code matches it (Windows: C:\a\b is /c/a/b). */
  const rulePath = (p) => {
    const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    return m ? `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}` : p;
  };

  test("groupSection names the other repos with their roles and carries the contract", () => {
    const s = o.groupSection("GET /items -> Item[]", [{ role: "backend", path: "/x/be" }]);
    assert.match(s, /part of a group/);
    assert.match(s, /backend: \/x\/be/);
    assert.match(s, /read-only/);
    assert.match(s, /## API contract\nGET \/items -> Item\[\]/);
    const two = o.groupSection("c", [
      { role: "backend", path: "/x/be" },
      { role: "frontend", path: "/x/fe" },
    ]);
    assert.match(two, /backend: \/x\/be/);
    assert.match(two, /frontend: \/x\/fe/);
  });

  test("readDenyRules: Edit and the other edit tools on the absolute path", () => {
    const rules = o.readDenyRules([process.platform === "win32" ? "D:\\a b\\fe" : "/a b/fe"]);
    const p = process.platform === "win32" ? "/d/a b/fe" : "/a b/fe";
    assert.deepEqual(rules, [`Edit(/${p}/**)`, `Write(/${p}/**)`, `MultiEdit(/${p}/**)`, `NotebookEdit(/${p}/**)`]);
    assert.deepEqual(o.readDenyRules([]), []);
  });

  test("--group-context and --read-dir reach architect, implementers and QA", () => {
    const dir = tmp();
    const other = tmp();
    const prompts = tmp();
    const ctxFile = join(other, "group-context.md");
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.name", "test");
      git(dir, "config", "user.email", "test@localhost");
      git(dir, "config", "core.autocrlf", "false");
      git(dir, "commit", "-q", "--allow-empty", "-m", "init");
      writeFileSync(ctxFile, "## API contract\nCONTRACT-MARKER\n");
      const log = `${dir}.fake.log`;
      const r = spawnSync(process.execPath, [TSX, ORCH, "run", "x", "--max-rounds", "1", "--no-fast", "--group-context", ctxFile, "--read-dir", other], {
        cwd: dir,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ORCH_NO_MAIN: "", CLAUDE_BIN: FAKE, FAKE_QA: "pass", FAKE_LOG: log, FAKE_PROMPTS: prompts, FORCE_COLOR: "0" },
      });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      const real = realpathSync.native(other);
      const calls = readFileSync(log, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("call "));
      assert.ok(calls.length >= 4, calls.join("\n"));
      for (const c of calls) assert.ok(c.endsWith(` adddirs=${real}`), c);
      const settings = JSON.parse(readFileSync(join(dir, ".orchestrator", "agent-settings.json"), "utf8"));
      assert.ok(settings.permissions.deny.includes(`Edit(/${rulePath(real)}/**)`), JSON.stringify(settings));
      const readonly = JSON.parse(readFileSync(join(dir, ".orchestrator", "readonly-settings.json"), "utf8"));
      assert.ok(readonly.permissions.deny.includes("Edit"));
      assert.ok(readonly.permissions.deny.includes(`Edit(/${rulePath(real)}/**)`), JSON.stringify(readonly));
      const files = readdirSync(prompts);
      const roles = new Set();
      for (const f of files) {
        const role = /-([a-z]+)\.txt$/.exec(f)[1];
        roles.add(role);
        assert.match(readFileSync(join(prompts, f), "utf8"), /CONTRACT-MARKER/, `${role}'s prompt lacks the contract`);
      }
      for (const role of ["architect", "fe", "be", "qa"]) assert.ok(roles.has(role), `no ${role} prompt in ${files.join(", ")}`);
    } finally {
      for (const d of [dir, other, prompts]) rmSync(d, { recursive: true, force: true });
      rmSync(`${dir}.fake.log`, { force: true });
    }
  });

  test("the fast path's dev agent gets the group context too", () => {
    const dir = tmp();
    const prompts = tmp();
    const ctxFile = join(prompts, "..", `${basename(prompts)}.md`);
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.name", "test");
      git(dir, "config", "user.email", "test@localhost");
      git(dir, "commit", "-q", "--allow-empty", "-m", "init");
      writeFileSync(ctxFile, "CONTRACT-MARKER");
      const r = spawnSync(process.execPath, [TSX, ORCH, "run", "x", "--max-rounds", "1", "--fast", "--group-context", ctxFile], {
        cwd: dir,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ORCH_NO_MAIN: "", CLAUDE_BIN: FAKE, FAKE_QA: "pass", FAKE_PROMPTS: prompts, FORCE_COLOR: "0" },
      });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      const dev = readdirSync(prompts).filter((f) => f.endsWith("-dev.txt"));
      assert.ok(dev.length, readdirSync(prompts).join(", "));
      for (const f of dev) assert.match(readFileSync(join(prompts, f), "utf8"), /CONTRACT-MARKER/);
    } finally {
      for (const d of [dir, prompts]) rmSync(d, { recursive: true, force: true });
      rmSync(ctxFile, { force: true });
    }
  });

  test("a plain run has no add-dir and no deny rules in agent-settings.json", () => {
    const dir = tmp();
    try {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.name", "test");
      git(dir, "config", "user.email", "test@localhost");
      git(dir, "commit", "-q", "--allow-empty", "-m", "init");
      const log = `${dir}.fake.log`;
      const r = spawnSync(process.execPath, [TSX, ORCH, "run", "x", "--max-rounds", "1", "--no-fast"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ORCH_NO_MAIN: "", CLAUDE_BIN: FAKE, FAKE_QA: "pass", FAKE_LOG: log, FORCE_COLOR: "0" },
      });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      assert.doesNotMatch(readFileSync(log, "utf8"), /adddirs=/);
      const settings = JSON.parse(readFileSync(join(dir, ".orchestrator", "agent-settings.json"), "utf8"));
      assert.equal(settings.permissions.deny, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(`${dir}.fake.log`, { force: true });
    }
  });

  test("--read-dir must be an existing directory other than the repo", () => {
    const dir = tmp();
    try {
      git(dir, "init", "-q", "-b", "main");
      const run = (...a) =>
        spawnSync(process.execPath, [TSX, ORCH, "run", "x", ...a], {
          cwd: dir,
          encoding: "utf8",
          timeout: 60_000,
          env: { ...process.env, ORCH_NO_MAIN: "", CLAUDE_BIN: FAKE, FORCE_COLOR: "0" },
        });
      const missing = run("--read-dir", join(dir, "nope"));
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /--read-dir: .* does not exist/);
      const self = run("--read-dir", dir);
      assert.notEqual(self.status, 0);
      assert.match(self.stderr, /--read-dir: .* is this repo itself/);
      const parent = run("--read-dir", dirname(dir));
      assert.notEqual(parent.status, 0);
      assert.match(parent.stderr, /--read-dir: .* contains this repo/);
      mkdirSync(join(dir, "sub"));
      const sub = run("--read-dir", join(dir, "sub"));
      assert.notEqual(sub.status, 0);
      assert.match(sub.stderr, /--read-dir: .* inside it/);
      const noCtx = run("--group-context", join(dir, "nope.md"));
      assert.notEqual(noCtx.status, 0);
      assert.match(noCtx.stderr, /--group-context: cannot read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("orch group-member", () => {
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const repo = () => {
    const dir = tmp();
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "user.email", "test@localhost");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
    return dir;
  };
  const member = (dir, env, ...args) => {
    const r = spawnSync(process.execPath, [TSX, ORCH, "group-member", ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ORCH_NO_MAIN: "", FORCE_COLOR: "0", ...env },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, json: r.status === 0 ? JSON.parse(r.stdout.trim().split("\n").pop()) : null };
  };
  const withLock = (fn) => {
    const dir = repo();
    const id = o.acquireRunLock("group", dir);
    try {
      fn(dir, { ORCH_GROUP_LOCK: id });
    } finally {
      o.releaseRunLock(id, dir);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const branches = (dir) => git(dir, "branch", "--format=%(refname:short)").split("\n");

  test("checkpoint refuses a dirty tree, creates the branch on a clean one", () =>
    withLock((dir, env) => {
      writeFileSync(join(dir, "a.txt"), "x");
      const bad = member(dir, env, "checkpoint", "s1");
      assert.notEqual(bad.code, 0);
      assert.match(bad.out, /uncommitted changes/);
      rmSync(join(dir, "a.txt"));
      const ok = member(dir, env, "checkpoint", "s1");
      assert.equal(ok.code, 0, ok.out);
      assert.deepEqual(ok.json, { checkpoint: "orchestrator/group-checkpoint-s1", head: git(dir, "rev-parse", "HEAD") });
      assert.ok(branches(dir).includes("orchestrator/group-checkpoint-s1"));
    }));

  test("park failed keeps the work on failed-group-<stamp> and resets to the checkpoint", () =>
    withLock((dir, env) => {
      const cp = member(dir, env, "checkpoint", "s2").json.checkpoint;
      const base = git(dir, "rev-parse", "HEAD");
      writeFileSync(join(dir, "a.txt"), "x");
      git(dir, "add", "a.txt");
      git(dir, "commit", "-q", "-m", "work");
      writeFileSync(join(dir, "b.txt"), "uncommitted");
      const r = member(dir, env, "park", cp, "failed");
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(r.json, { parked: "orchestrator/failed-group-s2" });
      assert.equal(git(dir, "rev-parse", "HEAD"), base);
      assert.equal(existsSync(join(dir, "a.txt")), false);
      assert.equal(git(dir, "show", "orchestrator/failed-group-s2:b.txt"), "uncommitted");
      assert.equal(git(dir, "show", "orchestrator/failed-group-s2:a.txt"), "x");
    }));

  test("park interrupted names the branch interrupted-group-<stamp>; nothing to park gives null", () =>
    withLock((dir, env) => {
      const cp = member(dir, env, "checkpoint", "s3").json.checkpoint;
      assert.deepEqual(member(dir, env, "park", cp, "interrupted").json, { parked: null });
      writeFileSync(join(dir, "a.txt"), "x");
      assert.deepEqual(member(dir, env, "park", cp, "interrupted").json, { parked: "orchestrator/interrupted-group-s3" });
    }));

  test("reset parks as discarded-group-<stamp> and resets", () =>
    withLock((dir, env) => {
      const cp = member(dir, env, "checkpoint", "s4").json.checkpoint;
      writeFileSync(join(dir, "a.txt"), "x");
      const r = member(dir, env, "reset", cp);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(r.json, { parked: "orchestrator/discarded-group-s4" });
      assert.equal(existsSync(join(dir, "a.txt")), false);
    }));

  test("drop deletes a group checkpoint and refuses other branches", () =>
    withLock((dir, env) => {
      const cp = member(dir, env, "checkpoint", "s5").json.checkpoint;
      const bad = member(dir, env, "drop", "main");
      assert.notEqual(bad.code, 0);
      assert.match(bad.out, /group-checkpoint/);
      assert.ok(branches(dir).includes("main"));
      const r = member(dir, env, "drop", cp);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(r.json, {});
      assert.equal(branches(dir).includes(cp), false);
    }));

  test("a bad stamp is refused", () =>
    withLock((dir, env) => {
      const r = member(dir, env, "checkpoint", "a b/..");
      assert.notEqual(r.code, 0);
      assert.match(r.out, /stamp/);
    }));

  test("every action refuses without ORCH_GROUP_LOCK", () => {
    const dir = repo();
    try {
      for (const args of [
        ["checkpoint", "s6"],
        ["park", "orchestrator/group-checkpoint-s6", "failed"],
        ["reset", "orchestrator/group-checkpoint-s6"],
        ["drop", "orchestrator/group-checkpoint-s6"],
      ]) {
        const r = member(dir, { ORCH_GROUP_LOCK: "" }, ...args);
        assert.notEqual(r.code, 0, args.join(" "));
        assert.match(r.out, /ORCH_GROUP_LOCK/);
      }
      assert.equal(existsSync(join(dir, ".orchestrator")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("coordinator replies and prompts", () => {
  const g = example("/x/be", "/x/fe");
  const fence = (v) => "Here you go.\n```json\n" + JSON.stringify(v) + "\n```";

  test("parseGroupPlan: a fenced reply with a contract and goals", () => {
    const p = o.parseGroupPlan(fence({ contract: "GET /a", goals: { backend: "do be", frontend: "do fe" } }));
    assert.deepEqual(p, { contract: "GET /a", goals: { backend: "do be", frontend: "do fe" } });
  });
  test("parseGroupPlan: a bare JSON reply, one goal only", () => {
    assert.deepEqual(o.parseGroupPlan(JSON.stringify({ contract: "c", goals: { backend: "b" } })).goals, { backend: "b" });
  });
  test("parseGroupPlan throws on a missing contract, no goals, an unknown role", () => {
    assert.throws(() => o.parseGroupPlan(fence({ goals: { backend: "b" } })), /contract/);
    assert.throws(() => o.parseGroupPlan(fence({ contract: " ", goals: { backend: "b" } })), /contract/);
    assert.throws(() => o.parseGroupPlan(fence({ contract: "c", goals: {} })), /goal/);
    assert.throws(() => o.parseGroupPlan(fence({ contract: "c", goals: { backend: "b", mobile: "m" } })), /mobile/);
    assert.throws(() => o.parseGroupPlan("no json here"), /JSON/);
  });
  test("parseFaultCall: one side, both, and a revised contract", () => {
    assert.deepEqual(o.parseFaultCall(fence({ fault: "frontend", goals: { frontend: "fix fe" } })), { fault: "frontend", goals: { frontend: "fix fe" } });
    const both = o.parseFaultCall(fence({ fault: "both", goals: { backend: "b", frontend: "f" }, contract: "NEW" }));
    assert.equal(both.fault, "both");
    assert.equal(both.contract, "NEW");
  });
  test("parseFaultCall throws on a fault side without its goal and on unknown roles", () => {
    assert.throws(() => o.parseFaultCall(fence({ fault: "both", goals: { backend: "b" } })), /frontend/);
    assert.throws(() => o.parseFaultCall(fence({ fault: "backend", goals: { frontend: "f" } })), /backend/);
    assert.throws(() => o.parseFaultCall(fence({ fault: "mobile", goals: { mobile: "m" } })), /mobile/);
    assert.throws(() => o.parseFaultCall(fence({ fault: "backend", goals: { backend: "b", mobile: "m" } })), /mobile/);
  });
  test("both prompts name each repo's role and path", () => {
    const plan = o.coordinatorPlanPrompt(g, "add items", { backend: "BE-BRIEF" });
    const fault = o.coordinatorFaultPrompt(g, "add items", "THE-CONTRACT", "it broke");
    for (const p of [plan, fault]) {
      assert.ok(p.startsWith("You are the group coordinator."), p.slice(0, 60));
      assert.match(p, /backend: \/x\/be/);
      assert.match(p, /frontend: \/x\/fe/);
      assert.match(p, /add items/);
    }
    assert.match(plan, /BE-BRIEF/);
    assert.match(o.coordinatorPlanPrompt(g, "g", {}, "OLD-CONTRACT"), /OLD-CONTRACT/);
    assert.match(fault, /Integration failed/);
    assert.match(fault, /THE-CONTRACT/);
    assert.match(fault, /it broke/);
  });
});

describe("orch group-member coordinate", () => {
  const FAKE = join(root, "test", "fake-claude", process.platform === "win32" ? "claude.cmd" : "claude");
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const setup = () => {
    const home = tmp();
    const be = join(home, "be");
    const fe = join(home, "fe");
    for (const d of [be, fe]) {
      mkdirSync(d);
      git(d, "init", "-q", "-b", "main");
    }
    mkdirSync(join(home, "groups"));
    writeFileSync(join(home, "groups", "shop.json"), JSON.stringify(example(be, fe)));
    return { home, be, fe };
  };
  const coordinate = (s, mode, input, env = {}, extra = []) => {
    const id = o.acquireRunLock("group", s.be);
    try {
      const r = spawnSync(process.execPath, [TSX, ORCH, "group-member", "coordinate", mode, "--group", "shop", ...extra], {
        cwd: s.be,
        input: JSON.stringify(input),
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, ORCH_NO_MAIN: "", YAAIORCH_HOME: s.home, ORCH_GROUP_LOCK: id, CLAUDE_BIN: FAKE, FORCE_COLOR: "0", ...env },
      });
      return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, json: r.status === 0 ? JSON.parse(r.stdout.trim().split("\n").pop()) : null };
    } finally {
      o.releaseRunLock(id, s.be);
    }
  };

  test("plan: prints one JSON line with the reply and cost; the coordinator runs read-only with the other repo", () => {
    const s = setup();
    const log = join(s.home, "fake.log");
    const prompts = join(s.home, "prompts");
    try {
      const r = coordinate(s, "plan", { goal: "add items", briefs: { frontend: "FE-BRIEF-TEXT" } }, { FAKE_LOG: log, FAKE_PROMPTS: prompts });
      assert.equal(r.code, 0, r.out);
      assert.equal(r.stdout.trim().split("\n").length, 1, r.stdout);
      assert.equal(r.json.reply.contract, "GET /api/items → Item[]");
      assert.deepEqual(Object.keys(r.json.reply.goals).sort(), ["backend", "frontend"]);
      assert.equal(typeof r.json.cost, "number");
      assert.ok(r.json.cost > 0);
      const call = readFileSync(log, "utf8")
        .split("\n")
        .find((l) => l.startsWith("call "));
      assert.match(call, /agent=coordinator mode=default /);
      assert.ok(call.endsWith(` adddirs=${realpathSync.native(s.fe)}`), call);
      const sent = readFileSync(join(prompts, readdirSync(prompts)[0]), "utf8");
      assert.match(sent, /FE-BRIEF-TEXT/);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });

  test("fault: FAKE_GROUP_FAULT picks the side, FAKE_GROUP_REVISE adds a contract; --max-cost is accepted", () => {
    const s = setup();
    try {
      const input = { goal: "g", contract: "C", report: "request failed", briefs: {} };
      const def = coordinate(s, "fault", input);
      assert.equal(def.code, 0, def.out);
      assert.equal(def.json.reply.fault, "frontend");
      assert.deepEqual(Object.keys(def.json.reply.goals), ["frontend"]);
      const be = coordinate(s, "fault", input, { FAKE_GROUP_FAULT: "backend", FAKE_GROUP_REVISE: "1" }, ["--max-cost", "5"]);
      assert.equal(be.json.reply.fault, "backend");
      assert.equal(be.json.reply.contract, "REVISED");
      const both = coordinate(s, "fault", input, { FAKE_GROUP_FAULT: "both" });
      assert.deepEqual(Object.keys(both.json.reply.goals).sort(), ["backend", "frontend"]);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });

  test("stdout is exactly one {reply, cost} line even with ORCH_EVENTS=1 and a usage reading", () => {
    const s = setup();
    try {
      const r = coordinate(s, "plan", { goal: "g", briefs: {} }, { ORCH_EVENTS: "1", FAKE_USAGE: "0.5,0.2" });
      assert.equal(r.code, 0, r.out);
      const lines = r.stdout.trim().split(String.fromCharCode(10));
      assert.equal(lines.length, 1, r.stdout);
      assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ["cost", "reply"]);
      assert.doesNotMatch(r.stdout, /@@ORCH@@/);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });

  test("needs the group lock, a known group and a mode", () => {
    const s = setup();
    try {
      const noLock = coordinate(s, "plan", { goal: "g", briefs: {} }, { ORCH_GROUP_LOCK: "" });
      assert.notEqual(noLock.code, 0);
      assert.match(noLock.out, /ORCH_GROUP_LOCK/);
      const bad = coordinate(s, "nope", { goal: "g", briefs: {} });
      assert.notEqual(bad.code, 0);
      assert.match(bad.out, /usage: orch group-member coordinate/);
    } finally {
      rmSync(s.home, { recursive: true, force: true });
    }
  });
});

describe("orch group run", { timeout: 600_000 }, () => {
  const FAKE = join(root, "test", "fake-claude", process.platform === "win32" ? "claude.cmd" : "claude");
  const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const initRepo = (dir) => {
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "test");
    git(dir, "config", "user.email", "test@localhost");
    git(dir, "config", "core.autocrlf", "false");
    git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  };
  /** Two member repos and a group "shop" without serve (so integration is skipped), in a temp YAAIORCH_HOME. */
  const setup = () => {
    const home = tmp();
    const be = join(home, "be");
    const fe = join(home, "fe");
    initRepo(be);
    initRepo(fe);
    mkdirSync(join(home, "groups"));
    writeFileSync(
      join(home, "groups", "shop.json"),
      JSON.stringify({
        name: "shop",
        repos: [
          { path: be, role: "backend" },
          { path: fe, role: "frontend" },
        ],
      }),
    );
    return { home, be, fe, gdir: join(home, "groups", "shop"), heads: { be: git(be, "rev-parse", "HEAD"), fe: git(fe, "rev-parse", "HEAD") } };
  };
  const envFor = (s, env) => ({
    ...process.env,
    ORCH_NO_MAIN: "",
    YAAIORCH_HOME: s.home,
    CLAUDE_BIN: FAKE,
    ORCH_EVENTS: "1",
    FORCE_COLOR: "0",
    FAKE_LOG: join(s.home, "fake.log"),
    FAKE_QA: "pass",
    ...env,
  });
  const parse = (out) =>
    out
      .split(/\r?\n/)
      .filter((l) => l.startsWith("@@ORCH@@ "))
      .map((l) => JSON.parse(l.slice(9)));
  const group = (s, args, env = {}) => {
    const r = spawnSync(process.execPath, [TSX, ORCH, "group", ...args], { cwd: s.home, encoding: "utf8", timeout: 240_000, env: envFor(s, env) });
    const events = parse(r.stdout ?? "");
    return { code: r.status, out: `${r.stdout}${r.stderr}`, events, ev: (t) => events.filter((e) => e.type === t) };
  };
  const groupAsync = (s, args, env = {}) => {
    const child = spawn(process.execPath, [TSX, ORCH, "group", ...args], { cwd: s.home, env: envFor(s, env) });
    let out = "";
    let stdout = "";
    child.stdout.on("data", (d) => {
      out += d;
      stdout += d;
    });
    child.stderr.on("data", (d) => (out += d));
    const done = new Promise((ok) => child.on("close", (code) => ok({ code, out })));
    return { child, done, events: () => parse(stdout) };
  };
  const until = async (cond, ms = 60_000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const branches = (dir) => git(dir, "branch", "--list", "orchestrator/*", "--format=%(refname:short)").split("\n").filter(Boolean);
  const head = (dir) => git(dir, "rev-parse", "HEAD");
  const locks = (s) =>
    [join(s.be, ".orchestrator", "run.lock"), join(s.fe, ".orchestrator", "run.lock"), join(s.gdir, "run.lock")].filter((f) => existsSync(f));
  const clean = (s) => rmSync(s.home, { recursive: true, force: true });

  test("happy path builds both repos", () => {
    const s = setup();
    try {
      const r = group(s, ["run", "shop", "list the items"]);
      assert.equal(r.code, 0, r.out);
      assert.equal(r.ev("group_start")[0].group, "shop");
      assert.equal(r.ev("group_plan")[0].contract, "GET /api/items → Item[]");
      assert.equal(r.ev("group_end").at(-1).ok, true, r.out);
      for (const [dir, start] of [
        [s.be, s.heads.be],
        [s.fe, s.heads.fe],
      ]) {
        assert.notEqual(head(dir), start, `${dir} has a new commit`);
        assert.deepEqual(
          branches(dir).filter((b) => b.startsWith("orchestrator/group-checkpoint-")),
          [],
        );
        assert.match(readFileSync(join(dir, ".orchestrator", "contract.md"), "utf8"), /GET \/api\/items/);
      }
      const paths = new Set(r.ev("group_child").map((e) => e.repo));
      assert.ok(paths.has(s.be) && paths.has(s.fe), [...paths].join(", "));
      assert.ok(r.ev("group_child").some((e) => e.event.type === "goal_end" && e.event.passed));
      assert.deepEqual(
        r
          .ev("group_step")
          .map((e) => e.repo)
          .sort(),
        ["backend", "frontend"],
      );
      assert.match(r.out, /integration skipped/);
      assert.deepEqual(locks(s), []);
      const last = JSON.parse(readFileSync(join(s.gdir, "last-run.json"), "utf8"));
      assert.equal(last.ok, true);
      assert.equal(last.goal, "list the items");
      assert.deepEqual(last.checkpoints, { backend: s.heads.be, frontend: s.heads.fe });
      // The build children read the other repo (--read-dir reaches the agents as --add-dir).
      assert.match(readFileSync(join(s.home, "fake.log"), "utf8"), /agent=dev .*adddirs=/);
    } finally {
      clean(s);
    }
  });

  test("a member's branch, pr and approvePlan config is ignored inside the group", () => {
    const s = setup();
    const ghLog = join(s.home, "gh.log");
    try {
      mkdirSync(join(s.be, ".orchestrator"));
      writeFileSync(join(s.be, ".orchestrator", "config.json"), JSON.stringify({ branch: true, pr: true, approvePlan: true }));
      const gh = join(root, "test", "fake-gh", process.platform === "win32" ? "gh.cmd" : "gh");
      const r = group(s, ["run", "shop", "list the items"], { GH_BIN: gh, FAKE_GH_LOG: ghLog });
      assert.equal(r.code, 0, r.out);
      assert.equal(r.ev("group_end").at(-1).ok, true);
      assert.match(r.out, /ignores pr, branch, approvePlan/);
      assert.equal(git(s.be, "symbolic-ref", "--short", "HEAD"), "main");
      assert.notEqual(head(s.be), s.heads.be, "the commit lands on main");
      assert.deepEqual(git(s.be, "branch", "--list", "orch/*", "--format=%(refname:short)"), "");
      assert.equal(existsSync(ghLog), false, "no gh call");
      assert.equal(existsSync(join(s.be, ".orchestrator", "plan-pending.json")), false);
    } finally {
      clean(s);
    }
  });

  test("build failure parks both", () => {
    const s = setup();
    try {
      const r = group(s, ["run", "shop", "list the items", "--no-fast", "--max-rounds", "1"], { FAKE_FAIL_AGENT: "be" });
      assert.equal(r.code, 1, r.out);
      const end = r.ev("group_end").at(-1);
      assert.equal(end.ok, false);
      assert.equal(head(s.be), s.heads.be);
      assert.equal(head(s.fe), s.heads.fe);
      for (const dir of [s.be, s.fe]) {
        assert.ok(
          branches(dir).some((b) => b.startsWith("orchestrator/failed-group-")),
          branches(dir).join(", "),
        );
        assert.deepEqual(
          branches(dir).filter((b) => /checkpoint/.test(b)),
          [],
          "no checkpoint left behind",
        );
      }
      assert.match(end.parked.backend, /^orchestrator\/failed-group-/);
      assert.deepEqual(locks(s), []);
      assert.equal(JSON.parse(readFileSync(join(s.gdir, "last-run.json"), "utf8")).ok, false);
    } finally {
      clean(s);
    }
  });

  const refused = (what, prepare, re) =>
    test(`refuses ${what}`, () => {
      const s = setup();
      const held = prepare(s);
      try {
        const r = group(s, ["run", "shop", "list the items"]);
        assert.equal(r.code, 1, r.out);
        assert.match(r.out, re);
        for (const dir of [s.be, s.fe]) if (existsSync(dir)) assert.deepEqual(branches(dir), [], dir);
        assert.deepEqual(
          locks(s).filter((f) => f !== held?.keep),
          [],
        );
      } finally {
        held?.release?.();
        clean(s);
      }
    });
  refused("a dirty member repo", (s) => writeFileSync(join(s.fe, "stray.txt"), "x"), /uncommitted changes/);
  refused(
    "a locked member repo",
    (s) => {
      const id = o.acquireRunLock("run", s.fe);
      return { keep: join(s.fe, ".orchestrator", "run.lock"), release: () => o.releaseRunLock(id, s.fe) };
    },
    /already running/,
  );
  refused("a missing member repo", (s) => rmSync(s.fe, { recursive: true, force: true }), /does not exist/);

  test("approve-plan waits for orch approve --group", async () => {
    const s = setup();
    const prompts = join(s.home, "prompts");
    const run = groupAsync(s, ["run", "shop", "list the items", "--approve-plan"], { FAKE_PROMPTS: prompts });
    const approve = (...args) =>
      spawnSync(process.execPath, [TSX, ORCH, "approve", "--group", "shop", ...args], { cwd: s.home, encoding: "utf8", env: envFor(s, {}) });
    const pending = join(s.gdir, "plan-pending.json");
    const round = () => {
      try {
        return JSON.parse(readFileSync(pending, "utf8")).round;
      } catch {
        return 0;
      }
    };
    try {
      await until(() => round() === 1);
      assert.equal(JSON.parse(readFileSync(pending, "utf8")).contract, "GET /api/items → Item[]");
      const rej = approve("--reject", "ADD PAGING");
      assert.equal(rej.status, 0, rej.stderr);
      await until(() => round() === 2);
      const sent = readdirSync(prompts)
        .filter((f) => f.endsWith("-coordinator.txt"))
        .map((f) => readFileSync(join(prompts, f), "utf8"));
      assert.equal(sent.length, 2);
      assert.ok(
        sent.some((p) => p.includes("ADD PAGING")),
        "the reason reaches the coordinator",
      );
      const ok = approve();
      assert.equal(ok.status, 0, ok.stderr);
      const { code, out } = await run.done;
      assert.equal(code, 0, out);
      assert.equal(existsSync(pending), false);
      assert.equal(run.events().filter((e) => e.type === "group_plan").length, 2);
      assert.equal(run.events().at(-1).type, "group_end");
    } finally {
      if (run.child.exitCode === null) run.child.kill();
      await run.done;
      clean(s);
    }
  });

  test("approve --group without a waiting plan fails", () => {
    const s = setup();
    try {
      const r = spawnSync(process.execPath, [TSX, ORCH, "approve", "--group", "shop"], { cwd: s.home, encoding: "utf8", env: envFor(s, {}) });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /no group plan is waiting/);
    } finally {
      clean(s);
    }
  });

  // Windows cannot deliver SIGTERM (kill() terminates the process), so there `orch group stop` asks; elsewhere a real signal.
  test("stop mid-build parks both repos and releases locks", async () => {
    const s = setup();
    const run = groupAsync(s, ["run", "shop", "list the items", "--no-fast", "--max-rounds", "1"], { FAKE_SLOW: "3" });
    try {
      // Stop once each repo's foundation task wrote its file, so both have work to park.
      const ended = (path) => run.events().some((e) => e.type === "group_child" && e.repo === path && e.event.type === "task_end");
      await until(() => ended(s.be) && ended(s.fe), 120_000);
      if (process.platform === "win32") {
        const stop = spawnSync(process.execPath, [TSX, ORCH, "group", "stop", "shop"], { cwd: s.home, encoding: "utf8", env: envFor(s, {}) });
        assert.equal(stop.status, 0, stop.stderr);
      } else run.child.kill("SIGTERM");
      const { code, out } = await run.done;
      assert.equal(code, 130, out);
      assert.equal(head(s.be), s.heads.be);
      assert.equal(head(s.fe), s.heads.fe);
      for (const dir of [s.be, s.fe])
        assert.ok(
          branches(dir).some((b) => b.startsWith("orchestrator/interrupted-group-")),
          branches(dir).join(", "),
        );
      assert.deepEqual(locks(s), []);
      const end = run.events().at(-1);
      assert.equal(end.type, "group_end");
      assert.equal(end.reason, "Stopped");
    } finally {
      if (run.child.exitCode === null) run.child.kill();
      await run.done;
      clean(s);
    }
  });

  test("a usage limit in a child stops the group with exit 3", () => {
    const s = setup();
    try {
      const r = group(s, ["run", "shop", "list the items"], { FAKE_LIMIT_AFTER: "1" });
      assert.equal(r.code, 3, r.out);
      const end = r.ev("group_end").at(-1);
      assert.equal(end.ok, false);
      assert.equal(end.reason, "UsageLimit");
      assert.equal(head(s.be), s.heads.be);
      assert.equal(head(s.fe), s.heads.fe);
      assert.deepEqual(locks(s), []);
    } finally {
      clean(s);
    }
  });
});
