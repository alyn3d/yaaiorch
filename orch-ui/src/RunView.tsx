import { useEffect, useState } from "react";
import type { RunView as Run, TaskView } from "./types";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./transport";

/** A link out of the app: the desktop app's webview does not open new windows, so ask the system browser. */
function openExternal(e: React.MouseEvent, url: string) {
  if (!isTauri || !/^https?:\/\//.test(url)) return;
  e.preventDefault();
  openUrl(url).catch(() => {
    /* nothing to do: the URL is on screen to copy */
  });
}

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
        {t.resumed !== undefined && (
          <span className="badge" title={`Continued this agent's session from round ${t.resumed}`}>
            resumed
          </span>
        )}
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

/** --approve-plan: the waiting plan, with Build it, an editable copy, and Send back with a reason. */
function Approval({ a, onAnswer }: { a: NonNullable<Run["approval"]>; onAnswer: (body: Record<string, unknown>) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState("");
  const answer = async (body: Record<string, unknown>) => {
    setBusy(true);
    const ok = await onAnswer(body);
    setBusy(false);
    if (ok) setEditing(false);
  };
  const buildEdited = () => {
    try {
      const plan = JSON.parse(text);
      setBad("");
      return answer({ plan });
    } catch (e) {
      setBad(`Not valid JSON: ${(e as Error).message}`);
    }
  };
  return (
    <div className="approval">
      <div className="row">
        <strong>Round {a.round} plan: waiting for you</strong>
        <span className="badge warn">approval</span>
      </div>
      {a.error && <p className="error">{a.error}</p>}
      <p>{a.summary}</p>
      {!editing ? (
        <ul className="plan">
          {a.tasks.map((t, i) => (
            <li key={i}>
              <span className="agent">{t.agent}</span> <span className="muted">[{t.phase}]</span> {t.task}
              {t.files?.length ? <span className="muted files"> ({t.files.join(", ")})</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <>
          <textarea className="plan-edit" rows={14} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
          {bad && <p className="error">{bad}</p>}
        </>
      )}
      <div className="row">
        {!editing ? (
          <>
            <button className="primary" disabled={busy} onClick={() => answer({})}>
              Build it
            </button>
            <button
              disabled={busy}
              onClick={() => {
                // The task ids are for display; the plan itself has none.
                setText(JSON.stringify({ summary: a.summary, tasks: a.tasks }, (k, v) => (k === "id" ? undefined : v), 2));
                setEditing(true);
              }}
            >
              Edit plan
            </button>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={buildEdited}>
              Build edited plan
            </button>
            <button disabled={busy} onClick={() => setEditing(false)}>
              Cancel edit
            </button>
          </>
        )}
        <span className="spacer" />
        <input placeholder="What should change?" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button
          disabled={busy || !reason.trim()}
          title="The architect plans again with your reason; the run waits for you again"
          onClick={() => answer({ reject: reason.trim() })}
        >
          Send back
        </button>
      </div>
    </div>
  );
}

export function RunPanel({ run, onAnswer }: { run: Run; onAnswer?: (body: Record<string, unknown>) => Promise<boolean> }) {
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
      {run.approval && run.status === "running" && onAnswer && (
        <Approval key={run.approval.round + run.approval.summary} a={run.approval} onAnswer={onAnswer} />
      )}
      {run.branch && (
        <p className="muted">
          Branch: {run.branch.name} (from {run.branch.base}, which stays unchanged)
        </p>
      )}
      {run.pr?.url && (
        <p>
          Pull request:{" "}
          <a href={run.pr.url} target="_blank" rel="noreferrer" onClick={(e) => openExternal(e, run.pr!.url!)}>
            {run.pr.url}
          </a>
        </p>
      )}
      {run.pr?.error && <p className="note">No pull request: {run.pr.error}</p>}
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
          {r.reviews?.map((rv) => (
            <p key={rv.agent} className={rv.approved ? "cost" : "note"} title={rv.issues.join("\n")}>
              {rv.lens === "goal" ? "Diff critic" : `Review (${rv.agent})`}:{" "}
              {rv.approved ? "approved" : `rejected (${rv.issues.length} issue${rv.issues.length === 1 ? "" : "s"}): ${rv.issues.join("; ")}`}
              {rv.cost !== undefined && <span className="cost"> ({money(rv.cost)})</span>}
            </p>
          ))}
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
