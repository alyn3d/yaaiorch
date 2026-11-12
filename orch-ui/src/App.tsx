import { useEffect, useRef, useState } from "react";
import { useOrch } from "./useOrch";
import type { Power } from "./types";
import { RunPanel } from "./RunView";
import { SettingsPanel, modelSpec, useRepoSettings } from "./Settings";

const POWERS: Power[] = ["max", "heavy", "balanced", "economy"];

export function App() {
  const { state, log, run, error, connected, call, pickRepo, canPickRepo, findings } = useOrch();
  const [goal, setGoal] = useState("");
  const [power, setPower] = useState<Power>("heavy");
  const [maxRounds, setMaxRounds] = useState(5);
  const [maxCost, setMaxCost] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const busy = !!state?.running;
  const noRepo = !state?.repo;
  // An empty or out-of-range field must not reach orch.ts as 0 or NaN.
  const cap = Number(maxCost);
  const [settings, setSettings] = useRepoSettings(state?.repo);
  const models = modelSpec(settings);
  const opts = {
    power, maxRounds: Math.min(20, Math.max(1, Math.round(maxRounds) || 1)), dryRun, maxCost: cap > 0 ? cap : undefined,
    models: models.spec, onLimit: settings.onLimit, fast: settings.fast,
  };
  const badSettings = !!models.error;
  const rounds = state?.lastRun?.state ?? [];
  // last-run.json names the checkpoint only while that branch exists, so this survives restarts.
  const checkpoint = busy ? undefined : state?.lastRun?.checkpoint;
  const problems = findings.filter((f) => f.level !== "ok");
  useEffect(() => setConfirmRollback(false), [checkpoint]);

  return (
    <div className="app">
      <header>
        <h1 title="Yet Another AI Orchestrator">YAAIORCH</h1>
        <span className="tagline">Yet Another AI Orchestrator</span>
        <span className="repo" title={state?.repo ?? ""}>{state?.repo ?? "No repo selected"}</span>
        {canPickRepo && <button disabled={busy} onClick={pickRepo}>{state?.repo ? "Change repo…" : "Choose repo…"}</button>}
        <span className={`dot ${connected ? "on" : ""}`} title={connected ? "connected" : "disconnected"} />
      </header>

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
              The last goal ({state?.lastRun?.status ?? "unfinished"}) left changes on top of <code>{checkpoint}</code>.
            </span>
            <span className="spacer" />
            {confirmRollback ? (
              <>
                <span className="muted">Discard them? They stay on an orchestrator/discarded-* branch.</span>
                <button className="danger" onClick={() => { setConfirmRollback(false); call("rollback"); }}>Roll back</button>
                <button onClick={() => setConfirmRollback(false)}>Cancel</button>
              </>
            ) : (
              <button className="danger" onClick={() => setConfirmRollback(true)}>Roll back to checkpoint…</button>
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
              {POWERS.map((p) => <option key={p}>{p}</option>)}
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
          <button disabled={noRepo || !goal.trim()} onClick={() => { call("add", { goal }); setGoal(""); }}>Add to queue</button>
          <button className="primary" disabled={noRepo || busy || !goal.trim() || badSettings} onClick={() => call("run", { goal, ...opts })}>Run now</button>
        </div>
        <SettingsPanel power={power} settings={settings} onChange={setSettings} />
        {error && <p className="error">{error}</p>}
      </section>

      <div className="cols">
        <section className="card">
          <div className="row">
            <h2>Queue</h2>
            <span className="spacer" />
            {/* "Plan only" would leave each goal pending and replan it forever, so the loop refuses it. */}
            <button disabled={noRepo || busy || dryRun || badSettings} title={dryRun ? "Untick Plan only to process the queue" : ""} onClick={() => call("loop", { ...opts, untilEmpty: true })}>Process queue</button>
            <button disabled={noRepo || busy || dryRun || badSettings} title={dryRun ? "Untick Plan only to process the queue" : ""} onClick={() => call("loop", opts)}>Loop (watch)</button>
          </div>
          {state?.queue.length ? (
            <ul className="queue">
              {state.queue.map((i) => (
                <li key={i.id}>
                  <span className={`badge ${i.status}`}>{i.status}</span>
                  <span>#{i.id} {i.goal}</span>
                  {i.note && <span className="note">{i.note}</span>}
                </li>
              ))}
            </ul>
          ) : <p className="muted">Queue empty</p>}
        </section>

      </div>

      {run ? <RunPanel run={run} /> : (
        <section className="card">
          <div className="row">
            <h2>Last run{state?.lastRun ? `: ${state.lastRun.goal.slice(0, 60)}` : ""}</h2>
            {state?.lastRun?.status && <span className={`badge ${state.lastRun.status === "passed" ? "done" : state.lastRun.status === "running" ? "running" : "failed"}`}>{state.lastRun.status}</span>}
            <span className="spacer" />
            {state?.lastRun?.cost !== undefined && <span className="muted">${state.lastRun.cost.toFixed(2)}</span>}
          </div>
          {rounds.length ? rounds.map((r) => (
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
              {r.failures.length > 0 && <ul className="failures">{r.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>}
            </div>
          )) : <p className="muted">No completed rounds yet</p>}
        </section>
      )}

      <section className="card">
        <div className="row">
          <h2>Live output</h2>
          {state?.running && <span className="badge running">{state.running.label}</span>}
          <span className="spacer" />
          <button className="danger" disabled={!busy} onClick={() => call("stop")}>Stop</button>
          <button onClick={() => call("clear-log")}>Clear</button>
        </div>
        <pre ref={logRef} className="log">{log.join("\n") || "No output yet"}</pre>
      </section>
    </div>
  );
}
