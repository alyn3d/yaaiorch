// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from "react";
import { Qr } from "./Qr";
import { transport } from "./transport";
import type { RemoteStatus } from "./types";

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
/** "Chrome on Android" from a user agent, for the PC to recognise the phone asking. */
export function deviceKind(agent: string): string {
  const os = /iPhone|iPad/.test(agent)
    ? "iOS"
    : /Android/.test(agent)
      ? "Android"
      : /Windows/.test(agent)
        ? "Windows"
        : /Mac OS/.test(agent)
          ? "macOS"
          : /Linux/.test(agent)
            ? "Linux"
            : "";
  const browser = /EdgA?\//.test(agent)
    ? "Edge"
    : /Firefox|FxiOS/.test(agent)
      ? "Firefox"
      : /CriOS|Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "";
  return [browser, os].filter(Boolean).join(" on ") || "unknown browser";
}

/** Pairing requests waiting for the PC: shown on every page, since a phone is waiting on them. */
export function PairRequests({ remote, guard }: { remote: RemoteStatus | null; guard: (f: () => Promise<unknown>) => Promise<boolean> }) {
  if (!remote?.requests.length) return null;
  return (
    <>
      {remote.requests.map((r) => (
        <section key={r.id} className="callout warn banner" role="alert">
          <div className="callout-text">
            <strong>
              “{r.name}” ({deviceKind(r.agent)}) wants to pair with YAAIORCH
            </strong>
            <span>Allow it only if you are pairing that device right now. It will be able to view your repos and runs; control is a separate switch.</span>
          </div>
          <div className="row">
            {r.before === "control" ? (
              <>
                <button className="primary" onClick={() => guard(() => transport.remoteDecide(r.id, true, "control"))}>
                  Allow with control (as before)
                </button>
                <button onClick={() => guard(() => transport.remoteDecide(r.id, true))}>Allow view only</button>
              </>
            ) : (
              <button className="primary" onClick={() => guard(() => transport.remoteDecide(r.id, true))}>
                Allow
              </button>
            )}
            <button onClick={() => guard(() => transport.remoteDecide(r.id, false))}>Deny</button>
          </div>
        </section>
      ))}
    </>
  );
}

/** The PC's Remote access page: the tunnel, pairing a phone by QR code, and the paired devices. */
export function RemoteAccess({ remote, guard }: { remote: RemoteStatus | null; guard: (f: () => Promise<unknown>) => Promise<boolean> }) {
  const [link, setLink] = useState<{ url: string; until: number } | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const tunnel = remote?.tunnel ?? { status: "off" as const };
  // A new address (cloudflared restarted) makes an old pairing link useless.
  useEffect(() => setLink(null), [tunnel.url]);
  const linkLeft = link ? Math.max(0, Math.round((link.until - now) / 1000)) : 0;
  const statusText = {
    off: "Off",
    downloading: "Downloading cloudflared (first time only)…",
    starting: "Starting the tunnel…",
    on: "On",
    error: "Not working",
  }[tunnel.status];

  return (
    <div className="page remote-page">
      <header className="page-head">
        <h2>Remote access</h2>
        <p className="muted">
          Watch and steer YAAIORCH from your phone, through a Cloudflare quick tunnel (no account needed). Only devices you pair here get in; new ones can only
          view until you allow control.
        </p>
      </header>

      <section className="card">
        <div className="row">
          <label className="check switch">
            <input type="checkbox" role="switch" checked={!!remote?.enabled} onChange={(e) => guard(() => transport.remoteEnable(e.target.checked))} /> Remote
            access
          </label>
          <span className={`badge ${tunnel.status === "on" ? "done" : tunnel.status === "error" ? "failed" : "warn"}`}>{statusText}</span>
          <span className="spacer" />
          {tunnel.url && <code className="remote-url">{tunnel.url}</code>}
        </div>
        {tunnel.error && <p className="error">{tunnel.error}</p>}
        {!!remote?.cleared && (
          <p className="callout warn">
            {remote.cleared === 1 ? "1 device" : `${remote.cleared} devices`} paired earlier can no longer connect: the address changes every time remote access
            starts. Pair {remote.cleared === 1 ? "it" : "them"} again with a new QR code; a device that had control is offered it back.
          </p>
        )}
        <p className="muted small">
          While it is on, your PC is reachable at that address, and traffic passes through Cloudflare. It starts off every time the app starts, and each start
          gets a new address, so phones pair again then. Turning it off closes the tunnel at once.
        </p>
      </section>

      {tunnel.status === "on" && (
        <section className="card">
          <h3>Pair a phone</h3>
          {link && linkLeft > 0 ? (
            <div className="pair-qr">
              <Qr text={link.url} label="QR code to pair a phone" />
              <div>
                <p>Scan this with the phone's camera, open the link, name the device and tap Pair. Then allow it here.</p>
                <p className="muted">
                  Works once, for {Math.floor(linkLeft / 60)}:{String(linkLeft % 60).padStart(2, "0")} more. Do not share it.
                </p>
                <button onClick={() => setLink(null)}>Hide</button>
              </div>
            </div>
          ) : (
            <button
              className="primary"
              onClick={() =>
                guard(async () => {
                  const r = await transport.remotePairLink();
                  setLink({ url: r.url, until: Date.now() + r.expiresIn * 1000 });
                })
              }
            >
              Show pairing QR code
            </button>
          )}
        </section>
      )}

      <section className="card">
        <h3>Paired devices</h3>
        {!remote?.devices.length ? (
          <p className="muted">None yet.</p>
        ) : (
          <ul className="device-list">
            {remote.devices.map((d) => (
              <li key={d.id}>
                <div>
                  <strong>{d.name}</strong>
                  <span className="muted">
                    {" "}
                    · {deviceKind(d.agent)} · last seen {ago(d.lastSeen)}
                  </span>
                </div>
                <span className="spacer" />
                <label
                  className="check switch"
                  title="Control: start and stop runs, approve plans, answer agents, allow commands. Without it the device only views. Paths on this PC, limits and remote access always stay here."
                >
                  <input
                    type="checkbox"
                    role="switch"
                    checked={d.role === "control"}
                    onChange={(e) => guard(() => transport.remoteDevice(d.id, { role: e.target.checked ? "control" : "view" }))}
                  />{" "}
                  Control
                </label>
                <button className="danger" onClick={() => guard(() => transport.remoteDevice(d.id, { revoke: true }))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
