import { useEffect, useState } from "react";
import type { RunView as Run, TaskView } from "./types";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

const tone = (s: string) =>
  s === "running" ? "running"
  : ["COMPLETE", "PASS"].includes(s) ? "done"
  : ["PARTIAL", "PHANTOM", "UNKNOWN", "SKIPPED", "STOPPED"].includes(s) ? "warn"
  : s === "queued" ? "" : "failed";

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [active]);
  return now;
}

function Task({ t, now }: { t: TaskView; now: number }) {
  const elapsed = t.startedAt ? fmt((t.endedAt ?? now) - t.startedAt) : "";
  return (
    <div className={`task ${tone(t.status)}`}>
      <div className="row">
        <span className="agent">{t.agent}</span>
        <span className={`badge ${tone(t.status)}`}>{t.status.toLowerCase()}</span>
        <span className="spacer" />
        <span className="muted">{elapsed}</span>
      </div>
      <p className="desc">{t.task}</p>
      {t.files.length > 0 && <p className="muted files">{t.files.join(", ")}</p>}
      {t.touched.length > 0 && <p className="muted files">changed: {t.touched.join(", ")}</p>}
      {t.error && <p className="error">{t.error}</p>}
      {t.failures.length > 0 && <ul className="failures">{t.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>}
    </div>
  );
}

const PHASES: { key: TaskView["phase"]; label: string }[] = [
  { key: "foundation", label: "Foundation" },
  { key: "build", label: "Build (parallel)" },
  { key: "verify", label: "Verify" },
];

export function RunPanel({ run }: { run: Run }) {
  const now = useNow(run.status === "running");
  return (
    <section className="card">
      <div className="row">
        <h2>{run.goal.slice(0, 80)}</h2>
        <span className={`badge ${run.status === "running" ? "running" : run.status === "passed" ? "done" : "failed"}`}>
          {run.dryRun && run.status === "passed" ? "plan only" : run.status}
        </span>
        <span className="spacer" />
        <span className="muted">{fmt((run.status === "running" ? now : run.rounds.at(-1)?.tasks.at(-1)?.endedAt ?? now) - run.startedAt)}</span>
      </div>
      {/* orch.ts deletes the checkpoint branch when the goal passes */}
      {run.checkpoint && run.status !== "passed" && (
        <p className="muted">Checkpoint: {run.checkpoint} (roll back with <code>git reset --hard {run.checkpoint}</code>)</p>
      )}
      {run.error && <p className="error">{run.error}</p>}
      {run.rounds.map((r) => (
        <div key={r.round} className="round">
          <div className="row">
            <strong>Round {r.round}/{run.maxRounds}</strong>
            {r.architect === "running" && <span className="badge running">architect planning</span>}
            {r.passed !== undefined && <span className={`badge ${r.passed ? "done" : "failed"}`}>{r.passed ? "QA passed" : "QA failed"}</span>}
          </div>
          {r.summary && <p>{r.summary}</p>}
          {r.checks && (
            <div className="row">
              <p className="phase">Checks</p>
              {r.checks.length ? r.checks.map((c) => (
                <span key={c.name} className={`badge ${c.ok ? "done" : "failed"}`} title={`${c.command} (${fmt(c.ms)})`}>
                  {c.name}{c.ok ? "" : ` exit ${c.code}`}
                </span>
              )) : <span className="muted">none configured</span>}
            </div>
          )}
          {PHASES.map(({ key, label }) => {
            const ts = r.tasks.filter((t) => t.phase === key);
            return ts.length ? (
              <div key={key}>
                <p className="phase">{label}</p>
                <div className="tasks">{ts.map((t) => <Task key={t.id} t={t} now={now} />)}</div>
              </div>
            ) : null;
          })}
        </div>
      ))}
    </section>
  );
}
