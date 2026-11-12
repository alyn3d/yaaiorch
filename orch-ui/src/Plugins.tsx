import { useEffect, useState } from "react";
import { transport } from "./transport";
import type { Plugin } from "./types";

/** Which of the user's Claude Code plugins and hooks the agents get. Defaults: everything on (as in Claude Code). */
export type PluginSettings = { on: boolean; off: string[]; hooks: boolean };
export const DEFAULT_PLUGINS: PluginSettings = { on: true, off: [], hooks: true };

/** What orch gets: nothing when it is all default, so runs behave as before. */
export function pluginOpts(p: PluginSettings): { off: boolean; disable: string[]; hooks: boolean } | undefined {
  if (p.on && !p.off.length && p.hooks) return undefined;
  return { off: !p.on, disable: p.on ? p.off : [], hooks: p.hooks };
}

const tok = (n?: number) => (n === undefined ? "" : n >= 1000 ? `~${(n / 1000).toFixed(1)}k tok` : `~${n} tok`);

/**
 * The repo's Claude Code plugins with a switch each, a switch for all of them and one for hooks.
 * The list loads when the section is first opened (one CLI call per plugin, so it takes a few seconds).
 */
export function PluginsPanel({ repo, value, onChange }: { repo: string; value: PluginSettings; onChange: (p: PluginSettings) => void }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Plugin[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = (fresh = false) => {
    setLoading(true);
    setError("");
    transport.plugins(repo, fresh).then(
      (l) => (setList(l), setLoading(false)),
      (e) => (setError((e as Error).message), setLoading(false)),
    );
  };
  useEffect(() => {
    if (open && !list && !loading && !error) load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const usable = (list ?? []).filter((p) => p.enabled);
  const active = usable.filter((p) => value.on && !value.off.includes(p.id));
  const saved = usable.filter((p) => !active.includes(p)).reduce((n, p) => n + (p.tokens ?? 0), 0);
  const summary = !value.on ? "all off" : value.off.length ? `${value.off.length} off` : "all on";
  const toggle = (id: string, on: boolean) => onChange({ ...value, off: on ? value.off.filter((x) => x !== id) : [...value.off, id] });

  return (
    <details className="models plugins" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        Plugins{" "}
        {pluginOpts(value) ? <span className="badge warn">{summary}{value.hooks ? "" : ", no hooks"}</span> : <span className="muted">(as in Claude Code)</span>}
      </summary>
      <div className="row plugin-head">
        <label className="check switch" title="Off: agents run without any of your Claude Code plugins">
          <input type="checkbox" role="switch" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
          Plugins for agents
        </label>
        <label className="check" title="Hooks from your Claude Code settings and from plugins (SessionStart, UserPromptSubmit, …). Off disables all of them for the agents, including this repo's project hooks.">
          <input type="checkbox" checked={value.hooks} onChange={(e) => onChange({ ...value, hooks: e.target.checked })} />
          Hooks
        </label>
        <span className="spacer" />
        {list && <button type="button" onClick={() => load(true)} disabled={loading}>Refresh</button>}
      </div>
      {loading && <p className="muted">Reading plugins… (one Claude Code call per plugin)</p>}
      {error && <p className="error">{error}</p>}
      {list && (
        <ul className="plugin-list">
          {list.map((p) => {
            const on = value.on && p.enabled && !value.off.includes(p.id);
            return (
              <li key={p.id} className={p.enabled ? "" : "unavailable"}>
                <label className="check" title={p.enabled ? p.id : `${p.id} is disabled in Claude Code itself`}>
                  <input type="checkbox" checked={on} disabled={!value.on || !p.enabled} onChange={(e) => toggle(p.id, e.target.checked)} />
                  <span className="plugin-name">{p.name}</span>
                </label>
                <span className="muted">{p.id.includes("@") ? p.id.split("@")[1] : ""} · {p.scope}</span>
                <span className="spacer" />
                <span className="cost">{p.enabled ? tok(p.tokens) : "off in Claude Code"}</span>
              </li>
            );
          })}
          {!list.length && <li className="muted">No plugins installed.</li>}
        </ul>
      )}
      <p className="muted">
        Only affects this repo's agents; Claude Code itself is unchanged.{" "}
        {list && saved > 0 && <>Off here saves {tok(saved)} of context per agent call.</>}
        Token figures are each plugin's always-on context; text that hooks inject (for example a session-start message) comes on top.
      </p>
    </details>
  );
}
