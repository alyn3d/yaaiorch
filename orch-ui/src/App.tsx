// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useRef, useState } from "react";
import { notifyOn as notifyOnSaved, setNotifyOn } from "./notify";
import { useOrch } from "./useOrch";
import { RepoView } from "./RepoView";
import { transport } from "./transport";
import { Overview } from "./Overview";
import { NewProjectDialog } from "./NewProject";
import { baseName, repoStatus, usd } from "./repoStatus";
import { Limits, clock, overCap } from "./Limits";
import { AgentsPage } from "./Agents";
import { AgentMPanel, commandsOf, useAgentMChat } from "./AgentM";
import { About } from "./About";
import { ErrorBoundary } from "./ErrorBoundary";
import { GroupDialog, GroupView } from "./GroupView";
import type { GroupConfig } from "./types";

const ACTIVE_KEY = "yaaiorch.activeRepo";
/** The overview tab's key; never a repo path. */
const OVERVIEW = "*overview";
const AGENTS = "*agents";
const AGENT_M = "*agent-m";
export function App() {
  const { sessions, order, groups, maxParallel, setMaxParallel, global, connected, canPickRepo } = useOrch();
  /** The group form: a new group (no `initial`) or an edit. */
  const [groupDialog, setGroupDialog] = useState<{ initial?: GroupConfig } | null>(null);
  /** A group just saved: shown once its session arrives. */
  const [savedGroup, setSavedGroup] = useState("");
  const [notifyOn, setNotifyOnState] = useState(notifyOnSaved);
  const [newProject, setNewProject] = useState(false);
  const [about, setAbout] = useState(false);
  const aboutButton = useRef<HTMLButtonElement>(null);
  const [agentRepo, setAgentRepo] = useState("");
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

  // Keep a valid tab selected as repos open and close. The overview is there from two repos on.
  const showOverview = order.length >= 2;
  const showAgents = order.length > 0;
  const waitingCommands = commandsOf(sessions, order).waiting.length;
  const agentMChat = useAgentMChat();
  const current =
    active === AGENTS && showAgents
      ? AGENTS
      : active === AGENT_M
        ? AGENT_M
        : order.includes(active) || groups.includes(active) || (active === OVERVIEW && showOverview)
          ? active
          : (order[0] ?? "");
  useEffect(() => {
    if (!savedGroup) return;
    const dir = groups.find((g) => sessions[g]?.state.group?.name === savedGroup);
    if (dir) {
      setActive(dir);
      setSavedGroup("");
    }
  }, [savedGroup, groups, sessions]);
  useEffect(() => {
    if (!order.includes(agentRepo)) setAgentRepo(order.includes(active) ? active : (order[0] ?? ""));
  }, [order, active, agentRepo]);
  useEffect(() => {
    try {
      if (current) localStorage.setItem(ACTIVE_KEY, current);
    } catch {
      /* storage blocked: the selection is just not remembered */
    }
  }, [current]);

  // A group run takes a parallel slot like a repo's run.
  const running = [...order, ...groups].filter((r) => sessions[r]?.state.running).length;
  const waiting = [...order, ...groups].filter((r) => sessions[r]?.state.queued).length;

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
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img className="logo" src="/logo-64.png" alt="" width={26} height={26} />
          <div className="brand-text">
            <h1 title="Yet Another AI Orchestrator">YAAIORCH</h1>
            <span className="tagline">AI orchestrator</span>
          </div>
        </div>

        <nav className="nav" aria-label="Repos">
          {showOverview && (
            <button
              className={`nav-item ${current === OVERVIEW ? "active" : ""}`}
              aria-current={current === OVERVIEW ? "page" : undefined}
              onClick={() => setActive(OVERVIEW)}
            >
              <span className="nav-icon" aria-hidden>
                ▦
              </span>
              <span className="nav-label">Overview</span>
              <span className="nav-meta">{order.length}</span>
            </button>
          )}
          {showAgents && (
            <button
              className={`nav-item ${current === AGENTS ? "active" : ""}`}
              aria-current={current === AGENTS ? "page" : undefined}
              onClick={() => {
                setAgentRepo(order.includes(active) ? active : order.includes(agentRepo) ? agentRepo : (order[0] ?? ""));
                setActive(AGENTS);
              }}
            >
              <span className="nav-icon" aria-hidden>
                ◈
              </span>
              <span className="nav-label">Agents</span>
            </button>
          )}
          <button
            className={`nav-item ${current === AGENT_M ? "active" : ""}`}
            aria-current={current === AGENT_M ? "page" : undefined}
            onClick={() => setActive(AGENT_M)}
            title="Agent M: allow or deny the shell commands your agents want to run"
          >
            <span className="nav-icon" aria-hidden>
              𝓂
            </span>
            &nbsp;
            <span className="nav-label">Agent M</span>
            {waitingCommands > 0 && (
              <span className="nav-alert" aria-label={`${waitingCommands} waiting`}>
                {waitingCommands}
              </span>
            )}
          </button>
          <p className="nav-section">Repos</p>
          {order.map((repo) => {
            const s = sessions[repo];
            if (!s) return null;
            const st = repoStatus(s, now);
            const busy = !!s.state.running || !!s.state.queued || !!s.state.inGroup;
            return (
              <div key={repo} className={`nav-item repo-item ${repo === current ? "active" : ""}`} title={`${repo}\n${st.label}`}>
                <button className="nav-main" aria-current={repo === current ? "page" : undefined} onClick={() => setActive(repo)}>
                  <span className={`status ${st.tone}`} aria-hidden />
                  <span className="nav-text">
                    <span className="nav-label">{baseName(repo)}</span>
                    <span className="nav-sub">{st.label}</span>
                  </span>
                </button>
                <button
                  className="nav-close"
                  disabled={busy}
                  aria-label={`Close ${baseName(repo)}`}
                  title={busy ? "Stop this repo's run before closing the tab" : "Close (the repo is not changed)"}
                  onClick={() => guard(() => transport.removeRepo(repo))}
                >
                  ×
                </button>
              </div>
            );
          })}
          {!order.length && <p className="nav-empty">No repo open yet</p>}
          {groups.length > 0 && <p className="nav-section">Groups</p>}
          {groups.map((dir) => {
            const s = sessions[dir];
            const g = s?.state.group;
            if (!s || !g) return null;
            const st = repoStatus(s, now);
            return (
              <div
                key={dir}
                className={`nav-item repo-item ${dir === current ? "active" : ""}`}
                title={[...g.repos.map((r) => `${r.role}: ${r.path}`), st.label].join("\n")}
              >
                <button className="nav-main" aria-current={dir === current ? "page" : undefined} onClick={() => setActive(dir)}>
                  <span className={`status ${st.tone}`} aria-hidden />
                  <span className="nav-text">
                    <span className="nav-label">{g.name}</span>
                    <span className="nav-sub">{st.label}</span>
                  </span>
                </button>
              </div>
            );
          })}
          {canPickRepo || !adding ? (
            <div className="nav-actions">
              <button className="ghost" onClick={() => (canPickRepo ? addRepo() : setAdding(true))} title="Open another repo">
                + Open repo
              </button>
              <button className="ghost" onClick={() => setNewProject(true)} title="Start a project from a spec in a new folder">
                + New project
              </button>
              <button className="ghost" onClick={() => setGroupDialog({})} title="One goal across a backend and a frontend repo">
                + New group
              </button>
            </div>
          ) : (
            <form
              className="nav-add-form"
              onSubmit={(e) => {
                e.preventDefault();
                addRepo();
              }}
            >
              <input
                autoFocus
                placeholder="Path to the repo folder"
                aria-label="Path to the repo folder"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
              />
              <div className="row">
                <button className="primary" type="submit">
                  Open
                </button>
                <button type="button" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </nav>

        <div className="sidebar-foot">
          <div className="foot-row">
            <span className={`dot ${connected ? "on" : ""}`} aria-hidden />
            <span className="muted" title="Repos running now / repos allowed to run at once">
              {connected ? `${running}/${maxParallel} running${waiting ? ` · ${waiting} waiting` : ""}` : "disconnected"}
            </span>
          </div>
          <Limits
            g={global}
            now={now}
            onBudget={(v) => guard(() => transport.setDailyBudget(v))}
            onCap={(w, v) => guard(() => transport.setUsageCap({ ...global.usageCap, [w]: v }))}
          />
          <div className="foot-row">
            <label title="How many repos may run at the same time; further starts wait for a free slot. All repos share one Claude usage limit.">
              Parallel
              <input
                type="number"
                min={1}
                max={16}
                value={maxParallel}
                onChange={(e) => {
                  const n = Math.round(Number(e.target.value));
                  if (n >= 1 && n <= 16) guard(() => setMaxParallel(n));
                }}
              />
            </label>
            <span className="spacer" />
            <label
              className="check switch"
              title="A desktop notification when a goal passes or fails, an agent or plan needs your input, or a run waits for the usage limit (only while this window is not in front)"
            >
              <input type="checkbox" role="switch" checked={notifyOn} onChange={(e) => void setNotifyOn(e.target.checked).then(setNotifyOnState)} /> Notify
            </label>
          </div>
          <button ref={aboutButton} className="ghost" onClick={() => setAbout(true)}>
            About YAAIORCH
          </button>
        </div>
      </aside>

      <main className="main">
        <ErrorBoundary resetKey={current}>
          {about && (
            <About
              busy={running > 0}
              onClose={() => {
                setAbout(false);
                aboutButton.current?.focus();
              }}
            />
          )}
          {error && (
            <p className="error callout" role="alert">
              {error}
            </p>
          )}
          {groupDialog && (
            <GroupDialog
              initial={groupDialog.initial}
              repos={order}
              onClose={() => setGroupDialog(null)}
              onSaved={(name) => {
                setGroupDialog(null);
                setSavedGroup(name);
              }}
            />
          )}
          {newProject && (
            <NewProjectDialog
              onClose={() => setNewProject(false)}
              onCreated={(repo) => {
                setNewProject(false);
                setActive(repo);
              }}
            />
          )}

          {global.usageLimit && global.usageLimit.until > now && (
            <section className="callout warn banner" role="status">
              <div className="callout-text">
                <strong>Claude usage limit reached</strong>
                <span>
                  in {baseName(global.usageLimit.repo)}. New runs in all repos wait until {clock(global.usageLimit.until)}; running ones wait on their own.
                </span>
              </div>
              <button onClick={() => guard(() => transport.clearLimit())} title="Start waiting runs now; if the limit is still on, they hit it again and wait.">
                Try now
              </button>
            </section>
          )}
          {(() => {
            const o = overCap(global, now);
            return (
              o && (
                <section className="callout warn banner" role="status">
                  <div className="callout-text">
                    <strong>Usage cap reached</strong>
                    <span>
                      Claude {o.label} usage is at {o.pct}% (your cap: {o.cap}%). New runs wait and running goals pause before their next agent call until{" "}
                      {clock(o.resetsAt)}.
                    </span>
                  </div>
                  <button
                    onClick={() => guard(() => transport.clearLimit())}
                    title="Forget the reading and start waiting runs now; the next agent call reads the usage again."
                  >
                    Try now
                  </button>
                </section>
              )
            );
          })()}
          {global.budget.limit !== null && global.budget.spent >= global.budget.limit && (
            <section className="callout bad banner" role="status">
              <div className="callout-text">
                <strong>Daily budget used up</strong>
                <span>
                  {usd(global.budget.spent)} of {usd(global.budget.limit)} spent today. New runs wait until tomorrow; raise or clear <em>Daily $</em> to
                  continue now.
                </span>
              </div>
            </section>
          )}

          {order.length === 0 && !newProject && current !== AGENT_M && !groups.includes(current) && (
            <section className="empty-state">
              <img src="/logo-64.png" alt="" width={48} height={48} />
              <h2>No repo open</h2>
              <p className="muted">
                Open a git repo, or start a new project from a spec. Each repo gets its own queue and log; up to {maxParallel} run at the same time.
              </p>
              <div className="row">
                <button className="primary" onClick={() => (canPickRepo ? addRepo() : setAdding(true))}>
                  Open repo
                </button>
                <button onClick={() => setNewProject(true)}>New project</button>
              </div>
            </section>
          )}

          {showOverview && current === OVERVIEW && (
            <Overview sessions={sessions} order={order} now={now} onOpen={setActive} onStop={(repo) => guard(() => transport.call("stop", { repo }))} />
          )}

          {current === AGENTS && <AgentsPage repos={order} repo={agentRepo} onRepoChange={setAgentRepo} />}

          {current === AGENT_M && (
            <AgentMPanel
              sessions={sessions}
              order={order}
              decide={(repo, id, decision) => transport.call("decide-command", { repo, id, decision })}
              chat={agentMChat}
            />
          )}

          {order.map((repo) => sessions[repo] && <RepoView key={repo} session={sessions[repo]} hidden={repo !== current} />)}
          {groups.map(
            (dir) =>
              sessions[dir]?.state.group && (
                <GroupView
                  key={dir}
                  session={sessions[dir]}
                  sessions={sessions}
                  hidden={dir !== current}
                  onOpenRepo={setActive}
                  onEdit={(initial) => setGroupDialog({ initial })}
                />
              ),
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}
