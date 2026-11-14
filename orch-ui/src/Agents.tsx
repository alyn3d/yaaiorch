import { useEffect, useState } from "react";
import type { AgentRoster, RosterEntry } from "./types";
import { transport } from "./transport";
import { baseName } from "./repoStatus";

const promptOf = (content: string) => content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").trimStart();
const descriptionOf = (content: string, fallback: string) =>
  /^description:\s*(.*)$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "")?.[1] ?? fallback;

function sourceLabel(source: RosterEntry["source"]) {
  return source === "builtin" ? "Built-in" : source === "user" ? "User-level" : "Project";
}

export function AgentsPage({ repos, repo, onRepoChange }: { repos: string[]; repo: string; onRepoChange: (repo: string) => void }) {
  const [roster, setRoster] = useState<AgentRoster | null>(null);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setRoster(null);
    setError("");
    setLoading(true);
    setEditing(false);
    transport.agents(repo).then(
      (data) => {
        if (!active) return;
        setRoster(data);
        setSelected((name) => (data.agents.some((a) => a.name === name) ? name : (data.agents[0]?.name ?? "")));
        setLoading(false);
      },
      (e) => {
        if (!active) return;
        setError((e as Error).message);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [repo, refresh]);

  const agent = roster?.agents.find((a) => a.name === selected);
  const startEdit = (entry?: RosterEntry) => {
    setError("");
    if (!entry) setSelected("");
    setDraftName(entry?.name ?? "");
    setDraftDescription(entry ? descriptionOf(entry.content, entry.description) : "");
    setDraftPrompt(entry ? promptOf(entry.content) : "");
    setEditing(true);
  };
  const save = async () => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(draftName.trim())) {
      setError("Use a name starting with a letter or number; letters, numbers, dashes and underscores are allowed.");
      return;
    }
    if (!draftDescription.trim() || !draftPrompt.trim()) {
      setError("Add a description and agent instructions before saving.");
      return;
    }
    setSaving(true);
    setError("");
    const name = draftName.trim();
    const content = `---\nname: ${name}\ndescription: ${draftDescription.trim()}\n---\n\n${draftPrompt.trim()}\n`;
    try {
      await transport.saveAgent(repo, name, content);
      setSelected(name);
      setEditing(false);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="agents-page">
      <header className="page-head">
        <div className="page-title">
          <h2>Agent roster</h2>
          <p className="muted">Agents and skills available to this repo’s architect.</p>
        </div>
        <label>
          Repo
          <select aria-label="Repo for agent roster" value={repo} onChange={(e) => onRepoChange(e.target.value)}>
            {repos.map((path) => (
              <option key={path} value={path}>
                {baseName(path)}
              </option>
            ))}
          </select>
        </label>
        <button disabled={loading || saving} onClick={() => setRefresh((n) => n + 1)}>
          Refresh
        </button>
      </header>

      <p className="muted agent-scope">
        Edits are saved as repo-local overrides in <code>.claude/agents/</code>; built-in and user-level definitions are not changed.
      </p>
      {error && (
        <p className="error callout" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="muted">Discovering agents and skills…</p>}
      {!loading && !roster && !error && <p className="empty">Open a repo to view its agents.</p>}

      {roster && (
        <>
          <section className="card">
            <div className="card-head">
              <h3>Agents</h3>
              <span className="count">{roster.agents.length}</span>
              <span className="spacer" />
              <button onClick={() => startEdit()}>+ New agent</button>
            </div>
            <div className="agent-layout">
              <div className="agent-list" aria-label="Agents">
                {roster.agents.map((item) => (
                  <button
                    key={item.name}
                    className={`agent-choice ${selected === item.name && !editing ? "selected" : ""}`}
                    aria-pressed={selected === item.name && !editing}
                    onClick={() => {
                      setSelected(item.name);
                      setEditing(false);
                    }}
                  >
                    <span className="agent-choice-head">
                      <strong>{item.name}</strong>
                      <span className={`badge ${item.source === "project" ? "done" : ""}`}>{sourceLabel(item.source)}</span>
                    </span>
                    <span className="muted">{item.description || "No description"}</span>
                  </button>
                ))}
                {!roster.agents.length && <p className="empty">No agents discovered.</p>}
              </div>
              <div className="agent-detail">
                {editing ? (
                  <>
                    <div className="card-head">
                      <h3>{selected ? (agent?.source === "project" ? "Edit agent" : "Create project override") : "New agent"}</h3>
                      <span className="spacer" />
                      <button disabled={saving} onClick={() => setEditing(false)}>
                        Cancel
                      </button>
                      <button className="primary" disabled={saving} onClick={save}>
                        {saving ? "Saving…" : "Save to repo"}
                      </button>
                    </div>
                    <label className="agent-field">
                      Name
                      <input value={draftName} disabled={!!selected} onChange={(e) => setDraftName(e.target.value)} />
                    </label>
                    <label className="agent-field">
                      Description
                      <input value={draftDescription} onChange={(e) => setDraftDescription(e.target.value)} maxLength={500} />
                    </label>
                    <label className="agent-field">
                      Instructions
                      <textarea value={draftPrompt} onChange={(e) => setDraftPrompt(e.target.value)} rows={18} />
                    </label>
                  </>
                ) : agent ? (
                  <>
                    <div className="card-head">
                      <h3>{agent.name}</h3>
                      <span className="badge">{sourceLabel(agent.source)}</span>
                      <span className="spacer" />
                      <button onClick={() => startEdit(agent)}>{agent.source === "project" ? "Edit" : "Create project override"}</button>
                    </div>
                    <p className="muted">{agent.description || "No description"}</p>
                    <pre className="agent-prompt">{promptOf(agent.content) || "No instructions provided."}</pre>
                  </>
                ) : (
                  <p className="empty">Select an agent to view its instructions.</p>
                )}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Discovered skills</h3>
              <span className="count">{roster.skills.length}</span>
            </div>
            {roster.skills.length ? (
              <ul className="roster-skills">
                {roster.skills.map((skill) => (
                  <li key={skill.name}>
                    <div>
                      <strong>{skill.name}</strong>
                      <p className="muted">{skill.description || "No description"}</p>
                    </div>
                    <span className={`badge ${skill.source === "project" ? "done" : ""}`}>{skill.source === "project" ? "Project" : "User-level"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">No skills discovered in this repo or your Claude Code user folder.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
