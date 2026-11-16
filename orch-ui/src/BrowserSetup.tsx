import { useCallback, useEffect, useState } from "react";
import { transport, type BrowserSetup as Setup } from "./transport";

export function BrowserSetup({ repo, busy }: { repo: string; busy: boolean }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [selected, setSelected] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const result = await transport.browserSetup(repo);
      setSetup(result);
      setSelected(result.candidates.length === 1 ? result.candidates[0].id : "");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [repo]);
  useEffect(() => {
    setSetup(null);
    void refresh();
  }, [refresh, busy]);

  const update = async (action: "enable" | "disable" | "login", id?: string) => {
    setWorking(true);
    setError("");
    try {
      await transport.configureBrowser(repo, action, id);
      if (action !== "login") await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const candidate = setup?.candidates.find((c) => c.id === selected);
  const manual = !!setup?.serve && !setup.serve.auto;
  const stale = setup?.serve?.auto && !setup.candidates.some((c) => c.id === setup.serve?.auto?.id);

  return (
    <details className="models">
      <summary>Browser checks {setup && <span className="muted">({setup.enabled ? "on" : "off"})</span>}</summary>
      {setup && (
        <>
          <p className="muted">
            {setup.browser
              ? `Browser found (${setup.browser.via}).`
              : "No supported browser found. Install Chrome, Edge, Chromium or Brave, or run orch browser install."}{" "}
            Checks run only when the architect selects pages.
          </p>
          {(setup.enabled || manual) && (
            <p>
              {manual
                ? `Manual configuration: ${setup.serve?.url}${setup.serve?.command ? `; command: ${setup.serve.command}` : ""}`
                : `App: ${setup.serve?.auto?.directory} (${setup.serve?.auto?.command})`}
              {stale && <span className="error"> The dev script changed; select it again before running.</span>}
            </p>
          )}
          {!manual && setup.candidates.length > 0 && (
            <>
              <label>
                Web app
                <select value={selected} onChange={(e) => setSelected(e.target.value)}>
                  <option value="">Choose an app</option>
                  {setup.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.directory}: {c.command}
                    </option>
                  ))}
                </select>
              </label>
              {candidate && (
                <p>
                  Enabling runs <code>{candidate.command}</code> in <code>{candidate.directory}</code> when needed. Script:{" "}
                  <code>{candidate.scriptCommand}</code>
                </p>
              )}
              {candidate?.lifecycle.map((script) => (
                <p key={script}>
                  Lifecycle script: <code>{script}</code>
                </p>
              ))}
            </>
          )}
          {!manual && !setup.candidates.length && (
            <p className="muted">No supported web app detected. Configure serve manually in .orchestrator/config.json.</p>
          )}
          <div className="row">
            {!manual && candidate && (!setup.enabled || setup.serve?.auto?.id !== candidate.id) && (
              <button disabled={busy || working} onClick={() => update("enable", candidate.id)}>
                Enable browser checks
              </button>
            )}
            {manual && !setup.enabled && (
              <button disabled={busy || working} onClick={() => update("enable", "manual")}>
                Enable browser checks
              </button>
            )}
            {setup.enabled && (
              <button disabled={busy || working} onClick={() => update("disable")}>
                Turn off
              </button>
            )}
            {setup.enabled && (
              <button disabled={busy || working || !setup.browser || !!stale} onClick={() => update("login")}>
                Log in to app
              </button>
            )}
          </div>
          {setup.enabled && (
            <p className="muted">For apps requiring login, open the login window, sign in, then close it. The repo’s browser profile is reused.</p>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
