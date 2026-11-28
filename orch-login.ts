// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Logging a Claude profile in (`orch account --login`) and reading who it is logged in as (`orch account --json`).
 *
 * `claude auth login` needs a real terminal (it may ask questions and prints a link to open), so it runs in a terminal
 * window of its own: Windows through `cmd /c start`, macOS through Terminal (osascript), Linux through the first
 * terminal emulator found. The profile's folder goes in the environment (CLAUDE_CONFIG_DIR), never through a shell on
 * Windows; macOS and Linux name it in the command, since a terminal there may not pass the caller's environment on.
 * Pure helpers, bundled into orch.mjs and unit-tested.
 */
import type { ClaudeCmd } from "./claude-bin";

/** Who a Claude folder is logged in as. `loggedIn` null: the CLI's answer could not be read (an older CLI). */
export type AccountStatus = { loggedIn: boolean | null; email?: string; org?: string; plan?: string; method?: string };

/** `claude auth status --json` as the UI needs it; unknown fields are dropped, nothing else is passed on. */
export function parseAuthStatus(stdout: string): AccountStatus {
  const text = stdout.trim();
  let j: Record<string, unknown> | undefined;
  for (const candidate of [text, text.split(/\r?\n/).pop() ?? ""]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object") j = v;
      break;
    } catch {
      /* try the last line: some versions print a notice first */
    }
  }
  if (!j || typeof j.loggedIn !== "boolean") return { loggedIn: null };
  const str = (k: string) => (typeof j![k] === "string" && (j![k] as string).trim() ? (j![k] as string).trim().slice(0, 200) : undefined);
  const out: AccountStatus = { loggedIn: j.loggedIn };
  const email = str("email"),
    org = str("orgName"),
    plan = str("subscriptionType"),
    method = str("authMethod");
  if (email) out.email = email;
  if (org) out.org = org;
  if (plan) out.plan = plan;
  if (method) out.method = method;
  return out;
}

/** How to open the login terminal. `wait`: the launcher returns only once the login window closes (Windows). */
export type Launch = { file: string; args: string[]; verbatim?: boolean; wait: boolean };

/** Linux terminal emulators, in the order tried, with the flag after which the command's own argv follows. */
export const LINUX_TERMINALS: [string, string[]][] = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["xfce4-terminal", ["-x"]],
  ["alacritty", ["-e"]],
  ["kitty", []],
  ["xterm", ["-e"]],
];

/** POSIX shell single quotes. */
export const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command a person can type to log a profile in themselves, when no terminal could be opened. */
export function manualLogin(platform: NodeJS.Platform, configDir?: string): string {
  if (platform === "win32") return configDir ? `$env:CLAUDE_CONFIG_DIR = "${configDir}"; claude auth login` : "claude auth login";
  return configDir ? `CLAUDE_CONFIG_DIR=${shQuote(configDir)} claude auth login` : "claude auth login";
}

/**
 * The process that opens a terminal running `claude auth login` for `configDir` (undefined: the default folder).
 * `find` looks a name up on PATH (POSIX). Throws when this machine has no way to open one.
 */
export function loginTerminal(claude: ClaudeCmd, configDir: string | undefined, platform: NodeJS.Platform, find: (name: string) => string | null): Launch {
  if (platform === "win32") {
    // cmd.exe: inside quotes & | < > ^ are plain text, but % still expands and a " would end the quoting. Neither
    // occurs in a normal install path; refuse rather than guess. The folder travels in the environment.
    const parts = [claude.file.replace(/^"(.*)"$/, "$1"), ...claude.pre];
    const bad = parts.find((p) => /["%\r\n]/.test(p));
    if (bad) throw new Error(`cannot open a login window for ${bad}; run this in a terminal: ${manualLogin(platform, configDir)}`);
    const line = `start "Claude login" /wait ${parts.map((p) => `"${p}"`).join(" ")} auth login`;
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true, wait: true };
  }
  const file = claude.file.includes("/") ? claude.file : (find(claude.file) ?? claude.file);
  const argv = [...(configDir ? ["env", `CLAUDE_CONFIG_DIR=${configDir}`] : []), file, ...claude.pre, "auth", "login"];
  if (platform === "darwin") {
    const sh = `exec ${argv.map(shQuote).join(" ")}`;
    const script = `tell application "Terminal" to do script "${sh.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return { file: "osascript", args: ["-e", script, "-e", 'tell application "Terminal" to activate'], wait: false };
  }
  for (const [name, flag] of LINUX_TERMINALS) {
    const term = find(name);
    if (term) return { file: term, args: [...flag, ...argv], wait: false };
  }
  throw new Error(`no terminal emulator found; run this in a terminal: ${manualLogin(platform, configDir)}`);
}
