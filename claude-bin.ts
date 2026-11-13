// Find the `claude` executable once, so it can be spawned without a shell on Windows.
//
// Node cannot spawn a .cmd/.bat file without a shell, and going through cmd.exe means its quoting and
// metacharacter rules (&, |, ^, %) apply to the command line. So on Windows we look `claude` up on PATH
// ourselves: an .exe (the native installer) runs directly; an npm .cmd shim is read for the script it
// starts, which then runs with node directly. Only a shim we cannot read falls back to cmd.exe.
// On other platforms spawn() already resolves PATH and shebangs, so nothing changes there.
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

export type ClaudeCmd = {
  /** What to spawn. */
  file: string;
  /** Arguments that go before claude's own (the script, when a .cmd shim is unwrapped). */
  pre: string[];
  /** Spawn through the shell (Windows fallback only); `file` is then already quoted. */
  shell: boolean;
  /** Human-readable: how claude is started (for `orch doctor`). */
  via: string;
  /**
   * Windows only: not found on PATH. Callers must not spawn it, since both cmd.exe and Node's own lookup
   * would try the current directory (the target repo) first.
   */
  missing?: boolean;
};

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Where Windows would find `name`: a path is used as given, a bare name is searched on PATH (never the
 * current directory, unlike cmd.exe: the target repo must not be able to plant a `claude.cmd`). A name
 * without an extension gets PATHEXT's; an extensionless file (npm's POSIX shim next to claude.cmd) is skipped.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const own = extname(name).toLowerCase();
  const tries = exts.some((e) => e.toLowerCase() === own) ? [""] : exts.map((e) => e.toLowerCase());
  const hasDir = isAbsolute(name) || /[\\/]/.test(name);
  const dirs = hasDir
    ? [""]
    : (env.PATH ?? env.Path ?? "")
        .split(";")
        .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean);
  for (const dir of dirs)
    for (const ext of tries) {
      const p = hasDir ? resolve(name + ext) : join(dir, name + ext);
      if (isFile(p)) return p;
    }
  return undefined;
}

/**
 * The program a .cmd shim starts: npm's `"%dp0%\node_modules\...\cli.js" %*`, or `"%~dp0script.mjs" %*`.
 * Returns an absolute path to a script or an .exe, or undefined when the shim looks different.
 */
export function shimTarget(shim: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return undefined;
  }
  const found = [...text.matchAll(/"%(?:~dp0|dp0%)\\?([^"%*\r\n]+?\.(?:js|mjs|cjs|exe))"/gi)]
    .map((m) => join(dirname(shim), m[1].replace(/\\/g, "/")))
    .filter((p) => basename(p).toLowerCase() !== "node.exe" && isFile(p));
  return found.at(-1);
}

/** How to start any CLI found this way (for example `gh`); the same rules as for claude. */
export const resolveCommand = (bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeCmd =>
  resolveClaude(bin, env, platform);

/** How to start `bin` (CLAUDE_BIN or "claude") on this platform. */
export function resolveClaude(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): ClaudeCmd {
  if (platform !== "win32") return { file: bin, pre: [], shell: false, via: bin };
  const quoted = (p: string) => (/\s/.test(p) && !p.startsWith('"') ? `"${p}"` : p);
  const viaShell = (p: string, why: string): ClaudeCmd => ({ file: quoted(p), pre: [], shell: true, via: `cmd.exe (${why})` });
  const found = findOnPath(bin.replace(/^"(.*)"$/, "$1"), env);
  if (!found) return { file: bin, pre: [], shell: false, via: "not found on PATH", missing: true };
  const ext = extname(found).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { file: found, pre: [], shell: false, via: found };
  if (ext === ".cmd" || ext === ".bat") {
    const target = shimTarget(found);
    if (!target) return viaShell(found, "unrecognised shim");
    if (target.toLowerCase().endsWith(".exe")) return { file: target, pre: [], shell: false, via: target };
    // npm's shim prefers a node.exe next to it; otherwise the node running orch.
    const localNode = join(dirname(found), "node.exe");
    const node = isFile(localNode) ? localNode : process.execPath;
    return { file: node, pre: [target], shell: false, via: `${node} ${target}` };
  }
  return viaShell(found, `${ext || "no extension"}`);
}
