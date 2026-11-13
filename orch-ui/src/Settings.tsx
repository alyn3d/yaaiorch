import { useEffect, useState } from "react";
import type { Power } from "./types";
import { DEFAULT_PLUGINS, PluginsPanel, type PluginSettings } from "./Plugins";

/** Roles that call a model; mirrors ROLES in orch.ts. */
export const ROLES = ["architect", "impl", "heavy", "qa", "dev"] as const;
export type Role = (typeof ROLES)[number];

/** The power tiers' models per role (mirrors POWER in orch.ts; dev uses the tier's heavy model). */
const TIER_MODELS: Record<Power, Record<Role, string>> = {
  max: { architect: "opus", impl: "opus", heavy: "opus", qa: "opus", dev: "opus" },
  heavy: { architect: "opus", impl: "sonnet", heavy: "opus", qa: "opus", dev: "opus" },
  balanced: { architect: "sonnet", impl: "sonnet", heavy: "opus", qa: "opus", dev: "opus" },
  economy: { architect: "sonnet", impl: "haiku", heavy: "sonnet", qa: "sonnet", dev: "sonnet" },
};

const ROLE_LABELS: Record<Role, string> = {
  architect: "Architect (plans)",
  impl: "Implementers",
  heavy: "Heavy tasks",
  qa: "QA",
  dev: "Fast-path agent",
};

export type RunSettings = {
  /** Empty string: use the tier's model. */
  models: Record<Role, string>;
  /** "be=opus, fe=claude-sonnet-5-5" */
  agentModels: string;
  onLimit: "wait" | "stop";
  fast: boolean;
  /** A read-only critic reviews each plan before building (--critic). */
  critic: boolean;
  /** The critic also reviews each round's change against the goal (--diff-critic). */
  diffCritic: boolean;
  /** A reviewer checks each round's change for bugs and security problems (--review). */
  review: boolean;
  /** Your own reviewer agents instead of the built-in one, comma-separated (--reviewers). */
  reviewers: string;
  plugins: PluginSettings;
};

export const DEFAULT_SETTINGS: RunSettings = {
  models: { architect: "", impl: "", heavy: "", qa: "", dev: "" },
  agentModels: "",
  onLimit: "wait",
  fast: false,
  critic: false,
  diffCritic: false,
  review: false,
  reviewers: "",
  plugins: DEFAULT_PLUGINS,
};

const NAME = /^[\w-]+$/;
const MODEL = /^[\w.:[\]-]+$/;

/** Turn the settings into orch's --model spec, or report what is wrong with them. */
export function modelSpec(s: RunSettings): { spec?: string; error?: string } {
  const pairs: string[] = [];
  for (const role of ROLES) {
    const m = s.models[role].trim();
    if (!m) continue;
    if (!MODEL.test(m)) return { error: `${ROLE_LABELS[role]}: "${m}" is not a model name` };
    pairs.push(`${role}=${m}`);
  }
  for (const part of s.agentModels
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [agent, model, ...rest] = part.split("=").map((x) => x.trim());
    if (!agent || !model || rest.length || !NAME.test(agent) || !MODEL.test(model)) return { error: `agent override "${part}": use agent=model` };
    pairs.push(`${agent}=${model}`);
  }
  return { spec: pairs.join(",") || undefined };
}

/** Settings remembered per repo in this browser (a convenience; nothing breaks without storage). */
export function useRepoSettings(repo: string | null | undefined) {
  const key = `yaaiorch.settings:${repo ?? ""}`;
  const [settings, setSettings] = useState<RunSettings>(DEFAULT_SETTINGS);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      const s = saved ? JSON.parse(saved) : {};
      setSettings({ ...DEFAULT_SETTINGS, ...s, models: { ...DEFAULT_SETTINGS.models, ...s.models }, plugins: { ...DEFAULT_PLUGINS, ...s.plugins } });
    } catch {
      setSettings(DEFAULT_SETTINGS);
    }
  }, [key]);
  const update = (next: RunSettings) => {
    setSettings(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* private mode or storage blocked */
    }
  };
  return [settings, update] as const;
}

export function SettingsPanel({ repo, power, settings, onChange }: { repo: string; power: Power; settings: RunSettings; onChange: (s: RunSettings) => void }) {
  const tier = TIER_MODELS[power];
  const custom = ROLES.filter((r) => settings.models[r].trim()).length + (settings.agentModels.trim() ? 1 : 0);
  const { error } = modelSpec(settings);
  return (
    <>
      <div className="row">
        <label title="What to do when the Claude subscription's usage limit is reached">
          When the usage limit is hit
          <select value={settings.onLimit} onChange={(e) => onChange({ ...settings, onLimit: e.target.value as RunSettings["onLimit"] })}>
            <option value="wait">Wait and continue</option>
            <option value="stop">Stop</option>
          </select>
        </label>
        <label className="check" title="Round 1: one agent does the whole goal, judged by the repo's checks; the full loop runs only if that fails">
          <input type="checkbox" checked={settings.fast} onChange={(e) => onChange({ ...settings, fast: e.target.checked })} /> Fast path
        </label>
        <label
          className="check"
          title="A read-only critic agent reviews each plan before anything is built; a rejected plan goes back to the architect once. One extra call per round (QA's model)."
        >
          <input type="checkbox" checked={settings.critic} onChange={(e) => onChange({ ...settings, critic: e.target.checked })} /> Plan critic
        </label>
        <label
          className="check"
          title="The critic also reviews each round's change against the goal, next to QA; a rejection fails the round. One extra call per round (QA's model), skipped when the checks already failed."
        >
          <input type="checkbox" checked={settings.diffCritic} onChange={(e) => onChange({ ...settings, diffCritic: e.target.checked })} /> Diff critic
        </label>
        <label
          className="check"
          title="A read-only reviewer checks each round's change for bugs and security problems; a rejection fails the round. One extra call per reviewer per round (QA's model)."
        >
          <input type="checkbox" checked={settings.review} onChange={(e) => onChange({ ...settings, review: e.target.checked })} /> Review lens
        </label>
        {settings.review && (
          <label title="Your own reviewer agents (from .claude/agents), comma-separated. Empty: the built-in reviewer.">
            Reviewers
            <input
              placeholder="built-in"
              value={settings.reviewers}
              onChange={(e) => onChange({ ...settings, reviewers: e.target.value.replace(/\s+/g, "") })}
            />
          </label>
        )}
      </div>
      <details className="models">
        <summary>Models {custom ? <span className="badge warn">{custom} custom</span> : <span className="muted">(from the {power} tier)</span>}</summary>
        <datalist id="model-aliases">
          <option value="haiku" />
          <option value="sonnet" />
          <option value="opus" />
        </datalist>
        <div className="model-grid">
          {ROLES.map((role) => (
            <label key={role}>
              {ROLE_LABELS[role]}
              <input
                list="model-aliases"
                placeholder={tier[role]}
                value={settings.models[role]}
                onChange={(e) => onChange({ ...settings, models: { ...settings.models, [role]: e.target.value } })}
              />
            </label>
          ))}
          <label className="wide">
            Per agent
            <input placeholder="be=opus, fe=sonnet" value={settings.agentModels} onChange={(e) => onChange({ ...settings, agentModels: e.target.value })} />
          </label>
        </div>
        <p className="muted">
          Empty fields use the tier. Aliases (haiku, sonnet, opus) move up with the tier when a round gets stuck; full model IDs stay as set.
        </p>
        {error && <p className="error">{error}</p>}
      </details>
      <PluginsPanel repo={repo} value={settings.plugins} onChange={(plugins) => onChange({ ...settings, plugins })} />
    </>
  );
}
