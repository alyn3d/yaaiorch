// Tests for repo groups: the config format (orch-group.ts via orch.ts), `orch group add|list|remove` and the run lock
// a group holds in each member repo (inherited by its children through ORCH_GROUP_LOCK).
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { tsxApi } from "./tsx.mjs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(root, "orch-ui", "node_modules", "tsx", "dist", "cli.mjs");
const ORCH = join(root, "orch.ts");
let o;

before(async () => {
  process.env.ORCH_NO_MAIN = "1";
  const { tsImport } = await tsxApi(root);
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
  test("groupServe: the group's serve, else the backend repo's config serve, else none", () => {
    const home = tmp();
    try {
      const bePath = join(home, "be");
      mkdirSync(join(bePath, ".orchestrator"), { recursive: true });
      const repos = (serve) => [
        { path: bePath, role: "backend", ...(serve ? { serve } : {}) },
        { path: fe, role: "frontend" },
      ];
      const own = o.validateGroup({
        name: "a",
        repos: repos({ command: "node s.js", url: "http://localhost:3000/health", baseUrl: "http://localhost:3000/api" }),
      });
      assert.deepEqual(o.groupServe(own), { command: "node s.js", url: "http://localhost:3000/health", baseUrl: "http://localhost:3000/api" });
      const plain = o.validateGroup({ name: "a", repos: repos() });
      assert.equal(o.groupServe(plain), undefined);
      writeFileSync(join(bePath, ".orchestrator", "config.json"), JSON.stringify({ serve: { command: "npm run dev", url: "http://localhost:4000" } }));
      assert.deepEqual(o.groupServe(plain), { command: "npm run dev", url: "http://localhost:4000" });
      writeFileSync(join(bePath, ".orchestrator", "config.json"), JSON.stringify({ serve: { command: "npm run dev", url: "https://example.com" } }));
      assert.throws(() => o.groupServe(plain), /backend repo's config "serve"/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
      assert.deepEqual(JSON.parse(list.stdout), [{ ...saved, dir: join(home, "groups", "shop") }]);
      // Saving again (the UI's Edit) keeps what only the file sets.
      writeFileSync(file, JSON.stringify({ ...saved, contract: "GET /items", integrationRounds: 3 }));
      const again = run(home, "add", "shop", "--repo", `${be}:backend`, "--repo", `${fe}:frontend`);
      assert.equal(again.code, 0, again.out);
      const resaved = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(resaved.contract, "GET /items");
      assert.equal(resaved.integrationRounds, 3);
      assert.equal(resaved.repos[0].serve, undefined, "the repos come from the new flags");
      const rm = run(home, "remove", "shop");
      assert.equal(rm.code, 0, rm.out);
      assert.equal(existsSync(file), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  test("add resolves relative --repo paths against the current directory", () => {
    const home = tmp();
    try {
      const r = spawnSync(process.execPath, [TSX, ORCH, "group", "add", "shop", "--repo", "be:backend", "--repo", join("sub", "fe") + ":frontend"], {
        cwd: home,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, ORCH_NO_MAIN: "", YAAIORCH_HOME: home, FORCE_COLOR: "0" },
      });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      const saved = JSON.parse(readFileSync(join(home, "groups", "shop.json"), "utf8"));
      assert.deepEqual(
        saved.repos.map((x) => x.path),
        [join(home, "be"), join(home, "sub", "fe")],
      );
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
      // A glob character would make the deny rule match other paths (or none): refused, as is a UNC path.
      for (const name of ["x[1]", "x{a}", "x!y", ...(process.platform === "win32" ? [] : ["x*", "x?"])]) {
        const odd = join(dirname(dir), `${basename(dir)}-${name}`);
        mkdirSync(odd);
        try {
          const r = run("--read-dir", odd);
          assert.notEqual(r.status, 0, name);
          assert.match(r.stderr, /--read-dir: .* has a character that permission rules read as a pattern/, name);
        } finally {
          rmSync(odd, { recursive: true, force: true });
        }
      }
      if (process.platform === "win32") {
        const unc = run("--read-dir", "\\\\localhost\\c$\\x");
        assert.notEqual(unc.status, 0);
        assert.match(unc.stderr, /--read-dir: .* is a network \(UNC\) path/);
      }
      // Spaces and parentheses are fine (the deny rules hold for them with the real CLI).
      const spaced = join(dirname(dir), `${basename(dir)}-a b (x)`);
      mkdirSync(spaced);
      try {
        const ok = run("--read-dir", spaced, "--dry-run");
        assert.doesNotMatch(ok.stderr, /--read-dir/);
      } finally {
        rmSync(spaced, { recursive: true, force: true });
      }
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

  test("park and reset refuse a checkpoint that does not exist or is not an ancestor of HEAD, before any commit", () =>
    withLock((dir, env) => {
      const gone = "orchestrator/group-checkpoint-nope";
      writeFileSync(join(dir, "a.txt"), "uncommitted");
      for (const args of [
        ["park", gone, "failed"],
        ["reset", gone],
      ]) {
        const r = member(dir, env, ...args);
        assert.notEqual(r.code, 0, args.join(" "));
        assert.match(r.out, /does not exist/);
      }
      const bad = member(dir, env, "reset", "0123456789abcdef0123456789abcdef01234567", "s9");
      assert.notEqual(bad.code, 0);
      assert.match(bad.out, /does not exist/);
      // A branch that is not behind HEAD: made on a side line, then back on main.
      git(dir, "switch", "-q", "-c", "side");
      git(dir, "commit", "-q", "--allow-empty", "-m", "side");
      git(dir, "branch", "orchestrator/group-checkpoint-side");
      git(dir, "switch", "-q", "main");
      git(dir, "commit", "-q", "--allow-empty", "-m", "main moves");
      for (const args of [
        ["park", "orchestrator/group-checkpoint-side", "failed"],
        ["reset", "orchestrator/group-checkpoint-side"],
        ["reset", git(dir, "rev-parse", "side"), "s9"],
      ]) {
        const r = member(dir, env, ...args);
        assert.notEqual(r.code, 0, args.join(" "));
        assert.match(r.out, /not an ancestor/);
      }
      // Nothing was committed or reset by any refusal.
      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "uncommitted");
      assert.match(git(dir, "status", "--porcelain"), /a\.txt/);
      assert.equal(git(dir, "log", "--format=%s", "-1"), "main moves");
    }));

  test("reset accepts a sha (full or abbreviated) with the stamp and parks everything after it", () =>
    withLock((dir, env) => {
      const start = git(dir, "rev-parse", "HEAD");
      writeFileSync(join(dir, "a.txt"), "x");
      git(dir, "add", "a.txt");
      git(dir, "commit", "-q", "-m", "work");
      const r = member(dir, env, "reset", start.slice(0, 10), "s7");
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(r.json, { parked: "orchestrator/discarded-group-s7" });
      assert.equal(git(dir, "rev-parse", "HEAD"), start);
      assert.equal(git(dir, "show", "orchestrator/discarded-group-s7:a.txt"), "x");
      const noStamp = member(dir, env, "reset", start);
      assert.notEqual(noStamp.code, 0);
      assert.match(noStamp.out, /stamp/);
      const badRef = member(dir, env, "reset", "main", "s8");
      assert.notEqual(badRef.code, 0);
    }));

  test("verify reports the commits after a sha and refuses a dirty tree", () =>
    withLock((dir, env) => {
      const start = git(dir, "rev-parse", "HEAD");
      git(dir, "commit", "-q", "--allow-empty", "-m", "more");
      const ok = member(dir, env, "verify", start);
      assert.equal(ok.code, 0, ok.out);
      assert.deepEqual(ok.json, { ahead: 1 });
      writeFileSync(join(dir, "d.txt"), "x");
      const dirty = member(dir, env, "verify", start);
      assert.notEqual(dirty.code, 0);
      assert.match(dirty.out, /uncommitted changes/);
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
  test("parseFaultCall keeps only the goals of the side(s) at fault", () => {
    assert.deepEqual(o.parseFaultCall(fence({ fault: "backend", goals: { backend: "b", frontend: "f" } })), { fault: "backend", goals: { backend: "b" } });
    assert.deepEqual(o.parseFaultCall(fence({ fault: "frontend", goals: { backend: "b", frontend: "f" } })).goals, { frontend: "f" });
    assert.deepEqual(o.parseFaultCall(fence({ fault: "both", goals: { backend: "b", frontend: "f" } })).goals, { backend: "b", frontend: "f" });
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

  test("the fault report goes through redactOutput before it reaches the prompt", () => {
    const s = setup();
    const prompts = join(s.home, "prompts");
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    try {
      const r = coordinate(s, "fault", { goal: "g", contract: "C", report: `request failed, key ${key} leaked`, briefs: {} }, { FAKE_PROMPTS: prompts });
      assert.equal(r.code, 0, r.out);
      const sent = readdirSync(prompts).map((f) => readFileSync(join(prompts, f), "utf8"));
      assert.equal(sent.length, 1);
      assert.match(sent[0], /request failed/);
      assert.doesNotMatch(sent[0], /AKIA/);
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

describe("group budget shares", () => {
  test("the build gets 60% of what is left, split over the repos that build", () => {
    assert.deepEqual(o.groupCostArgs(undefined), []);
    assert.deepEqual(o.groupCostArgs(0.5), ["--max-cost", "0.5000"]);
    // A share that rounds to $0.0000 is no budget at all (orch would read it as "no --max-cost" or refuse it).
    assert.throws(() => o.groupCostArgs(0.00004), /--max-cost is used up/);
    assert.equal(o.childShare(10, "build", 2, 1, 2), 3);
    assert.equal(o.childShare(10, "build", 1, 1, 2), 6);
  });
  test("integration and fix split what is left over the child steps still possible", () => {
    // Round 1 of 2: integration 1, fix 1, integration 2.
    assert.equal(o.childShare(9, "integration", 1, 1, 2), 3);
    // A fix in round 1 of 2: itself and integration 2, split over the repos it fixes.
    assert.equal(o.childShare(6, "fix", 2, 1, 2), 1.5);
    assert.equal(o.childShare(6, "fix", 1, 1, 2), 3);
    // The last integration gets all of it.
    assert.equal(o.childShare(5, "integration", 1, 2, 2), 5);
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
    return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout ?? "", events, ev: (t) => events.filter((e) => e.type === t) };
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
    return { child, done, events: () => parse(stdout), out: () => out };
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
          .filter((e) => e.step === "build")
          .map((e) => e.repo)
          .sort(),
        ["backend", "frontend"],
      );
      assert.match(r.out, /integration skipped/);
      assert.deepEqual(
        r.ev("group_step").filter((e) => e.step === "integration"),
        [r.ev("group_step").find((e) => e.step === "integration" && e.skipped === "no serve")],
        "integration skipped without a serve",
      );
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

  test("a park that fails keeps the group checkpoint, says so in group_end and last-run.json, and rollback recovers it", () => {
    const s = setup();
    const lock = join(s.fe, ".git", "index.lock");
    try {
      // Only the frontend builds: its fe task writes work, its failing be task leaves the lock there. With both repos
      // building, whichever failed first had the group kill the other mid-commit, which could leave a stale lock in
      // that repo too (a flaky test; the kill itself is a separate issue).
      const r = group(s, ["run", "shop", "list the items", "--no-fast", "--max-rounds", "1"], {
        FAKE_FAIL_AGENT: "be",
        FAKE_LOCK_REPO: s.fe,
        FAKE_GROUP_ONLY: "frontend",
      });
      assert.equal(r.code, 1, r.out);
      assert.ok(existsSync(lock), "the fake left the lock");
      const end = r.ev("group_end").at(-1);
      assert.equal(end.ok, false);
      assert.match(end.kept.frontend, /^orchestrator\/group-checkpoint-/, JSON.stringify(end));
      assert.equal(end.kept.backend, undefined, r.out);
      assert.equal(end.parked.frontend, undefined, "a failed park is not 'nothing to park'");
      assert.equal(end.parked.backend, null, "the backend did not build: nothing to park");
      assert.match(r.stdout, /orch group rollback shop/, "the recovery command is on stdout");
      const last = JSON.parse(readFileSync(join(s.gdir, "last-run.json"), "utf8"));
      assert.deepEqual(last.kept, end.kept);
      assert.ok(branches(s.fe).includes(end.kept.frontend));

      rmSync(lock);
      const back = group(s, ["rollback", "shop"]);
      assert.equal(back.code, 0, back.out);
      assert.equal(head(s.fe), s.heads.fe);
      assert.equal(head(s.be), s.heads.be, "the parked backend stays as it was");
      assert.deepEqual(
        branches(s.fe).filter((b) => /checkpoint/.test(b)),
        [],
      );
      assert.ok(
        branches(s.fe).some((b) => b.startsWith("orchestrator/discarded-group-")),
        branches(s.fe).join(", "),
      );
      assert.equal(JSON.parse(readFileSync(join(s.gdir, "last-run.json"), "utf8")).rolledBack, true);
      assert.deepEqual(locks(s), []);
    } finally {
      rmSync(lock, { force: true });
      clean(s);
    }
  });

  test("a write into the other repo fails the group, naming the file; both repos end clean after parking", () => {
    const s = setup();
    try {
      // Only the backend builds; its agent also writes into the frontend repo (as a script would, past the deny rules).
      const r = group(s, ["run", "shop", "list the items"], { FAKE_LEAK: "dev", FAKE_GROUP_ONLY: "backend" });
      assert.equal(r.code, 1, r.out);
      assert.ok(existsSync(join(s.home, "fake.log")), r.out);
      assert.match(readFileSync(join(s.home, "fake.log"), "utf8"), /dev: leaked into/, r.out);
      const end = r.ev("group_end").at(-1);
      assert.equal(end.ok, false);
      assert.match(end.reason, /frontend: leaked-by-dev\.txt/, end.reason);
      for (const [dir, start] of [
        [s.be, s.heads.be],
        [s.fe, s.heads.fe],
      ]) {
        assert.equal(head(dir), start);
        assert.equal(git(dir, "status", "--porcelain", "--", ".", ":!.orchestrator"), "", dir);
      }
      assert.match(end.parked.frontend, /^orchestrator\/failed-group-/);
      assert.match(git(s.fe, "show", "--stat", "--format=", end.parked.frontend), /leaked-by-dev\.txt/);
      assert.deepEqual(locks(s), []);
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
  refused(
    "a member path with a pattern character",
    (s) => {
      const odd = join(s.home, "fe[1]");
      initRepo(odd);
      const g = JSON.parse(readFileSync(join(s.home, "groups", "shop.json"), "utf8"));
      g.repos[1].path = odd;
      writeFileSync(join(s.home, "groups", "shop.json"), JSON.stringify(g));
    },
    /fe\[1\] has a character that permission rules read as a pattern/,
  );

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
      const waits = run.events().filter((e) => e.type === "group_approval_wait");
      assert.deepEqual(
        waits.map((e) => e.round),
        [1, 2],
      );
      assert.equal(waits[0].contract, "GET /api/items → Item[]");
      assert.deepEqual(
        run
          .events()
          .filter((e) => e.type === "group_approval")
          .map((e) => [e.round, e.action]),
        [
          [1, "reject"],
          [2, "approve"],
        ],
      );
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

  test("stop and approve refuse a group name outside the groups dir and write nothing", () => {
    const s = setup();
    try {
      // ../x resolves to <home>/x: make it look like a running group waiting for approval.
      const outside = join(s.home, "x");
      mkdirSync(outside);
      writeFileSync(join(outside, "run.lock"), "{}");
      writeFileSync(join(outside, "plan-pending.json"), JSON.stringify({ round: 1 }));
      const cli = (...args) => spawnSync(process.execPath, [TSX, ORCH, ...args], { cwd: s.home, encoding: "utf8", env: envFor(s, {}) });
      const stop = cli("group", "stop", "../x");
      assert.notEqual(stop.status, 0, stop.stdout);
      assert.match(stop.stderr, /group name must match/);
      const approve = cli("approve", "--group", "../x");
      assert.notEqual(approve.status, 0, approve.stdout);
      assert.match(approve.stderr, /group name must match/);
      assert.deepEqual(readdirSync(outside).sort(), ["plan-pending.json", "run.lock"]);
    } finally {
      clean(s);
    }
  });

  test("a stop while parking does not kill the park", async () => {
    const s = setup();
    const run = groupAsync(s, ["run", "shop", "list the items", "--no-fast", "--max-rounds", "1"], { FAKE_FAIL_AGENT: "be" });
    try {
      // "group run failed" is printed right before the repos are parked: stop then, so the stop lands mid-park.
      await until(() => /group run failed/.test(run.out()), 180_000);
      writeFileSync(join(s.gdir, "stop"), "now");
      const { code, out } = await run.done;
      assert.equal(code, 1, out);
      assert.match(out, /stop noted/, "the stop landed while parking");
      assert.doesNotMatch(out, /could not park/);
      for (const [dir, start] of [
        [s.be, s.heads.be],
        [s.fe, s.heads.fe],
      ]) {
        assert.equal(head(dir), start, out);
        assert.deepEqual(
          branches(dir).filter((b) => /checkpoint/.test(b)),
          [],
          out,
        );
      }
      assert.ok(branches(s.be).some((b) => b.startsWith("orchestrator/failed-group-")));
      assert.deepEqual(locks(s), []);
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

  // ---------- integration against the running backend ----------
  const freePort = () =>
    new Promise((ok, fail) => {
      const srv = createServer();
      srv.once("error", fail);
      srv.listen(0, () => {
        const { port } = srv.address();
        srv.close(() => ok(port));
      });
    });
  const answers = async (url) => {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  };
  const BACKEND = join(root, "test", "fixtures", "group-backend.mjs");
  /** setup() plus a backend serve (the fixture on a free port, unless `command` is given) and a frontend whose check needs API_URL. */
  const setupServe = async ({ command, timeout, external } = {}) => {
    const s = setup();
    const port = await freePort();
    const url = `http://localhost:${port}`;
    writeFileSync(
      join(s.home, "groups", "shop.json"),
      JSON.stringify({
        name: "shop",
        repos: [
          {
            path: s.be,
            role: "backend",
            serve: { ...(external ? {} : { command: command ?? `node "${BACKEND}" ${port}` }), url, ...(timeout ? { timeout } : {}) },
          },
          { path: s.fe, role: "frontend", env: { API_URL: "{backend}" } },
        ],
      }),
    );
    mkdirSync(join(s.fe, ".orchestrator"), { recursive: true });
    writeFileSync(
      join(s.fe, ".orchestrator", "config.json"),
      JSON.stringify({ checks: { env: `node -e "process.exit(process.env.API_URL==='${url}'?0:1)"` } }),
    );
    return { ...s, port, url };
  };
  const steps = (r, step) => r.ev("group_step").filter((e) => e.step === step);

  test("env reaches the frontend checks", async () => {
    const s = await setupServe();
    try {
      const r = group(s, ["run", "shop", "list the items", "--max-rounds", "1"]);
      assert.equal(r.code, 0, r.out);
      assert.equal(r.ev("group_end").at(-1).ok, true);
      const integ = steps(r, "integration");
      assert.equal(integ.length, 1, r.out);
      assert.equal(integ[0].repo, "frontend");
      assert.equal(integ[0].round, 1);
      // The integration child's checks ran with API_URL set to the backend's base URL.
      const at = r.events.indexOf(integ[0]);
      const checks = r.events.slice(at).filter((e) => e.type === "group_child" && e.repo === s.fe && e.event.type === "checks");
      assert.ok(checks.length, r.out);
      for (const c of checks)
        assert.ok(
          c.event.results.every((x) => x.ok),
          JSON.stringify(c.event),
        );
      assert.equal(await answers(s.url), false, "the backend server is stopped when the group ends");
      assert.deepEqual(locks(s), []);
    } finally {
      clean(s);
    }
  });

  test("integration agents call the running backend through the probe tool, and only that backend", async () => {
    const s = await setupServe();
    try {
      // QA asks the backend; the frontend implementer tries another origin. Build children have no probe tool.
      const r = group(s, ["run", "shop", "list the items", "--max-rounds", "1"], { FAKE_PROBE: "qa=/api/items?max=10;fe=http://example.com/x" });
      assert.equal(r.code, 0, r.out);
      const log = readFileSync(join(s.home, "fake.log"), "utf8").split("\n");
      const probes = log.filter((l) => /: probe /.test(l));
      assert.ok(
        probes.some(
          (l) => l.startsWith("qa: probe allowed=mcp__probe__request GET") && l.includes(`${s.url}/api/items?max=10 | HTTP 200`) && l.endsWith("| ok"),
        ),
        probes.join("\n"),
      );
      assert.ok(
        probes.some((l) => l.startsWith("fe: probe allowed=mcp__probe__request error only the backend at")),
        probes.join("\n"),
      );
      assert.ok(
        probes.some((l) => l === "qa: probe none"),
        "the build step's QA has no probe tool",
      );
      // The integration goal asks for live checks through the tool.
      const integ = r.events.find(
        (e) => e.type === "group_child" && e.repo === s.fe && e.event.type === "goal_start" && /Verify the frontend/.test(e.event.goal),
      );
      assert.match(integ.event.goal, /mcp__probe__request/);
      assert.match(integ.event.goal, /could not check live is a failure/);
      assert.deepEqual(
        readdirSync(join(s.fe, ".orchestrator")).filter((f) => f.startsWith("probe-")),
        [],
        "the per-call MCP config files are removed",
      );
    } finally {
      clean(s);
    }
  });

  test("backend fault then pass", async () => {
    const s = await setupServe();
    try {
      const r = group(s, ["run", "shop", "list the items", "--max-rounds", "1"], { FAKE_QA_FAIL_INTEGRATION: "1", FAKE_GROUP_FAULT: "backend" });
      assert.equal(r.code, 0, r.out);
      const fix = steps(r, "fix");
      assert.deepEqual(
        fix.map((e) => [e.repo, e.round]),
        [["backend", 1]],
      );
      const integ = steps(r, "integration");
      assert.deepEqual(
        integ.map((e) => e.round),
        [1, 2],
      );
      assert.ok(r.events.indexOf(fix[0]) < r.events.indexOf(integ[1]));
      assert.equal(r.ev("group_end").at(-1).ok, true);
      assert.equal(await answers(s.url), false, "the backend server is stopped when the group ends");
    } finally {
      clean(s);
    }
  });

  test("goals that start with a dash reach the build and fix children as goals, not flags", async () => {
    const s = await setupServe();
    try {
      const r = group(s, ["run", "shop", "list the items", "--max-rounds", "1"], {
        FAKE_GROUP_BULLETS: "1",
        FAKE_QA_FAIL_INTEGRATION: "1",
        FAKE_GROUP_FAULT: "backend",
      });
      assert.equal(r.code, 0, r.out);
      const starts = r.ev("group_child").filter((e) => e.event.type === "goal_start");
      const goals = starts.map((e) => `${e.role}: ${e.event.goal}`);
      assert.ok(goals.includes("backend: - serve GET /api/items"), goals.join("\n"));
      assert.ok(goals.includes("frontend: - show the items from GET /api/items"), goals.join("\n"));
      assert.ok(goals.includes("backend: - fix the backend so it matches the contract"), goals.join("\n"));
      assert.equal(r.ev("group_end").at(-1).ok, true);
    } finally {
      clean(s);
    }
  });

  test("revised contract rewritten", async () => {
    const s = await setupServe();
    try {
      const r = group(s, ["run", "shop", "list the items", "--max-rounds", "1"], {
        FAKE_QA_FAIL_INTEGRATION: "1",
        FAKE_GROUP_FAULT: "backend",
        FAKE_GROUP_REVISE: "1",
      });
      assert.equal(r.code, 0, r.out);
      for (const dir of [s.be, s.fe]) assert.match(readFileSync(join(dir, ".orchestrator", "contract.md"), "utf8"), /REVISED/);
      assert.match(readFileSync(join(s.gdir, "contract.md"), "utf8"), /REVISED/);
      assert.match(readFileSync(join(s.gdir, "context-backend.md"), "utf8"), /REVISED/);
      const revised = r.ev("group_plan").filter((e) => e.revised);
      assert.equal(revised.length, 1);
      assert.equal(revised[0].contract, "REVISED");
    } finally {
      clean(s);
    }
  });

  test("rounds exhausted parks both", async () => {
    const s = await setupServe();
    try {
      const r = group(s, ["run", "shop", "list the items", "--max-rounds", "1"], { FAKE_QA_FAIL_INTEGRATION: "9" });
      assert.equal(r.code, 1, r.out);
      assert.deepEqual(
        steps(r, "integration").map((e) => e.round),
        [1, 2],
      );
      // The fake's default fault is the frontend's; no fix after the last round.
      assert.deepEqual(
        steps(r, "fix").map((e) => [e.repo, e.round]),
        [["frontend", 1]],
      );
      assert.equal(head(s.be), s.heads.be);
      assert.equal(head(s.fe), s.heads.fe);
      for (const dir of [s.be, s.fe])
        assert.ok(
          branches(dir).some((b) => b.startsWith("orchestrator/failed-group-")),
          branches(dir).join(", "),
        );
      assert.equal(r.ev("group_end").at(-1).ok, false);
      const reason = r.ev("group_end").at(-1).reason;
      assert.match(reason, /^integration failed after 2 rounds: The frontend's integration run failed \(exit code \d+\)\.$/);
      assert.equal(JSON.parse(readFileSync(join(s.gdir, "last-run.json"), "utf8")).reason, reason);
      assert.deepEqual(locks(s), []);
    } finally {
      clean(s);
    }
  });

  /** The fixture backend on the group's port, started by the test (not the group): resolves once it answers. */
  const startOwnBackend = async (s) => {
    const p = spawn(process.execPath, [BACKEND, String(s.port)], { stdio: "ignore" });
    const end = Date.now() + 15_000;
    while (!(await answers(s.url))) {
      if (Date.now() > end) throw new Error("the test's own backend did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
    return p;
  };

  test("a server the group did not start already answering at serve.url fails integration", async () => {
    const s = await setupServe();
    const prompts = join(s.home, "prompts");
    const own = await startOwnBackend(s);
    try {
      const run = groupAsync(s, ["run", "shop", "list the items", "--max-rounds", "1"], { FAKE_PROMPTS: prompts });
      const { code, out } = await run.done;
      assert.equal(code, 1, out);
      const end = run.events().at(-1);
      assert.equal(end.type, "group_end");
      assert.match(end.reason, /something already answers at http:\/\/localhost:\d+; stop it so the group can start the backend it just built/);
      const integ = run.events().filter((e) => e.type === "group_step" && e.step === "integration");
      assert.equal(integ.length, 1, out);
      assert.match(integ[0].failed, /something already answers/);
      assert.ok(!run.events().some((e) => e.type === "group_child" && e.event.goal?.startsWith("Verify")), "no integration child ran");
      const faults = readdirSync(prompts)
        .map((f) => readFileSync(join(prompts, f), "utf8"))
        .filter((p) => p.includes("Integration failed"));
      assert.equal(faults.length, 0, "no fault call");
      for (const [dir, start] of [
        [s.be, s.heads.be],
        [s.fe, s.heads.fe],
      ]) {
        assert.equal(head(dir), start);
        assert.ok(
          branches(dir).some((b) => b.startsWith("orchestrator/failed-group-")),
          branches(dir).join(", "),
        );
      }
      assert.deepEqual(locks(s), []);
    } finally {
      own.kill();
      clean(s);
    }
  });

  test("without serve.command an answering backend is used (external), but a backend fix cannot be verified on it", async () => {
    const s = await setupServe({ external: true });
    const own = await startOwnBackend(s);
    try {
      const pass = groupAsync(s, ["run", "shop", "list the items", "--max-rounds", "1"]);
      const ok = await pass.done;
      assert.equal(ok.code, 0, ok.out);
      assert.match(ok.out, /warning: .*not started by the group/);
      const integ = pass.events().filter((e) => e.type === "group_step" && e.step === "integration");
      assert.equal(integ.length, 1, ok.out);
      assert.equal(integ[0].external, true);

      const run = groupAsync(s, ["run", "shop", "list the items again", "--max-rounds", "1"], { FAKE_QA_FAIL_INTEGRATION: "1", FAKE_GROUP_FAULT: "backend" });
      const { code, out } = await run.done;
      assert.equal(code, 1, out);
      const end = run.events().at(-1);
      assert.equal(end.reason, "backend changed; restart your backend and rerun");
      assert.deepEqual(
        run
          .events()
          .filter((e) => e.type === "group_step" && e.step === "integration")
          .map((e) => e.round),
        [1],
        "no integration against the stale server",
      );
      assert.ok(await answers(s.url), "the group never stops a server it did not start");
      assert.deepEqual(locks(s), []);
    } finally {
      own.kill();
      clean(s);
    }
  });

  test("backend that never answers fails integration", async () => {
    const s = await setupServe({ command: 'node -e "setTimeout(()=>{},1e9)"', timeout: 2 });
    const prompts = join(s.home, "prompts");
    try {
      const r = group(s, ["run", "shop", "list the items", "--max-rounds", "1"], { FAKE_PROMPTS: prompts });
      assert.equal(r.code, 1, r.out);
      const faults = readdirSync(prompts)
        .map((f) => readFileSync(join(prompts, f), "utf8"))
        .filter((p) => p.startsWith("You are the group coordinator.") && p.includes("Integration failed"));
      assert.equal(faults.length, 1, r.out);
      assert.match(faults[0], /did not answer/);
      assert.doesNotMatch(faults[0], /API_URL/, "no env in the report");
      assert.equal(r.ev("group_end").at(-1).ok, false);
      assert.deepEqual(locks(s), []);
    } finally {
      clean(s);
    }
  });
});

describe("orch group rollback", { timeout: 600_000 }, () => {
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
  const group = (s, args, env = {}) => {
    const r = spawnSync(process.execPath, [TSX, ORCH, "group", ...args], {
      cwd: s.home,
      encoding: "utf8",
      timeout: 240_000,
      env: { ...process.env, ORCH_NO_MAIN: "", YAAIORCH_HOME: s.home, CLAUDE_BIN: FAKE, FORCE_COLOR: "0", FAKE_QA: "pass", ...env },
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const discarded = (dir) => git(dir, "branch", "--list", "orchestrator/discarded-group-*", "--format=%(refname:short)").split("\n").filter(Boolean);
  const lastRun = (s) => JSON.parse(readFileSync(join(s.gdir, "last-run.json"), "utf8"));
  const ran = (s) => {
    const r = group(s, ["run", "shop", "list the items"]);
    assert.equal(r.code, 0, r.out);
  };
  const clean = (s) => rmSync(s.home, { recursive: true, force: true });

  test("rollback after pass", () => {
    const s = setup();
    try {
      ran(s);
      assert.notEqual(git(s.be, "rev-parse", "HEAD"), s.heads.be);
      const r = group(s, ["rollback", "shop"]);
      assert.equal(r.code, 0, r.out);
      assert.equal(git(s.be, "rev-parse", "HEAD"), s.heads.be);
      assert.equal(git(s.fe, "rev-parse", "HEAD"), s.heads.fe);
      for (const dir of [s.be, s.fe]) {
        const [parked] = discarded(dir);
        assert.ok(parked, `${dir} has a discarded-group branch`);
        assert.ok(r.out.includes(`reset --hard ${parked}`), r.out);
      }
      assert.equal(lastRun(s).rolledBack, true);
      for (const f of [join(s.be, ".orchestrator", "run.lock"), join(s.fe, ".orchestrator", "run.lock"), join(s.gdir, "run.lock")])
        assert.equal(existsSync(f), false, f);
      const again = group(s, ["rollback", "shop"]);
      assert.equal(again.code, 1, again.out);
      assert.match(again.out, /already rolled back/);
    } finally {
      clean(s);
    }
  });

  test("rollback says what else it parks after the user's own later commits", () => {
    const s = setup();
    try {
      ran(s);
      git(s.fe, "commit", "-q", "--allow-empty", "-m", "my own commit");
      const r = group(s, ["rollback", "shop"]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /frontend: .*2 commit\(s\)/);
      assert.match(r.out, /made after the group run/i);
      assert.equal(git(s.fe, "rev-parse", "HEAD"), s.heads.fe);
    } finally {
      clean(s);
    }
  });

  test("a run that never finished (hard kill): rollback resets each repo to its group checkpoint, dirty or not", () => {
    const s = setup();
    try {
      const stamp = "20261119-000000-abcd";
      mkdirSync(s.gdir, { recursive: true });
      const started = { goal: "g", stamp, checkpoints: { backend: s.heads.be, frontend: s.heads.fe }, started: 1 };
      writeFileSync(join(s.gdir, "last-run.json"), JSON.stringify(started));
      // Without its checkpoint branches there is nothing to go back to.
      const nothing = group(s, ["rollback", "shop"]);
      assert.equal(nothing.code, 1, nothing.out);
      assert.match(nothing.out, /nothing to roll back/);
      for (const dir of [s.be, s.fe]) git(dir, "branch", `orchestrator/group-checkpoint-${stamp}`);
      writeFileSync(join(s.be, "half.txt"), "committed half way");
      git(s.be, "add", "half.txt");
      git(s.be, "commit", "-q", "-m", "half");
      writeFileSync(join(s.fe, "stray.txt"), "uncommitted when the run died");
      const r = group(s, ["rollback", "shop"]);
      assert.equal(r.code, 0, r.out);
      for (const [dir, start] of [
        [s.be, s.heads.be],
        [s.fe, s.heads.fe],
      ]) {
        assert.equal(git(dir, "rev-parse", "HEAD"), start);
        assert.equal(git(dir, "status", "--porcelain"), "");
        assert.deepEqual(discarded(dir), [`orchestrator/discarded-group-${stamp}`]);
        assert.equal(git(dir, "branch", "--list", "orchestrator/group-checkpoint-*"), "");
      }
      assert.equal(lastRun(s).rolledBack, true);
    } finally {
      clean(s);
    }
  });

  test("rollback refuses: no last run, a failed run, a dirty repo, a held lock, a start sha off the branch", () => {
    const s = setup();
    try {
      const none = group(s, ["rollback", "shop"]);
      assert.equal(none.code, 1);
      assert.match(none.out, /no last run/);
      mkdirSync(s.gdir, { recursive: true });
      writeFileSync(join(s.gdir, "last-run.json"), JSON.stringify({ ok: false, checkpoints: { backend: s.heads.be, frontend: s.heads.fe } }));
      const failed = group(s, ["rollback", "shop"]);
      assert.equal(failed.code, 1);
      assert.match(failed.out, /failed/);
      rmSync(s.gdir, { recursive: true, force: true });

      ran(s);
      const after = { be: git(s.be, "rev-parse", "HEAD"), fe: git(s.fe, "rev-parse", "HEAD") };
      writeFileSync(join(s.fe, "dirty.txt"), "x");
      const dirty = group(s, ["rollback", "shop"]);
      assert.equal(dirty.code, 1, dirty.out);
      assert.match(dirty.out, /uncommitted changes/);
      rmSync(join(s.fe, "dirty.txt"));
      assert.equal(git(s.be, "rev-parse", "HEAD"), after.be, "the clean repo was not reset when the other refused");

      const id = o.acquireRunLock("held", s.fe);
      try {
        const locked = group(s, ["rollback", "shop"]);
        assert.equal(locked.code, 1, locked.out);
      } finally {
        o.releaseRunLock(id, s.fe);
      }
      assert.equal(git(s.be, "rev-parse", "HEAD"), after.be);

      // A start sha that is not behind the frontend's HEAD (a commit on a side line).
      git(s.fe, "switch", "-q", "-c", "side", s.heads.fe);
      git(s.fe, "commit", "-q", "--allow-empty", "-m", "side");
      const side = git(s.fe, "rev-parse", "HEAD");
      git(s.fe, "switch", "-q", "main");
      const lr = lastRun(s);
      lr.checkpoints.frontend = side;
      writeFileSync(join(s.gdir, "last-run.json"), JSON.stringify(lr));
      const off = group(s, ["rollback", "shop"]);
      assert.equal(off.code, 1, off.out);
      assert.match(off.out, /not an ancestor/);
      assert.equal(git(s.be, "rev-parse", "HEAD"), after.be, "nothing reset when one repo refuses");
      assert.equal(lastRun(s).rolledBack, undefined);
    } finally {
      clean(s);
    }
  });
});
