// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

// Keep the computer awake while orch runs (`--keep-awake`, config `keepAwake`), so a goal waiting out a usage limit
// carries on after the reset instead of finding the machine asleep.
//
// Only idle sleep is blocked: the screen may still turn off, and closing a laptop's lid or choosing Sleep still
// sleeps it. A small helper process holds the request; it watches orch's PID and ends with it, so a crashed orch
// never leaves the machine awake. Nothing here needs admin rights.
//   Windows: a hidden PowerShell calls SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED).
//   macOS:   caffeinate -i -w <pid>.
//   Linux:   systemd-inhibit --what=idle around a shell loop that ends with orch.
import { spawn } from "node:child_process";
import { resolveCommand } from "./claude-bin";

export type AwakeCommand = { file: string; args: string[] };

/** ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x1). */
const ES_FLAGS = 0x80000001;

/** The PowerShell script that holds the request while process `pid` lives (re-asserted every 30 s). */
export function windowsAwakeScript(pid: number): string {
  return [
    `$t = Add-Type -Name Awake -Namespace Yaaiorch -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
    `while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { [void]$t::SetThreadExecutionState([uint32]${ES_FLAGS}); Start-Sleep -Seconds 30 }`,
  ].join("\n");
}

/** What to spawn to keep this computer awake while process `pid` lives, or null where orch cannot. */
export function awakeCommand(pid: number, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): AwakeCommand | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "win32") {
    // The full path: never a powershell.exe found on PATH or in the repo. The script goes base64 (UTF-16LE), so no
    // quoting reaches the command line.
    const root = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    return {
      file: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsAwakeScript(pid), "utf16le").toString("base64")],
    };
  }
  if (platform === "darwin") return { file: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform === "linux") {
    const bin = resolveCommand("systemd-inhibit", env, platform);
    if (bin.missing) return null;
    return {
      file: bin.file,
      args: [
        "--what=idle",
        "--who=YAAIORCH",
        "--why=Agents are working",
        "--mode=block",
        "/bin/sh",
        "-c",
        `while kill -0 ${pid} 2>/dev/null; do sleep 30; done`,
      ],
    };
  }
  return null;
}

/**
 * Start keeping the computer awake until this process exits (or `stop` is called). Never throws: where it cannot,
 * it says so once and orch runs as before.
 */
export function keepAwake(log: (line: string) => void = console.log): { stop: () => void } {
  const cmd = awakeCommand(process.pid);
  if (!cmd) {
    log(`keep awake: not supported here (${process.platform}${process.platform === "linux" ? ", no systemd-inhibit" : ""}); the computer may sleep.`);
    return { stop: () => {} };
  }
  let stopped = false;
  const child = spawn(cmd.file, cmd.args, { stdio: "ignore", windowsHide: true });
  child.unref();
  const started = Date.now();
  child.on("error", (e) => {
    if (!stopped) log(`keep awake: could not start (${e.message}); the computer may sleep.`);
  });
  // A helper that ends on its own early failed (no logind on WSL, for one): say so rather than claim the opposite.
  child.on("exit", (code) => {
    if (!stopped && Date.now() - started < 60_000 && code !== 0) log(`keep awake: the helper exited (code ${code}); the computer may sleep.`);
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.off("exit", stop);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
  process.on("exit", stop);
  log("keeping this computer awake while orch runs (--keep-awake; the screen may still turn off).");
  return { stop };
}
