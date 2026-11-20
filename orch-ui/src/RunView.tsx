// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from "react";
import type { RoundDiff, RunView as Run, TaskView, TokenUsage } from "./types";
import { transport } from "./transport";
import { openExternal } from "./links";
import { CommandCard } from "./AgentM";
import { AgentText } from "./AgentText";
import { ACTIVITY_LABELS, failureSummary, roundPhases, taskTimeline } from "./runProgress";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
};

const money = (n?: number) => (n === undefined ? "" : `$${n.toFixed(2)}`);
const tokenNumber = new Intl.NumberFormat();

export function TokenCount({ tokens }: { tokens?: TokenUsage }) {
  if (!tokens) return null;
  return (
    <span
      className="cost token-count"
      title={`Input includes cache reads and writes. Cache read: ${tokenNumber.format(tokens.cacheRead)}; cache creation: ${tokenNumber.format(tokens.cacheCreation)}.`}
    >
      {tokenNumber.format(tokens.input)} in · {tokenNumber.format(tokens.output)} out
    </span>
  );
}

export function DiffViewer({ diff }: { diff?: RoundDiff }) {
  if (!diff) return null;
  return (
    <details className="disclosure round-diff">
      <summary>Round diff</summary>
      {diff.unavailable ? (
        <p className="muted">{diff.unavailable}</p>
      ) : diff.text ? (
        <>
          <pre tabIndex={0} aria-label="Round diff">
            {diff.text}
          </pre>
          {diff.truncated && <p className="muted">Diff truncated at 100,000 characters.</p>}
        </>
      ) : (
        <p className="muted">No changes in this round.</p>
      )}
    </details>
  );
}

function VisualShot({ repo, shot }: { repo: string; shot: { path: string; viewport: number; theme: string; file: string } }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let url = "";
    transport.visualImage(repo, shot.file).then(
      (image) => {
        url = image;
        if (active) setSrc(image);
        else URL.revokeObjectURL(image);
      },
      (e) => active && setError(String(e)),
    );
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [repo, shot.file]);
  return (
    <figure className="visual-shot">
      {src ? (
        <img src={src} alt={`${shot.path}, ${shot.viewport}px, ${shot.theme} theme`} loading="lazy" />
      ) : (
        <div className="visual-shot-empty">{error || "Loading screenshot…"}</div>
      )}
      <figcaption title={shot.file}>
        {shot.path} · {shot.viewport}px · {shot.theme}
      </figcaption>
    </figure>
  );
}

function VisualShots({ repo, shots }: { repo: string; shots: { path: string; viewport: number; theme: string; file: string }[] }) {
  if (!shots.length) return null;
  return (
    <div className="visual-shots">
      {shots.map((shot) => (
        <VisualShot key={shot.file} repo={repo} shot={shot} />
      ))}
    </div>
  );
}

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
        <TokenCount tokens={t.tokens} />
        <span className="muted">{elapsed}</span>
      </div>
      <div className="desc">
        <AgentText text={t.task} />
      </div>
      {t.files.length > 0 && <p className="muted files">{t.files.join(", ")}</p>}
      {t.touched.length > 0 && <p className="muted files">changed: {t.touched.join(", ")}</p>}
      {t.error && <p className="error">{t.error}</p>}
      {t.activity && t.activity.length > 0 && (
        <details className="disclosure task-activity">
          <summary>
            {t.activity[t.activity.length - 1].kind === "limit" ? "" : "Latest: "}
            {ACTIVITY_LABELS[t.activity[t.activity.length - 1].kind]}
          </summary>
          <ol>
            {t.activity.map((a, i) => (
              <li key={`${a.t}-${i}`}>
                <time dateTime={new Date(a.t).toISOString()}>{new Date(a.t).toLocaleTimeString()}</time> {ACTIVITY_LABELS[a.kind]}
              </li>
            ))}
          </ol>
        </details>
      )}
      {t.report && (
        <details className="disclosure task-report">
          <summary>Agent report</summary>
          <div className="task-report-body" tabIndex={0} aria-label={`${t.agent} report`}>
            <AgentText text={t.report} />
          </div>
          {t.reportTruncated && <p className="muted">Report truncated at 4,000 characters.</p>}
        </details>
      )}
      {t.failures.length > 0 && (
        <ul className="failures">
          {t.failures.map((f, i) => (
            <li key={i}>
              <AgentText text={f} />
            </li>
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

function TaskTimeline({ tasks, now, live, round }: { tasks: TaskView[]; now: number; live: boolean; round: number }) {
  const timeline = taskTimeline(tasks, now, live);
  if (!timeline) return null;
  return (
    <div className="task-timeline" aria-label={`Round ${round} task timeline`}>
      <div className="row">
        <p className="phase">Task timeline</p>
        <span className="spacer" />
        <span className="muted">From first task · {fmt(timeline.span)}</span>
      </div>
      <ol>
        {timeline.rows.map(({ task, start, offset, left, width, end, knownEnd, running }) => (
          <li key={task.id}>
            <div className="timeline-task" title={task.task}>
              <span className="agent">{task.agent}</span>
              <span className="muted">{task.phase}</span>
            </div>
            <div className="timeline-track" aria-hidden="true">
              <span className={`timeline-bar ${tone(task.status)}`} style={{ left: `min(${left}%, calc(100% - 2px))`, width: `${width}%` }} />
            </div>
            <span
              className="timeline-time"
              title={
                task.status === "STOPPED"
                  ? "Start offset · observed duration until the stop was detected or the last recorded event · status"
                  : "Start offset from the first task · duration · status"
              }
            >
              +{fmt(offset)} · {knownEnd ? `${fmt(end - start)}${running ? " so far" : task.status === "STOPPED" ? " observed" : ""}` : "end not recorded"} ·{" "}
              {task.status.toLowerCase()}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

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
      <div>
        <AgentText text={a.summary} />
      </div>
      {!editing ? (
        <ul className="plan">
          {a.tasks.map((t, i) => (
            <li key={i}>
              <span className="agent">{t.agent}</span> <span className="muted">[{t.phase}]</span> <AgentText text={t.task} />
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

function QuestionCard({
  question,
  active,
  onAnswer,
}: {
  question: NonNullable<Run["questions"]>[number];
  active: boolean;
  onAnswer?: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const answer = async (value: string) => {
    setBusy(true);
    if (!(await onAnswer?.({ id: question.id, answer: value }))) setBusy(false);
  };
  return (
    <div className="approval">
      <div className="row">
        <strong>
          {question.agent}
          {question.round ? ` · Round ${question.round}` : ""}
        </strong>
        <span className={`badge ${question.answered ? "done" : "warn"}`}>{question.answered ? "answered" : active ? "waiting for you" : "unanswered"}</span>
      </div>
      <div>
        <AgentText text={question.question} />
      </div>
      {active && onAnswer && (
        <>
          <div className="row">
            {question.options.map((option, i) => (
              <button key={i} disabled={busy} onClick={() => answer(option)}>
                {option}
              </button>
            ))}
          </div>
          <div className="row">
            <input
              aria-label={`Answer ${question.agent}`}
              placeholder="Or write your own answer"
              maxLength={4000}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button className="primary" disabled={busy || !text.trim()} onClick={() => answer(text.trim())}>
              Send answer
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function RunPanel({
  repo,
  run,
  onAnswer,
  onQuestionAnswer,
  onCommandDecide,
}: {
  repo: string;
  run: Run;
  onAnswer?: (body: Record<string, unknown>) => Promise<boolean>;
  onQuestionAnswer?: (body: Record<string, unknown>) => Promise<boolean>;
  /** Agent M: answer a command an agent wants to run ({ id, decision }). */
  onCommandDecide?: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const now = useNow(run.status === "running");
  const failure = failureSummary(run);
  return (
    <section className="card run-card">
      <div className="card-head">
        <h3 className="run-title" title={run.goal}>
          {run.goal.slice(0, 80)}
        </h3>
        <span className={`badge ${run.status === "running" ? "running" : run.status === "passed" ? "done" : "failed"}`}>
          {run.dryRun && run.status === "passed" ? "plan only" : run.status}
        </span>
        <span className="spacer" />
        <span className="cost" title="Cost of agent calls in this goal">
          {money(run.cost)}
          {run.maxCost !== undefined ? ` / ${money(run.maxCost)}` : ""}
        </span>
        <TokenCount tokens={run.tokens} />
        <span className="muted">
          {fmt((run.status === "running" ? now : (run.endedAt ?? run.rounds.at(-1)?.tasks.at(-1)?.endedAt ?? now)) - run.startedAt)}
        </span>
      </div>
      {/* The checkpoint and its rollback offer are shown by App from last-run.json, which stays correct after a rollback. */}
      {run.checkpoint && run.status === "running" && <p className="muted">Checkpoint: {run.checkpoint}</p>}
      {run.error && <p className="error">{run.error}</p>}
      {run.historyError && <p className="error">{run.historyError}</p>}
      {failure && (
        <aside className="failure-summary" aria-label={`Round ${failure.round} issues`}>
          <strong>{failure.previous ? `Previous round ${failure.round}` : `Round ${failure.round}`} needs attention</strong>
          <ul className="failures">
            {failure.issues.map((issue, i) => (
              <li key={i}>
                <AgentText text={issue} />
              </li>
            ))}
          </ul>
          {failure.note && <p>{failure.note}</p>}
        </aside>
      )}
      {run.approval && run.status === "running" && onAnswer && (
        <Approval key={run.approval.round + run.approval.summary} a={run.approval} onAnswer={onAnswer} />
      )}
      {run.questions?.map((q) => (
        <QuestionCard key={q.id} question={q} active={!q.answered && run.status === "running" && !!onQuestionAnswer} onAnswer={onQuestionAnswer} />
      ))}
      {run.commands?.map((c) => (
        <CommandCard
          key={c.id}
          repo={repo}
          command={!c.decision && run.status !== "running" ? { ...c, decision: "cancelled" } : c}
          onDecide={onCommandDecide && ((_repo, id, decision) => onCommandDecide({ id, decision }))}
        />
      ))}
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
      {run.pr?.link && (
        <p>
          Pushed {run.branch?.name ?? "the branch"}.{" "}
          <a href={run.pr.link} target="_blank" rel="noreferrer" onClick={(e) => openExternal(e, run.pr!.link!)}>
            Open the pull request
          </a>
        </p>
      )}
      {run.pr?.pushed && !run.pr.link && <p className="muted">Pushed {run.branch?.name ?? "the branch"} to origin; open the pull request on your git host.</p>}
      {run.pr?.error && <p className="note">No pull request: {run.pr.error}</p>}
      {run.ci && (
        <p className={run.ci.state === "pass" ? "muted" : "note"} title="The pull request's CI checks on GitHub">
          CI:{" "}
          {run.ci.state === "pass"
            ? "checks pass"
            : run.ci.state === "fail"
              ? `failing (${run.ci.failed.join(", ")})`
              : run.ci.state === "none"
                ? "no checks reported"
                : "still running when orch stopped waiting"}
        </p>
      )}
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
            {r.passed !== undefined && <span className={`badge ${r.passed ? "done" : "failed"}`}>{r.passed ? "Round passed" : "Round failed"}</span>}
            <span className="spacer" />
            {r.cost !== undefined && (
              <span className="cost" title="Cost of this round">
                {money(r.cost)}
              </span>
            )}
            <TokenCount tokens={r.tokens} />
          </div>
          <ol className="phase-timeline" aria-label={`Round ${r.round} phases`}>
            {roundPhases(run, r).map((phase) => (
              <li key={phase.label} className={phase.state}>
                <span>{phase.label}</span>
                <small>
                  {phase.state === "active"
                    ? "in progress"
                    : phase.state === "skipped"
                      ? "not run"
                      : phase.state === "attention"
                        ? "needs attention"
                        : phase.state}
                </small>
              </li>
            ))}
          </ol>
          <TaskTimeline tasks={r.tasks} now={now} live={run.status === "running" && run.rounds.at(-1) === r && r.passed === undefined} round={r.round} />
          {r.summary && (
            <div className="round-summary">
              <AgentText text={r.summary} />
              {r.architectCost !== undefined && (
                <>
                  <span className="cost"> (plan {money(r.architectCost)})</span>
                  <TokenCount tokens={r.architectTokens} />
                </>
              )}
            </div>
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
              <TokenCount tokens={r.critic.tokens} />
            </p>
          )}
          {r.reviews?.map((rv) => (
            <p key={rv.agent} className={rv.approved ? "cost" : "note"} title={rv.issues.join("\n")}>
              {rv.lens === "goal" ? "Diff critic" : `Review (${rv.agent})`}:{" "}
              {rv.approved ? "approved" : `rejected (${rv.issues.length} issue${rv.issues.length === 1 ? "" : "s"}): ${rv.issues.join("; ")}`}
              {rv.cost !== undefined && <span className="cost"> ({money(rv.cost)})</span>}
              <TokenCount tokens={rv.tokens} />
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
          {r.visual && (
            <>
              <div className="row">
                <p className="phase">Browser</p>
                <span
                  className={`badge ${r.visual.problems.length ? "failed" : "done"}`}
                  title={`${r.visual.url} (${fmt(r.visual.ms)})\n${r.visual.shots.map((s) => s.file).join("\n")}`}
                >
                  {r.visual.shots.length} screenshot{r.visual.shots.length === 1 ? "" : "s"}
                  {r.visual.problems.length ? `, ${r.visual.problems.length} problem${r.visual.problems.length === 1 ? "" : "s"}` : ""}
                </span>
                {r.visual.observations.length > 0 && (
                  <span className="muted" title={r.visual.observations.join("\n")}>
                    {r.visual.observations.length} measured issue{r.visual.observations.length === 1 ? "" : "s"} for QA
                  </span>
                )}
              </div>
              <VisualShots repo={repo} shots={r.visual.shots} />
            </>
          )}
          {r.visual?.problems.map((p) => (
            <p key={p} className="note">
              Browser check: {p}
            </p>
          ))}
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
          <DiffViewer diff={r.diff} />
        </div>
      ))}
    </section>
  );
}
