import { useState } from "react";
import type { Power } from "./types";
import { transport } from "./transport";

const POWERS: Power[] = ["max", "heavy", "balanced", "economy"];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PARENT_KEY = "yaaiorch.newProjectParent";

/**
 * Start a project from a spec: a new folder in `parent`, opened as a repo tab, where `orch new` creates git, SPEC.md
 * and a queue of goals (the scaffold first) with suggested checks. With "Start building", the loop runs right away.
 */
export function NewProjectDialog({ onCreated, onClose }: { onCreated: (repo: string) => void; onClose: () => void }) {
  const [parent, setParent] = useState(() => {
    try {
      return localStorage.getItem(PARENT_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [name, setName] = useState("");
  const [spec, setSpec] = useState("");
  const [setup, setSetup] = useState("");
  const [power, setPower] = useState<Power>("heavy");
  const [maxCost, setMaxCost] = useState("");
  const [total, setTotal] = useState("");
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const nameOk = NAME.test(name.trim());
  const ready = !!parent.trim() && nameOk && !!spec.trim();
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const cap = Number(maxCost);
      const all = Number(total);
      const repo = await transport.newProject({
        parent: parent.trim(),
        name: name.trim(),
        spec,
        setup: setup.trim() || undefined,
        start,
        power,
        maxCost: cap > 0 ? cap : undefined,
        maxCostTotal: start && all > 0 ? all : undefined,
      });
      try {
        localStorage.setItem(PARENT_KEY, parent.trim());
      } catch {
        /* storage blocked */
      }
      onCreated(repo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
        aria-labelledby="new-project-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="card-head">
          <h2 id="new-project-title">New project</h2>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <p className="muted">
          A new folder with git, your spec as <code>SPEC.md</code>, and the spec split by the architect into queued goals (the scaffold first) with suggested
          checks. It opens as a tab; review the queue there, or let it start building right away.
        </p>
        <div className="row">
          <label className="grow">
            Create in
            <input autoFocus placeholder="Parent folder, e.g. D:\Projects" value={parent} onChange={(e) => setParent(e.target.value)} />
          </label>
          {transport.canPickRepo && (
            <button
              onClick={async () => {
                const p = await transport.pickFolder();
                if (p) setParent(p);
              }}
            >
              Browse…
            </button>
          )}
          <label>
            Name
            <input placeholder="my-app" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        {name && !nameOk && <p className="error">Name: letters, digits, dots, dashes and underscores (starting with a letter or digit).</p>}
        <textarea
          rows={10}
          placeholder="The spec: what to build, the stack if you have a preference, the features, anything that matters"
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
        />
        <div className="row">
          <label title="Installs dependencies when a manifest changes, run by orch before the checks (agents never install). It runs packages' install scripts with your rights; --ignore-scripts is safer. Empty: no dependencies are installed.">
            Setup
            <input placeholder="e.g. npm install (optional)" value={setup} onChange={(e) => setSetup(e.target.value)} />
          </label>
          <label>
            Power
            <select value={power} onChange={(e) => setPower(e.target.value as Power)}>
              {POWERS.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label title="Budget per goal, and for splitting the spec (USD). Empty: no limit.">
            Max $ per goal
            <input type="number" min={0} step={0.5} placeholder="none" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} />
          </label>
          <label title="With Start building: a budget for all the goals together; the queue stops before the next goal once it is spent (USD). Empty: no limit.">
            Total $
            <input type="number" min={0} step={1} placeholder="none" value={total} disabled={!start} onChange={(e) => setTotal(e.target.value)} />
          </label>
          <label className="check" title="Run the queue until it is empty as soon as the goals are queued">
            <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start building right away
          </label>
          <span className="spacer" />
          <button className="primary" disabled={busy || !ready} onClick={create}>
            Create project
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    </div>
  );
}
