// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

/**
 * The Cloudflare quick tunnel that makes the server reachable from a phone: `cloudflared tunnel --url
 * http://127.0.0.1:<port>`, which prints a random https://<name>.trycloudflare.com address. No Cloudflare account.
 *
 * cloudflared (Apache-2.0) is not bundled: the first time remote access is turned on it is downloaded from the pinned
 * GitHub release into ~/.yaaiorch/bin and checked against the SHA-256 below, which GitHub computed for that release's
 * file. A quick tunnel gets a new address whenever cloudflared restarts; paired phones then need a new QR scan.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const CLOUDFLARED_VERSION = "2026.11.2";
type Asset = { name: string; sha256: string; archive?: "tgz" };
/** Per `${platform}-${arch}`. Windows on arm64 runs the x64 build. */
export const CLOUDFLARED_ASSETS: Record<string, Asset> = {
  "win32-x64": { name: "cloudflared-windows-amd64.exe", sha256: "555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113" },
  "win32-arm64": { name: "cloudflared-windows-amd64.exe", sha256: "555b46c85582461d189cac30d14ad05480d612613801be9f110b8ce08c5b2113" },
  "darwin-x64": { name: "cloudflared-darwin-amd64.tgz", sha256: "6153d9ec629174882a3adbff2f7dc5a24b4f3bdd7ccc38eaa84fba26eb890311", archive: "tgz" },
  "darwin-arm64": { name: "cloudflared-darwin-arm64.tgz", sha256: "f6d58eeec91ad1ec5fd1f7e4a587303772929b2625be5d24068033851c36ff55", archive: "tgz" },
  "linux-x64": { name: "cloudflared-linux-amd64", sha256: "56f13335143ec0e22772963290683a84a04114a35ec64cbc794a4d39ff9bb8cf" },
  "linux-arm64": { name: "cloudflared-linux-arm64", sha256: "04a7b7f08bce85d56b26ffe1fdbfbb21a074495a363d16f0783c40e25b5c5281" },
};

export const assetFor = (platform: string = process.platform, arch: string = process.arch): Asset | null => CLOUDFLARED_ASSETS[`${platform}-${arch}`] ?? null;

/** The tunnel's address in a line of cloudflared's output. */
export function tunnelUrl(line: string): string | null {
  return /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/.exec(line)?.[0] ?? null;
}

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * The cloudflared executable in `dir` (downloaded and checked first if missing). `CLOUDFLARED_BIN` overrides it (tests,
 * or a cloudflared you installed yourself).
 */
export async function ensureCloudflared(dir: string, log: (s: string) => void = () => {}): Promise<string> {
  if (process.env.CLOUDFLARED_BIN) return process.env.CLOUDFLARED_BIN;
  const asset = assetFor();
  if (!asset) throw new Error(`no cloudflared build for ${process.platform}-${process.arch}`);
  const exe = join(dir, `cloudflared-${CLOUDFLARED_VERSION}${process.platform === "win32" ? ".exe" : ""}`);
  if (existsSync(exe)) return exe;
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset.name}`;
  log(`downloading cloudflared ${CLOUDFLARED_VERSION} (about 50 MB)…`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`could not download cloudflared (${res.status} ${res.statusText})`);
  const part = join(dir, `${asset.name}.part`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  const got = sha256File(part);
  if (got !== asset.sha256) {
    rmSync(part, { force: true });
    throw new Error(`cloudflared download does not match its checksum (got ${got}); not using it`);
  }
  if (asset.archive === "tgz") {
    const out = join(dir, `cloudflared-${CLOUDFLARED_VERSION}-x`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    execFileSync("tar", ["-xzf", part, "-C", out]);
    renameSync(join(out, "cloudflared"), exe);
    rmSync(out, { recursive: true, force: true });
    rmSync(part, { force: true });
  } else renameSync(part, exe);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  return exe;
}

export type TunnelState = { status: "off" | "downloading" | "starting" | "on" | "error"; url?: string; error?: string };

/** One quick tunnel to a local port, restarted (with a new address) if cloudflared exits on its own. */
export class Tunnel {
  state: TunnelState = { status: "off" };
  private child: ChildProcess | null = null;
  private wanted = false;
  private restarts = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private binDir: string,
    private onChange: (s: TunnelState) => void,
    private log: (s: string) => void = () => {},
  ) {}

  private set(s: TunnelState) {
    this.state = s;
    this.onChange(s);
  }

  get host(): string | null {
    return this.state.status === "on" && this.state.url ? new URL(this.state.url).host : null;
  }

  async start(port: number) {
    if (this.wanted) return;
    this.wanted = true;
    this.restarts = 0;
    await this.spawn(port);
  }

  private async spawn(port: number) {
    let exe: string;
    try {
      this.set({ status: "downloading" });
      exe = await ensureCloudflared(this.binDir, this.log);
    } catch (e) {
      this.wanted = false;
      return this.set({ status: "error", error: (e as Error).message });
    }
    if (!this.wanted) return this.set({ status: "off" });
    this.set({ status: "starting" });
    // --no-autoupdate: the pinned build stays; quick tunnels need no config or login.
    const args = ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`];
    // A .mjs stand-in (the tests' fake cloudflared) runs with this Node.
    const [file, argv] = exe.endsWith(".mjs") ? [process.execPath, [exe, ...args]] : [exe, args];
    const child = spawn(file, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    const tail: string[] = [];
    const read = (d: Buffer) => {
      for (const line of String(d).split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 8) tail.shift();
        const url = tunnelUrl(line);
        if (url && this.state.status !== "on") {
          this.restarts = 0;
          this.set({ status: "on", url });
        }
      }
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", (e) => this.set({ status: "error", error: `could not start cloudflared: ${e.message}` }));
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      if (!this.wanted) return this.set({ status: "off" });
      if (++this.restarts > 5) {
        this.wanted = false;
        return this.set({ status: "error", error: `cloudflared keeps stopping (exit ${code}): ${tail.slice(-3).join(" | ")}` });
      }
      this.set({ status: "starting" });
      this.timer = setTimeout(() => void this.spawn(port), Math.min(30_000, 1000 * 2 ** this.restarts));
    });
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.timer);
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) c.kill();
    this.set({ status: "off" });
  }
}
