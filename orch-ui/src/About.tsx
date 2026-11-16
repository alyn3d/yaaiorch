import { useLayoutEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { version } from "../package.json";
import { isTauri } from "./transport";

const SOURCE = "https://github.com/alyn3d/yaaiorch";

export function About({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");

  useLayoutEffect(() => {
    dialog.current?.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="card modal about"
      aria-labelledby="about-title"
      onClose={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") dialog.current?.close();
      }}
    >
      <div className="card-head">
        <h2 id="about-title">About YAAIORCH</h2>
        <span className="spacer" />
        <button autoFocus onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <div className="about-brand">
        <img src="/logo-64.png" alt="" width={64} height={64} />
        <div>
          <strong>Yet Another AI Orchestrator</strong>
          <p className="muted">Version {version}</p>
        </div>
      </div>
      <p className="about-tagline">Made out of pure spite.</p>
      <p>Copyright © 2026 alyn3d and contributors.</p>
      <p className="muted">Open source under the GNU General Public License v3.0.</p>
      <a
        href={SOURCE}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (!isTauri) return;
          event.preventDefault();
          void openUrl(SOURCE).catch((e) => setError(`Could not open the project website: ${e}`));
        }}
      >
        Source and contributors ↗
      </a>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
