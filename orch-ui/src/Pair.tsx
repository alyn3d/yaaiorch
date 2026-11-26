// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from "react";

/**
 * The phone's pairing page (`/pair#<code>`, from the QR code on the PC). The code is read from the fragment, which the
 * browser never sends, and removed from the address bar at once. Pair posts it with a name; the page then waits until
 * the PC allows or denies the device, and on allow (the answer sets the device cookie) opens the app.
 */
export function Pair() {
  const [code] = useState(() => decodeURIComponent(location.hash.slice(1)));
  const [name, setName] = useState(() => (/iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : "Phone"));
  const [state, setState] = useState<"form" | "sending" | "waiting" | "denied" | "error">(code ? "form" : "error");
  const [error, setError] = useState(code ? "" : "This link has no pairing code. Scan the QR code on the PC again.");

  useEffect(() => {
    if (location.hash) history.replaceState(null, "", location.pathname);
  }, []);

  const pair = async () => {
    setState("sending");
    try {
      const r = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? r.statusText);
      setState("waiting");
      for (;;) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const s = await (await fetch("/api/pair/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(d) })).json();
        if (s.status === "allowed") return location.replace("/");
        if (s.status === "denied") return setState("denied");
        if (s.status !== "waiting") throw new Error("The request expired. Scan a new QR code on the PC.");
      }
    } catch (e) {
      setError((e as Error).message);
      setState("error");
    }
  };

  return (
    <div className="splash pair">
      <img src="/logo-64.png" alt="" width={64} height={64} />
      <h1>Pair with YAAIORCH</h1>
      {state === "form" || state === "sending" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void pair();
          }}
        >
          <label>
            Name this device
            <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <button className="primary" type="submit" disabled={state === "sending" || !name.trim()}>
            Pair
          </button>
        </form>
      ) : state === "waiting" ? (
        <p>
          <span className="splash-spinner" aria-hidden />
          Now allow “{name}” on the PC…
        </p>
      ) : state === "denied" ? (
        <p>The PC denied this device.</p>
      ) : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
