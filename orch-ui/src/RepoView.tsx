import { useCallback, useEffect, useRef, useState } from "react";
import { pluginOpts } from "./Plugins";
import type { Power } from "./types";
import { RunPanel } from "./RunView";
import { BriefBox } from "./Brief";
import { briefProgress, leftText } from "./progress";
import { usd } from "./repoStatus";
import { SettingsPanel, modelSpec, useRepoSettings } from "./Settings";
import { transport } from "./transport";
import { useFindings, type Session } from "./useOrch";

const POWERS: Power[] = ["max", "heavy", "balanced", "economy"];

/** Everything for one repo: goal form, settings, notices, queue, run panel and log. */
export function RepoView({ session, hidden }: { session: Session; hidden: boolean }) {
  const { state, log, run } = session;
  const repo = state.repo;
  const [goal, setGoal] = useState("");
  const [power, setPower] = useState<Power>("heavy");
  const [maxRounds, setMaxRounds] = useState(5);
  const [maxCost, setMaxCost] = useState("");
  /** The queue's budget: all goals of a loop together (--max-cost-total). */
  const [queueBudget, setQueueBudget] = useState("");
  /** A GitHub label to import issues with; Loop (watch) keeps pulling new ones in. */
  const [label, setLabel] = useState(() => {
    try {
      return localStorage.getItem(`yaaiorch.intake:${repo}`) ?? "";
    } catch {
      return "";
    }
  });
  const saveLabel = (v: string) => {
    setLabel(v);
    try {
      localStorage.setItem(`yaaiorch.intake:${repo}`, v);
    } catch {
      /* storage blocked */
    }
  };
  const [dryRun, setDryRun] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [error, setError] = useState("");
  const logRef = useRef<HTMLPreElement>(null);

  const call = useCallback(
    async (path: string, body: Record<string, unknown> = {}) => {
      setError("");
      try {
        await transport.call(path, { ...body, repo });
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      }
    },
    [repo],
  );

  useEffect(() => {
    const el = logRef.current;
    if (el && !hidden) el.scrollTop = el.scrollHeight;
  }, [log, hidden]);

  const busy = !!state.running || !!state.queued;
  const findings = useFindings(repo, busy);
  // An empty or out-of-range field must not reach orch.ts as 0 or NaN.
  const cap = Number(maxCost);
  const [settings, setSettings] = useRepoSettings(repo);
  const models = modelSpec(settings);
  const opts = {
    power,
    maxRounds: Math.min(20, Math.max(1, Math.round(maxRounds) || 1)),
    dryRun,
    maxCost: cap > 0 ? cap : undefined,
    models: models.spec,
    onLimit: settings.onLimit,
    fast: settings.fast,
    critic: settings.critic,
    diffCritic: settings.diffCritic,
    review: settings.review,
    reviewers: settings.reviewers || undefined,
    branch: settings.branch || settings.pr,
    pr: settings.pr,
    approvePlan: settings.approvePlan,
    plugins: pluginOpts(settings.plugins),
  };
  const badSettings = !!models.error;
  const total = Number(queueBudget);
  const loopOpts = { ...opts, maxCostTotal: total > 0 ? total : undefined };
  const labelOk = /^[\w .:/-]{1,50}$/.test(label.trim());
  const progress = briefProgress(state.queue);
  const rounds = state.lastRun?.state ?? [];
  // last-run.json names the checkpoint only while that branch exists, so this survives restarts.
  const checkpoint = busy ? undefined : state.lastRun?.checkpoint;
  const problems = findings.filter((f) => f.level !== "ok");
  useEffect(() => setConfirmRollback(false), [checkpoint]);

  return (
    <div className="repo-view" hidden={hidden}>
      <p className="repo" title={repo}>
        {repo}
      </p>

      {problems.length > 0 && (
        <section className="card notice">
          {problems.map((f) => (
            <p key={f.name} className={`finding ${f.level}`}>
              <span className={`badge ${f.level === "fail" ? "failed" : "warn"}`}>{f.level}</span> <strong>{f.name}</strong>: {f.detail}
            </p>
          ))}
        </section>
      )}

      {checkpoint && (
        <section className="card notice">
          <div className="row">
            <span>
              The last goal ({state.lastRun?.status ?? "unfinished"}) left changes on top of <code>{checkpoint}</code>.
            </span>
            <span className="spacer" />
            {confirmRollback ? (
              <>
                <span className="muted">Discard them? They stay on an orchestrator/discarded-* branch.</span>
                <button
                  className="danger"
                  onClick={() => {
                    setConfirmRollback(false);
                    call("rollback");
                  }}
                >
                  Roll back
                </button>
                <button onClick={() => setConfirmRollback(false)}>Cancel</button>
              </>
            ) : (
              <button className="danger" onClick={() => setConfirmRollback(true)}>
                Roll back to checkpoint…
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <textarea
          placeholder="Goal (e.g. add a login page with a /auth API; include Figma link if any)"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
        />
        <div className="row">
          <label>
            Power
            <select value={power} onChange={(e) => setPower(e.target.value as Power)}>
              {POWERS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            Max rounds
            <input type="number" min={1} max={20} value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))} />
          </label>
          <label title="Stop the goal once agent calls have cost this much (USD). Empty: no limit.">
            Max $
            <input type="number" min={0} step={0.5} placeholder="none" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} /> Plan only
          </label>
          <span className="spacer" />
          <button
            disabled={busy || badSettings}
            title="Read-only: the architect studies the repo and writes .orchestrator/brief.md (stack, layout, conventions, commands), which every later goal and its agents reuse. Runs at this power tier; one agent call."
            onClick={() => call("learn", opts)}
          >
            Learn repo
          </button>
          <button
            disabled={busy || badSettings}
            title="Proposes what orch learned here (the project brief and lasting notes) as a section of CLAUDE.md, committed on an orchestrator/claude-md-* branch for you to review and merge. Your working tree is not touched. One agent call."
            onClick={() => call("share", opts)}
          >
            Share to CLAUDE.md
          </button>
          <button
            disabled={!goal.trim()}
            onClick={async () => {
              if (await call("add", { goal })) setGoal("");
            }}
          >
            Add to queue
          </button>
          <button className="primary" disabled={busy || !goal.trim() || badSettings} onClick={() => call("run", { goal, ...opts })}>
            Run now
          </button>
        </div>
        <SettingsPanel repo={repo} power={power} settings={settings} onChange={setSettings} />
        <BriefBox repo={repo} busy={busy} disabled={badSettings} proposal={session.proposal} call={call} opts={loopOpts} />
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <div className="row">
          <h2>Queue</h2>
          <span className="spacer" />
          <label title="A budget for all the goals the queue runs together (Process queue, Loop, Queue and start); it stops before the next goal once spent. Each goal's own Max $ still applies. Empty: no limit.">
            Budget $
            <input type="number" min={0} step={1} placeholder="none" value={queueBudget} onChange={(e) => setQueueBudget(e.target.value)} />
          </label>
          {/* "Plan only" would leave each goal pending and replan it forever, so the loop refuses it. */}
          <button
            disabled={busy || dryRun || badSettings}
            title={dryRun ? "Untick Plan only to process the queue" : ""}
            onClick={() => call("loop", { ...loopOpts, untilEmpty: true })}
          >
            Process queue
          </button>
          <label title="Open GitHub issues with this label become goals (needs gh, logged in). Anyone who can set the label can direct the agents, so use one only people you trust can set. Loop (watch) keeps pulling new ones in.">
            Issues label
            <input placeholder="e.g. orch" value={label} onChange={(e) => saveLabel(e.target.value)} />
          </label>
          <button disabled={!labelOk} title="Queue the open issues with this label (each once)" onClick={() => call("intake", { github: label.trim() })}>
            Import issues
          </button>
          <button
            disabled={busy || dryRun || badSettings}
            title={dryRun ? "Untick Plan only to process the queue" : labelOk ? `Keeps running, and pulls new issues labelled "${label.trim()}" in` : ""}
            onClick={() => call("loop", { ...loopOpts, intakeLabel: labelOk ? label.trim() : undefined })}
          >
            Loop (watch)
          </button>
        </div>
        {progress && (
          <div className="progress" title="The goals of the latest brief">
            <div className="bar" aria-hidden>
              <span className="done" style={{ width: `${(100 * progress.done) / progress.total}%` }} />
              <span className="failed" style={{ width: `${(100 * (progress.failed + progress.blocked)) / progress.total}%` }} />
            </div>
            <p>
              <strong>
                {progress.done} of {progress.total} goals done
              </strong>
              {progress.failed > 0 && <> · {progress.failed} failed</>}
              {progress.blocked > 0 && <> · {progress.blocked} blocked</>} · {usd(progress.cost)} spent
              {progress.secondsLeft !== undefined && progress.done + progress.failed + progress.blocked < progress.total && (
                <> · {leftText(progress.secondsLeft)}</>
              )}
              {progress.running && <span className="muted"> · now #{progress.running.id}</span>}
            </p>
          </div>
        )}
        {state.queue.length ? (
          <ul className="queue">
            {state.queue.map((i) => (
              <li key={i.id}>
                <span className={`badge ${i.status === "blocked" ? "warn" : i.status}`}>{i.status}</span>
                <span>
                  #{i.id} {i.goal}
                  {i.after?.length ? <span className="muted"> (after {i.after.map((d) => `#${d}`).join(", ")})</span> : null}
                  {i.issue ? <span className="muted"> · issue #{i.issue}</span> : null}
                  {i.priority && i.priority !== 3 ? (
                    <span className="muted" title="Priority from the issue's labels: p1 runs first">
                      {" "}
                      · p{i.priority}
                    </span>
                  ) : null}
                </span>
                {i.note && <span className="note">{i.note}</span>}
                {(i.status === "failed" || i.status === "blocked") && (
                  <button
                    title="Put it back in the queue, with the goals it blocked (after you fixed what stopped it)"
                    onClick={() => call("retry", { id: i.id })}
                  >
                    Retry
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Queue empty</p>
        )}
      </section>

      {run ? (
        <RunPanel run={run} onAnswer={(b) => call("approve", b)} />
      ) : (
        <section className="card">
          <div className="row">
            <h2>Last run{state.lastRun ? `: ${state.lastRun.goal.slice(0, 60)}` : ""}</h2>
            {state.lastRun?.status && (
              <span className={`badge ${state.lastRun.status === "passed" ? "done" : state.lastRun.status === "running" ? "running" : "failed"}`}>
                {state.lastRun.status}
              </span>
            )}
            <span className="spacer" />
            {state.lastRun?.cost !== undefined && <span className="muted">${state.lastRun.cost.toFixed(2)}</span>}
          </div>
          {rounds.length ? (
            rounds.map((r) => (
              <div key={r.round} className="round">
                <div className="row">
                  <strong>Round {r.round}</strong>
                  {r.power && <span className="badge">{r.power}</span>}
                  <span className={`badge ${r.passed ? "done" : "failed"}`}>{r.passed ? "QA passed" : "QA failed"}</span>
                  <span className="spacer" />
                  {r.cost !== undefined && <span className="muted">${r.cost.toFixed(2)}</span>}
                </div>
                <p>{r.plan}</p>
                {r.touched.length > 0 && <p className="muted">Touched: {r.touched.join(", ")}</p>}
                {r.failures.length > 0 && (
                  <ul className="failures">
                    {r.failures.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))
          ) : (
            <p className="muted">No completed rounds yet</p>
          )}
        </section>
      )}

      <section className="card">
        <div className="row">
          <h2>Live output</h2>
          {state.running && <span className="badge running">{state.running.label}</span>}
          {state.queued && <span className="badge warn">waiting: {state.waitReason ?? "free slot"}</span>}
          <span className="spacer" />
          {state.running?.label === "queue loop" && (
            <button title="Let the current goal finish, then stop the queue (pending goals stay pending)" onClick={() => call("stop-after")}>
              Stop after this goal
            </button>
          )}
          <button className="danger" disabled={!busy} onClick={() => call("stop")}>
            {state.queued && !state.running ? "Cancel" : "Stop"}
          </button>
          <button onClick={() => call("clear-log")}>Clear</button>
        </div>
        <pre ref={logRef} className="log">
          {log.join("\n") || "No output yet"}
        </pre>
      </section>
    </div>
  );
}
