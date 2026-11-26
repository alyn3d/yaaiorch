// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from "react";

/**
 * Shown in the main window until the first state arrives from the server: in the desktop app while the bundled Node.js
 * starts it, in browser mode only for a moment. A start that keeps failing shows why, with a way to try again.
 */
export function Splash({ error }: { error: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 6000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="splash" role="status" aria-live="polite">
      <img className="splash-logo" src="/logo-64.png" alt="" width={64} height={64} />
      <h1>YAAIORCH</h1>
      {error && slow ? (
        <div className="splash-error">
          <p>Could not reach the YAAIORCH server. Still trying…</p>
          <pre>{error}</pre>
          <button type="button" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      ) : (
        <p>
          <span className="splash-spinner" aria-hidden />
          {slow ? "Starting the local server (Node.js)…" : "Starting…"}
        </p>
      )}
    </div>
  );
}
