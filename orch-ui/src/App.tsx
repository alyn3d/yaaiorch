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
  if (s.state.queued) return { tone: "warn", label: `waiting: ${s.state.waitReason ?? "free slot"}` };
  const last = s.run?.status ?? s.state.lastRun?.status;
  if (last === "failed") return { tone: "failed", label: "last goal failed" };
  if (last === "passed") return { tone: "done", label: "last goal passed" };
  return { tone: "", label: "idle" };
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const clock = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** The daily budget field: edited as text, saved on Enter or when it loses focus. Empty = no budget. */
function BudgetField({ limit, spent, onSave }: { limit: number | null; spent: number; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const v = draft.trim() === "" ? null : Number(draft);
    setDraft(null);
    if (v === null || (Number.isFinite(v) && v > 0)) onSave(v);
  };
  return (
    <label title="Spending cap for all repos together, per day (local time). Each run's max cost is capped to what is left; when it is used up, new starts wait for tomorrow and a queue stops before its next goal. Empty = no cap.">
      Daily $
      <input
        className="budget" inputMode="decimal" placeholder="none"
        value={draft ?? (limit === null ? "" : String(limit))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      <span className={`cost ${limit !== null && spent >= limit ? "over" : ""}`}>{usd(spent)} today</span>
    </label>
  );
}

export function App() {
  const { sessions, order, maxParallel, setMaxParallel, global, connected, canPickRepo } = useOrch();
  // Re-render every 30 s so the usage-limit banner disappears when its reset time passes.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
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
        <BudgetField limit={global.budget.limit} spent={global.budget.spent} onSave={(v) => guard(() => transport.setDailyBudget(v))} />
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

      {global.usageLimit && global.usageLimit.until > now && (
        <section className="card notice banner" role="status">
          <div className="row">
            <strong>Claude usage limit reached</strong>
            <span className="muted">
              in {baseName(global.usageLimit.repo)}. New runs in all repos wait until {clock(global.usageLimit.until)}; running ones wait on their own.
            </span>
            <span className="spacer" />
            <button onClick={() => guard(() => transport.clearLimit())} title="Start waiting runs now; if the limit is still on, they hit it again and wait.">Try now</button>
          </div>
        </section>
      )}
      {global.budget.limit !== null && global.budget.spent >= global.budget.limit && (
        <section className="card notice banner" role="status">
          <div className="row">
            <strong>Daily budget used up</strong>
            <span className="muted">
              {usd(global.budget.spent)} of {usd(global.budget.limit)} spent today. New runs wait until tomorrow; raise or clear <em>Daily $</em> to continue now.
            </span>
          </div>
        </section>
      )}

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
