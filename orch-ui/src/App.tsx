import { useEffect, useState } from "react";
import { useOrch, type Session } from "./useOrch";
import { RepoView } from "./RepoView";
import { transport } from "./transport";

const ACTIVE_KEY = "yaaiorch.activeRepo";
const baseName = (repo: string) => repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;

/** The tab's status dot: what this repo is doing right now, or how its last goal ended. */
function tabStatus(s: Session): { tone: string; label: string } {
  const now = Date.now();
  if (s.state.running && s.run?.waitingUntil && s.run.waitingUntil > now) return { tone: "warn", label: "waiting for the usage limit" };
  if (s.state.running && s.state.queue.some((i) => i.note?.startsWith("usage limit"))) return { tone: "warn", label: "waiting for the usage limit" };
  if (s.state.running) return { tone: "running", label: s.state.running.label };
  if (s.state.queued) return { tone: "warn", label: "waiting for a free slot" };
  const last = s.run?.status ?? s.state.lastRun?.status;
  if (last === "failed") return { tone: "failed", label: "last goal failed" };
  if (last === "passed") return { tone: "done", label: "last goal passed" };
  return { tone: "", label: "idle" };
}

export function App() {
  const { sessions, order, maxParallel, setMaxParallel, connected, canPickRepo } = useOrch();
  const [active, setActive] = useState<string>(() => {
    try {
      return localStorage.getItem(ACTIVE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [adding, setAdding] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [error, setError] = useState("");

  // Keep a valid tab selected as repos open and close.
  const current = order.includes(active) ? active : order[0] ?? "";
  useEffect(() => {
    try {
      if (current) localStorage.setItem(ACTIVE_KEY, current);
    } catch {
      /* storage blocked: the selection is just not remembered */
    }
  }, [current]);

  const running = order.filter((r) => sessions[r]?.state.running).length;
  const waiting = order.filter((r) => sessions[r]?.state.queued).length;

  const guard = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const addRepo = async () => {
    if (canPickRepo) await guard(() => transport.addRepo());
    else if (await guard(() => transport.addRepo(newPath))) {
      setNewPath("");
      setAdding(false);
    }
  };

  return (
    <div className="app">
      <header>
        <img className="logo" src="/logo-64.png" alt="" width={28} height={28} />
        <h1 title="Yet Another AI Orchestrator">YAAIORCH</h1>
        <span className="tagline">Yet Another AI Orchestrator</span>
        <span className="spacer" />
        <span className="muted" title="Repos running now / repos allowed to run at once">
          {running}/{maxParallel} running{waiting ? `, ${waiting} waiting` : ""}
        </span>
        <label title="How many repos may run at the same time; further starts wait for a free slot. All repos share one Claude usage limit.">
          Parallel
          <input
            type="number" min={1} max={16} value={maxParallel}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value));
              if (n >= 1 && n <= 16) guard(() => setMaxParallel(n));
            }}
          />
        </label>
        <span className={`dot ${connected ? "on" : ""}`} title={connected ? "connected" : "disconnected"} />
      </header>

      <nav className="tabs" role="tablist">
        {order.map((repo) => {
          const s = sessions[repo];
          if (!s) return null;
          const st = tabStatus(s);
          const busy = !!s.state.running || !!s.state.queued;
          return (
            <div key={repo} className={`tab ${repo === current ? "active" : ""}`} role="tab" aria-selected={repo === current} title={`${repo}\n${st.label}`}>
              <button className="tab-name" onClick={() => setActive(repo)}>
                <span className={`status ${st.tone}`} aria-label={st.label} />
                {baseName(repo)}
              </button>
              <button
                className="tab-close" disabled={busy} aria-label={`Close ${baseName(repo)}`}
                title={busy ? "Stop this repo's run before closing the tab" : "Close tab (the repo is not changed)"}
                onClick={() => guard(() => transport.removeRepo(repo))}
              >
                ×
              </button>
            </div>
          );
        })}
        {canPickRepo || !adding ? (
          <button className="tab-add" onClick={() => (canPickRepo ? addRepo() : setAdding(true))} title="Open another repo in a new tab">+ Repo</button>
        ) : (
          <form className="tab-add-form" onSubmit={(e) => { e.preventDefault(); addRepo(); }}>
            <input autoFocus placeholder="Path to the repo folder" value={newPath} onChange={(e) => setNewPath(e.target.value)} />
            <button className="primary" type="submit">Open</button>
            <button type="button" onClick={() => setAdding(false)}>Cancel</button>
          </form>
        )}
      </nav>
      {error && <p className="error">{error}</p>}

      {order.length === 0 && (
        <section className="card">
          <h2>No repo open</h2>
          <p className="muted">
            Open a git repo with <strong>+ Repo</strong>. Each repo gets its own tab, queue and log; up to {maxParallel} run at the same time.
          </p>
        </section>
      )}

      {order.map((repo) => sessions[repo] && <RepoView key={repo} session={sessions[repo]} hidden={repo !== current} />)}
    </div>
  );
}
