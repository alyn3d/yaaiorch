import { useEffect, useRef, useState } from "react";
import { reduce } from "./reduce";
import { RunPanel } from "./RunView";
import { transport } from "./transport";
import type { HistoryEntry, RunView } from "./types";

export function RunHistory({ repo, busy }: { repo: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<{ id: string; run: RunView; truncated: boolean } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const request = useRef(0);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError("");
    transport
      .history(repo)
      .then(
        (list) => {
          if (active) setEntries(list);
        },
        (e) => {
          if (active) setError(`Could not load run history: ${String(e)}`);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [repo, open, busy, refresh]);

  const replay = async (id: string) => {
    const current = ++request.current;
    setError("");
    setSelected(null);
    try {
      const recording = await transport.historyRun(repo, id);
      let run = recording.events.reduce<RunView | null>(reduce, null);
      if (!run) throw new Error("recording has no goal");
      if (run.status === "running") {
        run = reduce(run, { type: "stopped", t: recording.events.at(-1)?.t ?? run.startedAt });
        if (run) run.error = "No goal end was recorded; this attempt may still be running or was interrupted.";
      }
      if (!run) throw new Error("could not replay recording");
      if (current === request.current) setSelected({ id, run, truncated: recording.truncated });
    } catch (e) {
      if (current === request.current) setError(`Could not replay run: ${String(e)}`);
    }
  };

  return (
    <details className="card disclosure run-history" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Run history</summary>
      <div className="history-body">
        <div className="row">
          <p className="muted">Recorded goal attempts for this repo, newest first.</p>
          <span className="spacer" />
          <button onClick={() => setRefresh((n) => n + 1)} disabled={loading}>
            Refresh
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {loading && <p className="muted">Loading history…</p>}
        {!loading && entries?.length === 0 && <p className="empty">No recorded runs yet.</p>}
        {entries && entries.length > 0 && (
          <ul className="history-list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <button onClick={() => replay(entry.id)} disabled={entry.status === "unreadable"} aria-pressed={selected?.id === entry.id}>
                  <span>{entry.goal ?? "Unreadable recording"}</span>
                  <span className="muted">{entry.startedAt === undefined ? entry.id : new Date(entry.startedAt).toLocaleString()}</span>
                  <span className={`badge ${entry.status === "passed" ? "done" : entry.status === "failed" ? "failed" : "warn"}`}>{entry.status}</span>
                  {entry.cost !== undefined && <span className="cost">${entry.cost.toFixed(2)}</span>}
                </button>
                {entry.error && <p className="error">{entry.error}</p>}
                {entry.truncated && <p className="muted">The last event was incomplete.</p>}
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <div className="history-replay">
            <div className="row">
              <strong>Recorded run</strong>
              <span className="spacer" />
              <button
                onClick={() => {
                  request.current++;
                  setSelected(null);
                }}
              >
                Close replay
              </button>
            </div>
            {selected.truncated && <p className="muted">The last event was incomplete and could not be replayed.</p>}
            <RunPanel run={selected.run} />
          </div>
        )}
      </div>
    </details>
  );
}
