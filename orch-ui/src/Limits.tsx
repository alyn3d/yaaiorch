import { useState } from "react";
import type { Global, UsageWindow } from "./types";
import { usd } from "./repoStatus";

export const WINDOWS: { key: UsageWindow; short: string; label: string }[] = [
  { key: "fiveHour", short: "5h", label: "5-hour" },
  { key: "week", short: "Week", label: "weekly" },
];
export const clock = (ms: number) => new Date(ms).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** The first window whose latest reading is at or over its cap and has not reset yet. */
export function overCap(g: Global, now: number) {
  for (const w of WINDOWS) {
    const u = g.usage[w.key], cap = g.usageCap[w.key];
    if (u && cap !== null && u.pct >= cap && u.resetsAt > now) return { ...w, ...u, cap };
  }
  return null;
}

/** A number field edited as text and saved on Enter or blur. Empty = none; out-of-range input is dropped. */
function LimitField({ label, title, value, min, max, onSave, suffix }: {
  label: string; title: string; value: number | null; min: number; max: number; suffix?: string;
  onSave: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const v = draft.trim() === "" ? null : Number(draft);
    setDraft(null);
    if (v === null || (Number.isFinite(v) && v >= min && v <= max)) onSave(v);
  };
  return (
    <label title={title}>
      {label}
      <input
        className="limit" inputMode="decimal" placeholder="none"
        value={draft ?? (value === null ? "" : String(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
      {suffix}
    </label>
  );
}

/**
 * Header: the subscription's 5-hour and weekly usage (from the latest agent call in any repo) and
 * today's spend, with a Limits panel for the daily budget and the usage caps.
 */
export function Limits({ g, now, onBudget, onCap }: {
  g: Global; now: number;
  onBudget: (v: number | null) => void;
  onCap: (w: UsageWindow, v: number | null) => void;
}) {
  const overBudget = g.budget.limit !== null && g.budget.spent >= g.budget.limit;
  return (
    <details className="limits">
      <summary title="Usage and spending limits for all repos together">
        {WINDOWS.map((w) => {
          const u = g.usage[w.key];
          const cap = g.usageCap[w.key];
          if (!u || u.resetsAt <= now) return null;
          const tone = cap !== null && u.pct >= cap ? "over" : u.pct >= 90 ? "near" : "";
          return (
            <span key={w.key} className={`meter ${tone}`} title={`Claude ${w.label} usage ${u.pct}%, resets ${clock(u.resetsAt)}${cap !== null ? `; cap ${cap}%` : ""}`}>
              {w.short} {Math.round(u.pct)}%{cap !== null ? <span className="muted">/{cap}</span> : null}
            </span>
          );
        })}
        <span className={`meter ${overBudget ? "over" : ""}`} title="Spent today by all repos (local day)">
          {usd(g.budget.spent)}{g.budget.limit !== null ? <span className="muted">/{usd(g.budget.limit)}</span> : null}
        </span>
        <span className="limits-label">Limits</span>
      </summary>
      <div className="limits-panel">
        <LimitField
          label="Daily $" value={g.budget.limit} min={0.01} max={1e6} onSave={onBudget}
          title="Spending cap for all repos together, per day (local time). Each run's max cost is capped to what is left; when it is used up, new starts wait for tomorrow and a queue stops before its next goal. Empty = no cap."
        />
        {WINDOWS.map((w) => (
          <LimitField
            key={w.key} label={`Pause at ${w.short.toLowerCase()} usage`} suffix="%" value={g.usageCap[w.key]} min={1} max={100}
            onSave={(v) => onCap(w.key, v)}
            title={`When the Claude subscription's ${w.label} usage reaches this percentage, new runs wait and running goals pause before their next agent call, until the window resets (with "Stop" as the usage-limit setting, the goal stops instead). Empty = no cap.`}
          />
        ))}
        <p className="muted">
          Usage comes from the latest agent call in any repo (Claude subscriptions only; API-key logins report none).
          A call already running can go a little past a cap.
        </p>
      </div>
    </details>
  );
}
