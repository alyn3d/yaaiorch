import { useEffect, useState } from "react";
import type { RunView as Run, TaskView } from "./types";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

const money = (n?: number) => (n === undefined ? "" : `$${n.toFixed(2)}`);

const tone = (s: string) =>
  s === "running"
    ? "running"
    : ["COMPLETE", "PASS"].includes(s)
      ? "done"
      : ["PARTIAL", "PHANTOM", "UNKNOWN", "SKIPPED", "STOPPED"].includes(s)
        ? "warn"
        : s === "queued"
          ? ""
          : "failed";

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
        {t.cost !== undefined && <span className="cost">{money(t.cost)}</span>}
        <span className="muted">{elapsed}</span>
      </div>
      <p className="desc">{t.task}</p>
      {t.files.length > 0 && <p className="muted files">{t.files.join(", ")}</p>}
      {t.touched.length > 0 && <p className="muted files">changed: {t.touched.join(", ")}</p>}
      {t.error && <p className="error">{t.error}</p>}
      {t.failures.length > 0 && (
        <ul className="failures">
          {t.failures.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
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
        <span className="cost" title="Cost of agent calls in this goal">
          {money(run.cost)}
          {run.maxCost !== undefined ? ` / ${money(run.maxCost)}` : ""}
        </span>
        <span className="muted">{fmt((run.status === "running" ? now : (run.rounds.at(-1)?.tasks.at(-1)?.endedAt ?? now)) - run.startedAt)}</span>
      </div>
      {/* The checkpoint and its rollback offer are shown by App from last-run.json, which stays correct after a rollback. */}
      {run.checkpoint && run.status === "running" && <p className="muted">Checkpoint: {run.checkpoint}</p>}
      {run.error && <p className="error">{run.error}</p>}
      {run.rounds.map((r) => (
        <div key={r.round} className="round">
          <div className="row">
            <strong>
              Round {r.round}/{run.maxRounds}
            </strong>
            {r.power && (
              <span className="badge" title="Power tier for this round">
                {r.power}
              </span>
            )}
            {r.mode === "direct" && (
              <span className="badge" title="Fast path: one agent did the whole goal">
                direct
              </span>
            )}
            {r.architect === "running" && <span className="badge running">architect planning</span>}
            {r.passed !== undefined && <span className={`badge ${r.passed ? "done" : "failed"}`}>{r.passed ? "QA passed" : "QA failed"}</span>}
            <span className="spacer" />
            {r.cost !== undefined && (
              <span className="cost" title="Cost of this round">
                {money(r.cost)}
              </span>
            )}
          </div>
          {r.summary && (
            <p>
              {r.summary}
              {r.architectCost !== undefined && <span className="cost"> (plan {money(r.architectCost)})</span>}
            </p>
          )}
          {r.models && (
            <p className="cost" title="Model used per role in this round">
              {Object.entries(r.models)
                .map(([role, model]) => `${role}: ${model}`)
                .join(" · ")}
            </p>
          )}
          {r.critic && (
            <p className={r.critic.approved ? "cost" : "note"} title={r.critic.issues.join("\n")}>
              Plan critic:{" "}
              {r.critic.approved
                ? "approved"
                : `rejected (${r.critic.issues.length} issue${r.critic.issues.length === 1 ? "" : "s"}): ${r.critic.issues.join("; ")}${r.critic.revised ? ", plan revised" : ""}`}
              {r.critic.cost !== undefined && <span className="cost"> ({money(r.critic.cost)})</span>}
            </p>
          )}
          {r.unowned && (
            <p className="note" title={r.unowned.files.join("\n")}>
              Changed outside the plan's file lists{r.unowned.strict ? " (fails the round)" : " (QA was told)"}: {r.unowned.files.join(", ")}
            </p>
          )}
          {r.note && <p className="note">{r.note}</p>}
          {r.checks && (
            <div className="row">
              <p className="phase">Checks</p>
              {r.checks.length ? (
                r.checks.map((c) => (
                  <span key={c.name} className={`badge ${c.ok ? "done" : "failed"}`} title={`${c.command} (${fmt(c.ms)})`}>
                    {c.name}
                    {c.ok ? "" : ` exit ${c.code}`}
                  </span>
                ))
              ) : (
                <span className="muted">none configured</span>
              )}
            </div>
          )}
          {PHASES.map(({ key, label }) => {
            const ts = r.tasks.filter((t) => t.phase === key);
            return ts.length ? (
              <div key={key}>
                <p className="phase">{label}</p>
                <div className="tasks">
                  {ts.map((t) => (
                    <Task key={t.id} t={t} now={now} />
                  ))}
                </div>
              </div>
            ) : null;
          })}
        </div>
      ))}
    </section>
  );
}
