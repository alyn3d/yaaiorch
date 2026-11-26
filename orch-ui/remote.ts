// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Remote access: paired devices (a phone, through the Cloudflare tunnel) and what each may do.
 *
 * Pairing: the PC asks for a pairing code (random, single use, 5 minutes) and shows it in a QR link; the phone posts it
 * with a name and gets a pending request plus a poll secret; the PC allows or denies it; the phone's next poll (with that
 * secret) gets its device key as a cookie. Only a SHA-256 of each key is stored. New devices can only view; the PC
 * switches control on per device, and revokes devices.
 *
 * Roles: `view` reads everything (state, events, logs, history) and changes nothing; `control` may also start, stop,
 * approve and answer. Some routes stay on the PC whatever the role (PC_ONLY): anything that takes a path on the PC's
 * disk, writes agent files or runs setup scripts, changes the global limits, the remote access itself, and making a
 * command always allowed.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Role = "view" | "control";
export type Device = { id: string; name: string; role: Role; keyHash: string; agent: string; createdAt: number; lastSeen: number };
/** A device as the PC's UI sees it: never its key hash. */
export type DeviceInfo = Omit<Device, "keyHash">;
/** `before`: the role a device of the same name and browser had before the address changed (the PC may give it back). */
export type PairRequest = { id: string; name: string; agent: string; createdAt: number; before?: Role };
/** What is kept of a device once the tunnel's address changed and its key died with it: never the key. */
type Former = { name: string; agent: string; role: Role };

export const COOKIE = "yaai_device";
export const CODE_TTL = 5 * 60_000;
/** A pairing request the PC has not answered expires; so does an allowed one the phone never collected. */
export const REQUEST_TTL = 10 * 60_000;
export const COOKIE_MAX_AGE = 90 * 24 * 3600; // seconds; renewed while the device is used
const MAX_ATTEMPTS = 5; // wrong pairing codes per address per window
const MAX_ATTEMPTS_ALL = 20; // from all addresses together
const ATTEMPT_WINDOW = 10 * 60_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = (bytes = 32) => randomBytes(bytes).toString("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** A name or browser description as typed or sent: one line, printable, bounded. */
const clean = (s: unknown, max: number) =>
  [...String(s ?? "")]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c))
    .join("")
    .trim()
    .slice(0, max);

/** Routes no remote device may call, whatever its role. */
export const PC_ONLY = new Set([
  "/api/token",
  "/api/add-repo",
  "/api/remove-repo",
  "/api/new-project",
  "/api/reveal",
  "/api/agents", // POST writes an agent file
  "/api/group-save",
  "/api/group-remove",
  "/api/browser", // POST approves a script to run
  "/api/settings",
  "/api/clear-limit",
]);

/**
 * Why a remote device may not make this request, or null. `decision`: the body's decision for /api/decide-command
 * ("always" and "prefix" create permanent rules, so they stay on the PC).
 */
export function remoteRefusal(role: Role, method: string, path: string, decision?: unknown): string | null {
  if (path.startsWith("/api/remote")) return "remote access is managed on the PC";
  if (PC_ONLY.has(path) && (method !== "GET" || path === "/api/token")) return "only on the PC";
  if (method === "GET" || method === "HEAD") return null;
  if (role !== "control") return "this device can only view; allow control for it on the PC";
  if (path === "/api/decide-command" && decision !== "allow" && decision !== "deny") return "always-allow rules are made on the PC";
  return null;
}

/** The device cookie's value from a Cookie header. */
export function cookieValue(header: string | undefined, name = COOKIE): string | null {
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function deviceCookie(value: string, maxAge = COOKIE_MAX_AGE): string {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
}

type Pending = PairRequest & { pollHash: string; status: "waiting" | "allowed" | "denied"; ip: string; role?: Role };

export class Remote {
  devices: Device[] = [];
  /** Devices from before the last address change (name, browser, role), so re-pairing can offer the old role. */
  private former: Former[] = [];
  /** How many devices the last address change cut off; shown on the PC until a device pairs again. */
  cleared = 0;
  /** The tunnel address the devices were paired at (cookies only work there). */
  private address: string | null = null;
  private code: { hash: string; expires: number } | null = null;
  private pending = new Map<string, Pending>();
  private attempts = new Map<string, number[]>();
  private seenSaved = new Map<string, number>();

  constructor(
    private file: string,
    private now: () => number = Date.now,
  ) {
    try {
      if (existsSync(file)) {
        const d = JSON.parse(readFileSync(file, "utf8")) as { devices?: Device[]; former?: Former[]; address?: string };
        this.devices = (d.devices ?? []).filter(
          (x) => x && typeof x.id === "string" && typeof x.keyHash === "string" && (x.role === "view" || x.role === "control"),
        );
        this.former = (d.former ?? []).filter((x) => x && typeof x.name === "string" && (x.role === "view" || x.role === "control"));
        this.address = typeof d.address === "string" ? d.address : null;
      }
    } catch {
      this.devices = []; // unreadable: every device pairs again, which is the safe side
    }
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ address: this.address, devices: this.devices, former: this.former }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private sweep() {
    const t = this.now();
    if (this.code && this.code.expires <= t) this.code = null;
    for (const [id, p] of this.pending) if (t - p.createdAt > REQUEST_TTL) this.pending.delete(id);
  }

  /**
   * The tunnel now answers at `url`. A device's cookie belongs to the address it paired at, so at a new address every
   * device is cut off: they are dropped, and only their name, browser and role are kept for when they pair again.
   */
  addressChanged(url: string) {
    if (url === this.address) return;
    this.address = url;
    this.forget();
  }

  /**
   * Drop every device (their keys no longer work), keeping name, browser and role. The server calls it at every start:
   * remote access starts off, and the next tunnel gets a new address anyway.
   */
  forget() {
    // The note on the PC keeps counting the devices dropped at start until one pairs again.
    if (this.devices.length) this.cleared = this.devices.length;
    const key = (x: { name: string; agent: string }) => JSON.stringify([x.name, x.agent]);
    const kept = new Map(this.former.map((f) => [key(f), f]));
    for (const d of this.devices) kept.set(key(d), { name: d.name, agent: d.agent, role: d.role });
    this.former = [...kept.values()].slice(-20);
    this.devices = [];
    this.pending.clear();
    this.code = null;
    this.save();
  }

  /** A new pairing code (the previous one stops working). Goes into the QR link's fragment. */
  newCode(): string {
    const code = token(16);
    this.code = { hash: sha(code), expires: this.now() + CODE_TTL };
    return code;
  }

  private limited(ip: string): boolean {
    const t = this.now();
    const recent = (k: string) => (this.attempts.get(k) ?? []).filter((x) => t - x < ATTEMPT_WINDOW);
    return recent(ip).length >= MAX_ATTEMPTS || recent("*").length >= MAX_ATTEMPTS_ALL;
  }
  private failed(ip: string) {
    const t = this.now();
    for (const k of [ip, "*"]) this.attempts.set(k, [...(this.attempts.get(k) ?? []).filter((x) => t - x < ATTEMPT_WINDOW), t]);
  }

  /** The phone posts the code: a request for the PC to answer, and the secret to poll it with. */
  request(code: unknown, name: unknown, agent: unknown, ip: string): { id: string; poll: string } | { error: string } {
    this.sweep();
    if (this.limited(ip)) return { error: "too many attempts; try again in a few minutes" };
    if (typeof code !== "string" || !this.code || !same(sha(code), this.code.hash)) {
      this.failed(ip);
      return { error: "this pairing link is not valid any more; show a new one on the PC" };
    }
    this.code = null; // single use
    const id = token(9);
    const poll = token(24);
    this.pending.set(id, {
      id,
      name: clean(name, 40) || "Phone",
      agent: clean(agent, 160),
      createdAt: this.now(),
      pollHash: sha(poll),
      status: "waiting",
      ip,
    });
    return { id, poll };
  }

  /** Requests waiting for the PC. */
  requests(): PairRequest[] {
    this.sweep();
    return [...this.pending.values()]
      .filter((p) => p.status === "waiting")
      .map(({ id, name, agent, createdAt }) => {
        const before = this.former.find((f) => f.name === name && f.agent === agent)?.role;
        return { id, name, agent, createdAt, ...(before ? { before } : {}) };
      });
  }

  /** The PC's answer; `role`: what the device may do (view unless the PC says control). */
  decide(id: string, allow: boolean, role: Role = "view"): boolean {
    this.sweep();
    const p = this.pending.get(id);
    if (!p || p.status !== "waiting") return false;
    p.status = allow ? "allowed" : "denied";
    p.role = role === "control" ? "control" : "view";
    return true;
  }

  /** The phone polls: still waiting, denied, or allowed, and then (once) the cookie value for its new device. */
  status(id: unknown, poll: unknown): { status: "waiting" | "denied" | "unknown" } | { status: "allowed"; cookie: string; device: DeviceInfo } {
    this.sweep();
    const p = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!p || typeof poll !== "string" || !same(sha(poll), p.pollHash)) return { status: "unknown" };
    if (p.status === "waiting") return { status: "waiting" };
    this.pending.delete(id as string);
    if (p.status === "denied") return { status: "denied" };
    const key = token(32);
    const t = this.now();
    const device: Device = { id: token(9), name: p.name, role: p.role ?? "view", keyHash: sha(key), agent: p.agent, createdAt: t, lastSeen: t };
    this.devices.push(device);
    this.former = this.former.filter((f) => !(f.name === p.name && f.agent === p.agent));
    this.cleared = 0;
    this.save();
    return { status: "allowed", cookie: `${device.id}.${key}`, device: info(device) };
  }

  /** The device a cookie belongs to, or null. Notes when it was last seen (saved at most every 10 minutes). */
  authenticate(cookieHeader: string | undefined): Device | null {
    const v = cookieValue(cookieHeader);
    const dot = v?.indexOf(".") ?? -1;
    if (!v || dot < 1) return null;
    const d = this.devices.find((x) => x.id === v.slice(0, dot));
    if (!d || !same(sha(v.slice(dot + 1)), d.keyHash)) return null;
    d.lastSeen = this.now();
    if (d.lastSeen - (this.seenSaved.get(d.id) ?? 0) > 10 * 60_000) {
      this.seenSaved.set(d.id, d.lastSeen);
      this.save();
    }
    return d;
  }

  setRole(id: string, role: Role): boolean {
    const d = this.devices.find((x) => x.id === id);
    if (!d || (role !== "view" && role !== "control")) return false;
    d.role = role;
    this.save();
    return true;
  }

  revoke(id: string): boolean {
    const n = this.devices.length;
    this.devices = this.devices.filter((x) => x.id !== id);
    if (this.devices.length === n) return false;
    this.save();
    return true;
  }

  list(): DeviceInfo[] {
    return this.devices.map(info);
  }
}

const info = ({ id, name, role, agent, createdAt, lastSeen }: Device): DeviceInfo => ({ id, name, role, agent, createdAt, lastSeen });
