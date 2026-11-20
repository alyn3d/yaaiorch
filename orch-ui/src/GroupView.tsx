// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useRef, useState } from "react";
import type { GroupConfig, GroupRole, GroupView as Group, Power } from "./types";
import { transport, type GroupForm } from "./transport";
import { baseName, usd } from "./repoStatus";
import type { Session } from "./useOrch";

const POWERS: Power[] = ["max", "heavy", "balanced", "economy"];
const ROLES: GroupRole[] = ["backend", "frontend"];
const GROUP_NAME = /^[a-z0-9-]+$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The same folder on Windows whatever the case or slashes. */
export const samePath = (a: string, b: string) => {
  const norm = (p: string) =>
    p
      .replace(/[\\/]+$/, "")
      .replaceAll("\\", "/")
      .toLowerCase();
  return norm(a) === norm(b);
};

type GroupOpts = { power: Power; maxRounds: number; maxCost: string; approvePlan: boolean; fast: boolean };
const DEFAULTS: GroupOpts = { power: "heavy", maxRounds: 5, maxCost: "", approvePlan: false, fast: true };

/** A group's run options, remembered per group in this browser. */
function useGroupOpts(name: string): [GroupOpts, (o: GroupOpts) => void] {
  const key = `yaaiorch.group:${name}`;
  const [opts, setOpts] = useState<GroupOpts>(() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(key) ?? "{}") };
    } catch {
      return DEFAULTS;
    }
  });
  const save = (o: GroupOpts) => {
    setOpts(o);
    try {
      localStorage.setItem(key, JSON.stringify(o));
    } catch {
      /* storage blocked: not remembered */
    }
  };
  return [opts, save];
}

const stepText = (g: Group) => {
  if (!g.step) return g.contract ? "Contract written" : "Coordinator planning";
  if (g.step === "build") return `Building both repos${g.round && g.round > 1 ? ` (round ${g.round})` : ""}`;
  if (g.step === "integration") return `Integration round ${g.round ?? 1}${g.stepRepo ? `: ${g.stepRepo} against the running backend` : ""}`;
  return `Fix round ${g.round ?? 1}${g.stepRepo ? ` in the ${g.stepRepo}` : ""}`;
};

/** One repo group: its members, the goal box, the run (contract, goals, step, approval, outcome), Stop and Roll back. */
export function GroupView({
  session,
  sessions,
  hidden,
  onOpenRepo,
  onEdit,
}: {
  session: Session;
  sessions: Record<string, Session>;
  hidden: boolean;
  onOpenRepo: (repo: string) => void;
  onEdit: (g: GroupConfig) => void;
}) {
  const { state, log, run } = session;
  const cfg = state.group!;
  const repo = state.repo;
  const group = run?.group;
  const [goal, setGoal] = useState("");
  const [opts, setOpts] = useGroupOpts(cfg.name);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"" | "remove" | "rollback">("");
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el && !hidden) el.scrollTop = el.scrollHeight;
  }, [log, hidden]);

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
  const call = (path: string, body: Record<string, unknown> = {}) => guard(() => transport.call(path, { ...body, repo }));

  const busy = !!state.running || !!state.queued;
  const memberOf = (path: string) => Object.values(sessions).find((s) => !s.state.group && samePath(s.state.repo, path));
  const ownRun = cfg.repos.map((r) => memberOf(r.path)).find((m) => m && (m.state.running || m.state.queued));
  const cap = Number(opts.maxCost);
  const running = run?.status === "running" && !!state.running;
  // A finished group run can be undone in both repos: a passed one, or a failed one whose park kept its checkpoint.
  const canRollback = !busy && !!group && group.ok !== undefined && !group.rolledBack && (group.ok || !!(group.kept && Object.keys(group.kept).length));

  return (
    <div className="repo-view group-view" hidden={hidden}>
      <header className="page-head">
        <div className="page-title">
          <h2>
            {cfg.name} <span className="badge">group</span>
          </h2>
          <p className="path" title={cfg.dir}>
            One goal across a backend and a frontend repo
          </p>
        </div>
        <div className="page-actions">
          <button disabled={busy} onClick={() => onEdit(cfg)}>
            Edit group
          </button>
          {confirm === "remove" ? (
            <>
              <button className="danger" onClick={() => guard(() => transport.removeGroup(cfg.name))}>
                Remove group
              </button>
              <button onClick={() => setConfirm("")}>Cancel</button>
            </>
          ) : (
            <button className="danger" disabled={busy} title="Deletes the group's config; both repos stay as they are" onClick={() => setConfirm("remove")}>
              Remove…
            </button>
          )}
        </div>
      </header>

      <section className="card group-members">
        {ROLES.map((role) => {
          const r = cfg.repos.find((x) => x.role === role);
          if (!r) return null;
          const m = memberOf(r.path);
          return (
            <div key={role} className="group-member">
              <span className={`badge ${role === "backend" ? "be" : "fe"}`}>{role}</span>
              <div className="group-member-body">
                <strong>{baseName(r.path)}</strong>
                <span className="path" title={r.path}>
                  {r.path}
                </span>
                {role === "backend" && (
                  <span className="muted">
                    {r.serve ? (
                      <>
                        serves at <code>{r.serve.url}</code>
                        {r.serve.command ? (
                          <>
                            {" "}
                            via <code>{r.serve.command}</code>
                          </>
                        ) : (
                          " (already running)"
                        )}
                      </>
                    ) : (
                      "no serve URL: the integration check is skipped"
                    )}
                  </span>
                )}
                {role === "frontend" && r.env && Object.keys(r.env).length > 0 && (
                  <span className="muted">
                    env{" "}
                    {Object.entries(r.env).map(([k, v]) => (
                      <code key={k}>
                        {k}={v}
                      </code>
                    ))}
                  </span>
                )}
              </div>
              {m ? (
                <button className="small" onClick={() => onOpenRepo(m.state.repo)}>
                  Open tab
                </button>
              ) : (
                <span className="muted small-note">opens with the first run</span>
              )}
            </div>
          );
        })}
      </section>

      {ownRun && !busy && (
        <section className="callout warn">
          <div className="callout-text">
            <span>{baseName(ownRun.state.repo)} has a run of its own. The group starts once it is done (stop it in its tab to start sooner).</span>
          </div>
        </section>
      )}

      {canRollback && (
        <section className="callout warn">
          <div className="callout-text">
            <span>{group?.ok ? "The last group goal passed and committed in both repos." : "The last group goal failed; a repo's start was kept."}</span>
            {confirm === "rollback" && <span className="muted">Reset both repos to where the run started? Later commits stay on orchestrator/* branches.</span>}
          </div>
          {confirm === "rollback" ? (
            <div className="row">
              <button
                className="danger"
                onClick={() => {
                  setConfirm("");
                  call("rollback");
                }}
              >
                Roll back both
              </button>
              <button onClick={() => setConfirm("")}>Cancel</button>
            </div>
          ) : (
            <button className="danger" onClick={() => setConfirm("rollback")}>
              Roll back both repos…
            </button>
          )}
        </section>
      )}

      <section className="card composer">
        <textarea
          aria-label="Group goal"
          placeholder="A goal across both repos, e.g. add order history: an /orders API and a page that lists them"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={3}
        />
        <div className="composer-bar">
          <label>
            Power
            <select value={opts.power} onChange={(e) => setOpts({ ...opts, power: e.target.value as Power })}>
              {POWERS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label title="Rounds per repo run">
            Rounds
            <input type="number" min={1} max={20} value={opts.maxRounds} onChange={(e) => setOpts({ ...opts, maxRounds: Number(e.target.value) })} />
          </label>
          <label title="Stop once the whole group run has cost this much (USD), split between the repos. Empty: no limit.">
            Max $
            <input type="number" min={0} step={0.5} placeholder="none" value={opts.maxCost} onChange={(e) => setOpts({ ...opts, maxCost: e.target.value })} />
          </label>
          <label className="check" title="Show the coordinator's contract and goals before anything is built">
            <input type="checkbox" checked={opts.approvePlan} onChange={(e) => setOpts({ ...opts, approvePlan: e.target.checked })} /> Approve plan
          </label>
          <label className="check" title="Each repo's first round is one strong agent judged by the checks (falls back to the full loop)">
            <input type="checkbox" checked={opts.fast} onChange={(e) => setOpts({ ...opts, fast: e.target.checked })} /> Fast path
          </label>
          <span className="spacer" />
          <button
            className="primary"
            disabled={busy || !!ownRun || !goal.trim()}
            title={ownRun ? `${baseName(ownRun.state.repo)} has a run of its own` : "Plan the contract, build both repos, then check them together"}
            onClick={async () => {
              const ok = await call("run", {
                goal: goal.trim(),
                power: opts.power,
                maxRounds: Math.min(20, Math.max(1, Math.round(opts.maxRounds) || 1)),
                maxCost: cap > 0 ? cap : undefined,
                approvePlan: opts.approvePlan,
                fast: opts.fast,
              });
              if (ok) setGoal("");
            }}
          >
            Run group goal
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>

      {group ? (
        <GroupRunCard
          run={run!}
          group={group}
          running={running}
          onAnswer={(b) => call("approve", b)}
          onOpenRepo={(p) => memberOf(p) && onOpenRepo(memberOf(p)!.state.repo)}
        />
      ) : (
        <section className="card">
          <p className="empty">No group run yet in this session. Describe a goal above; each repo's own progress shows in its tab.</p>
        </section>
      )}

      <section className="card output">
        <div className="card-head">
          <h3>Live output</h3>
          {state.running && <span className="badge running">{state.running.label}</span>}
          {state.queued && <span className="badge warn">waiting: {state.waitReason ?? "free slot"}</span>}
          <span className="spacer" />
          <button
            className="danger"
            disabled={!busy}
            title="The group stops and parks both repos' work on orchestrator/interrupted-group-* branches"
            onClick={() => call("stop")}
          >
            {state.queued && !state.running ? "Cancel" : "Stop"}
          </button>
          <button className="ghost" onClick={() => call("clear-log")}>
            Clear
          </button>
        </div>
        <pre ref={logRef} className="log" tabIndex={0} aria-label="Live output">
          {log.join("\n") || "No output yet"}
        </pre>
      </section>
    </div>
  );
}

function GroupRunCard({
  run,
  group,
  running,
  onAnswer,
  onOpenRepo,
}: {
  run: NonNullable<Session["run"]>;
  group: Group;
  running: boolean;
  onAnswer: (body: Record<string, unknown>) => Promise<boolean>;
  onOpenRepo: (path: string) => void;
}) {
  const pathOf = (role: GroupRole) => group.repos.find((r) => r.role === role)?.path;
  const status = run.status === "running" && !running ? "failed" : run.status;
  return (
    <section className="card run-card group-run">
      <div className="card-head">
        <h3 className="run-title" title={group.goal}>
          {group.goal.slice(0, 80)}
        </h3>
        <span className={`badge ${status === "running" ? "running" : status === "passed" ? "done" : "failed"}`}>{status}</span>
        <span className="spacer" />
        <span className="cost" title="The coordinator's calls; each repo's own cost shows in its tab">
          coordinator {usd(run.cost)}
        </span>
      </div>
      {status === "running" && <p className="group-step">{stepText(group)}</p>}
      {group.skipped && <p className="muted">Integration skipped: {group.skipped}.</p>}
      {group.failed && <p className="error">Integration failed: {group.failed}</p>}
      {group.external && <p className="muted">Checked against a backend that was already running (no serve command).</p>}
      {group.approval && running && <GroupApproval key={group.approval.round} a={group.approval} onAnswer={onAnswer} />}
      {group.goals && (
        <ul className="group-goals">
          {ROLES.filter((r) => group.goals?.[r]).map((role) => (
            <li key={role}>
              <span className={`badge ${role === "backend" ? "be" : "fe"}`}>{role}</span> {group.goals![role]}
              {pathOf(role) && (
                <button className="small ghost" onClick={() => onOpenRepo(pathOf(role)!)}>
                  Progress
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {group.fault && (
        <aside className="failure-summary">
          <strong>Integration failed: the coordinator blames the {group.fault.side === "both" ? "backend and the frontend" : group.fault.side}</strong>
          <ul className="failures">
            {ROLES.filter((r) => group.fault!.goals[r]).map((r) => (
              <li key={r}>
                {r} fix: {group.fault!.goals[r]}
              </li>
            ))}
          </ul>
        </aside>
      )}
      {group.ok === false && group.reason && <p className="error">{group.reason}</p>}
      {group.parked && Object.values(group.parked).some(Boolean) && (
        <p className="muted">
          Work parked:{" "}
          {ROLES.filter((r) => group.parked?.[r]).map((r) => (
            <span key={r}>
              {r} on <code>{group.parked![r]}</code>{" "}
            </span>
          ))}
          (both repos were reset to where they started)
        </p>
      )}
      {group.kept && Object.keys(group.kept).length > 0 && (
        <p className="error">
          Could not park {Object.keys(group.kept).join(" and ")}: its start is kept on{" "}
          {Object.values(group.kept).map((b) => (
            <code key={b}>{b} </code>
          ))}
          ; Roll back resets it there.
        </p>
      )}
      {group.rolledBack && (
        <p className="muted">
          Rolled back: both repos are at their start.
          {group.rolledBackParked &&
            ROLES.filter((r) => group.rolledBackParked?.[r]).map((r) => (
              <span key={r}>
                {" "}
                {r}'s later work is on <code>{group.rolledBackParked![r]}</code>.
              </span>
            ))}
        </p>
      )}
      {group.contract && (
        <details className="disclosure" open={!!group.approval}>
          <summary>API contract</summary>
          <pre className="contract">{group.contract}</pre>
        </details>
      )}
    </section>
  );
}

/** --approve-plan: the coordinator's contract and goals, with Build it, an editable copy, and Send back with a reason. */
function GroupApproval({ a, onAnswer }: { a: NonNullable<Group["approval"]>; onAnswer: (body: Record<string, unknown>) => Promise<boolean> }) {
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
      if (typeof plan?.contract !== "string" || !plan.contract.trim()) throw new Error("it needs a contract");
      setBad("");
      return answer({ plan });
    } catch (e) {
      setBad(`Not a plan: ${(e as Error).message}`);
    }
  };
  return (
    <div className="approval">
      <div className="row">
        <strong>Group plan (round {a.round}): waiting for you</strong>
        <span className="badge warn">approval</span>
      </div>
      {!editing ? (
        <>
          <ul className="plan">
            {ROLES.filter((r) => a.goals[r]).map((r) => (
              <li key={r}>
                <span className="agent">{r}</span> {a.goals[r]}
              </li>
            ))}
          </ul>
          <pre className="contract">{a.contract}</pre>
        </>
      ) : (
        <>
          <textarea className="plan-edit" rows={16} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
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
                setText(JSON.stringify({ contract: a.contract, goals: a.goals }, null, 2));
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
          title="The coordinator plans again with your reason; the group waits for you again"
          onClick={() => answer({ reject: reason.trim() })}
        >
          Send back
        </button>
      </div>
    </div>
  );
}

/** `NAME=VALUE` lines to an env map; the first bad line, if any. */
export function parseEnv(text: string): { env: Record<string, string>; bad?: string } {
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf("=");
    const k = i > 0 ? line.slice(0, i).trim() : "";
    if (!ENV_NAME.test(k)) return { env, bad: line };
    env[k] = line.slice(i + 1).trim();
  }
  return { env };
}

/** Create a group, or edit one (`initial`; the name stays). Folders come from the open repos or are typed. */
export function GroupDialog({
  initial,
  repos,
  onSaved,
  onClose,
}: {
  initial?: GroupConfig;
  repos: string[];
  onSaved: (name: string) => void;
  onClose: () => void;
}) {
  const be = initial?.repos.find((r) => r.role === "backend");
  const fe = initial?.repos.find((r) => r.role === "frontend");
  const [name, setName] = useState(initial?.name ?? "");
  const [backend, setBackend] = useState(be?.path ?? "");
  const [frontend, setFrontend] = useState(fe?.path ?? "");
  const [serveUrl, setServeUrl] = useState(be?.serve?.url ?? "");
  const [serveCommand, setServeCommand] = useState(be?.serve?.command ?? "");
  const [baseUrl, setBaseUrl] = useState(be?.serve?.baseUrl ?? "");
  const [envText, setEnvText] = useState(() =>
    Object.entries(fe?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const env = parseEnv(envText);
  const nameOk = GROUP_NAME.test(name.trim());
  const ready = nameOk && !!backend.trim() && !!frontend.trim() && !env.bad && (!!serveUrl.trim() || (!serveCommand.trim() && !baseUrl.trim()));
  const save = async () => {
    setBusy(true);
    setError("");
    const form: GroupForm = {
      name: name.trim(),
      backend: backend.trim(),
      frontend: frontend.trim(),
      serveUrl: serveUrl.trim() || undefined,
      serveCommand: serveCommand.trim() || undefined,
      baseUrl: baseUrl.trim() || undefined,
      env: env.env,
    };
    try {
      await transport.saveGroup(form);
      onSaved(form.name);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const folder = (label: string, value: string, set: (v: string) => void, hint: string) => (
    <div className="row">
      <label className="grow">
        {label}
        <input list="group-repos" placeholder={hint} value={value} onChange={(e) => set(e.target.value)} />
      </label>
      {transport.canPickRepo && (
        <button
          onClick={async () => {
            const p = await transport.pickFolder();
            if (p) set(p);
          }}
        >
          Browse…
        </button>
      )}
    </div>
  );
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="card new-project modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-dialog-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="card-head">
          <h2 id="group-dialog-title">{initial ? `Edit group ${initial.name}` : "New repo group"}</h2>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted">
          One goal across a backend and a frontend repo: a coordinator writes the API contract, both repos build against it in parallel, then the frontend is
          checked in a browser against the running backend.
        </p>
        <datalist id="group-repos">
          {repos.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <label>
          Name
          <input autoFocus={!initial} disabled={!!initial} placeholder="shop" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {name && !nameOk && <p className="error">Name: lowercase letters, digits and dashes.</p>}
        {folder("Backend repo", backend, setBackend, "Absolute path, e.g. D:\\work\\shop-api")}
        {folder("Frontend repo", frontend, setFrontend, "Absolute path, e.g. D:\\work\\shop-web")}
        <div className="row">
          <label className="grow" title="Where the backend answers once started (localhost only). Empty: no integration check.">
            Backend URL
            <input placeholder="http://localhost:3000/health" value={serveUrl} onChange={(e) => setServeUrl(e.target.value)} />
          </label>
          <label className="grow" title="How the group starts the backend for the integration check. Empty: a backend already running at the URL is used.">
            Start command
            <input placeholder="npm run dev" value={serveCommand} onChange={(e) => setServeCommand(e.target.value)} />
          </label>
          <label title="The backend's base URL for the frontend, when it differs from the origin of the backend URL">
            Base URL
            <input placeholder="optional" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
        </div>
        {!serveUrl.trim() && (serveCommand.trim() || baseUrl.trim()) && <p className="error">A start command or base URL needs the backend URL.</p>}
        <label title="Environment for the frontend's runs, one NAME=VALUE per line. {backend} becomes the backend's base URL.">
          Frontend env
          <textarea rows={3} spellCheck={false} placeholder="VITE_API_URL={backend}" value={envText} onChange={(e) => setEnvText(e.target.value)} />
        </label>
        {env.bad && <p className="error">Not NAME=VALUE (NAME in capitals, digits and _): {env.bad}</p>}
        <div className="row">
          <span className="spacer" />
          <button className="primary" disabled={busy || !ready} onClick={save}>
            {initial ? "Save group" : "Create group"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
