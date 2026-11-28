// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useState } from "react";
import type { AccountStatus, Global, Profile } from "./types";
import type { Session } from "./useOrch";
import { transport } from "./transport";
import { baseName, usd } from "./repoStatus";
import { clock } from "./Limits";
import { loginText, profileId } from "./accountText";

/** A number saved on Enter or blur; empty is none. */
function BudgetField({ value, onSave }: { value: number | undefined; onSave: (v: number | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft === null) return;
    const v = draft.trim() === "" ? null : Number(draft);
    setDraft(null);
    if (v === null || (Number.isFinite(v) && v > 0)) onSave(v);
  };
  return (
    <label title="This account's own daily budget in USD: its runs get what is left as their cost cap, and new runs on it wait once it is used up. Empty: none.">
      Daily $
      <input
        className="limit"
        inputMode="decimal"
        placeholder="none"
        value={draft ?? (value === undefined ? "" : String(value))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && save()}
      />
    </label>
  );
}

/**
 * Claude accounts (PC only): the default Claude folder and every profile, each a Claude Code login of its own. A repo
 * picks its profile in its own header; here they are added, logged in, renamed, given a budget and removed.
 */
export function AccountsPage({
  profiles,
  accounts,
  refresh,
  sessions,
  order,
  global,
  now,
  guard,
}: {
  profiles: Profile[];
  accounts: Record<string, AccountStatus>;
  refresh: () => Promise<void>;
  sessions: Record<string, Session>;
  order: string[];
  global: Global;
  now: number;
  guard: (fn: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [confirmDelete, setConfirmDelete] = useState("");
  const [checking, setChecking] = useState(false);
  const check = () => {
    setChecking(true);
    void guard(refresh).finally(() => setChecking(false));
  };
  // Check every account when the page opens.
  useEffect(check, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (next: Profile[]) =>
    guard(() => transport.saveProfiles(next.map(({ id, name, configDir, dailyBudget }) => ({ id, name, configDir, dailyBudget }))));
  const reposOn = (id: string | null) => order.filter((r) => (sessions[r]?.state.profile ?? null) === id);
  const add = async () => {
    if (!name.trim()) return;
    const id = profileId(
      name,
      profiles.map((p) => p.id),
    );
    if (await guard(() => transport.saveProfiles([...profiles, { id, name: name.trim(), configDir: folder.trim() || undefined } as Profile]))) {
      setName("");
      setFolder("");
      void guard(refresh);
    }
  };

  const row = (id: string | null, p?: Profile) => {
    const key = id ?? "";
    const a = accounts[key];
    const login = loginText(a);
    const limits = global.accounts?.[key];
    const repos = reposOn(id);
    const busy = repos.some((r) => sessions[r]?.state.running || sessions[r]?.state.queued);
    return (
      <section key={key} className="card account">
        <div className="card-head">
          <h3>{p ? p.name : "Default"}</h3>
          <span className={`badge ${login.tone}`}>{login.text}</span>
          <span className="spacer" />
          <button
            className={a?.loggedIn === false ? "primary" : undefined}
            disabled={!!a?.pending}
            title={
              a?.loggedIn
                ? "Log this folder in with a different Claude account: opens a terminal window on this PC running “claude auth login”. Finish there; this page updates when it lands."
                : "Opens a terminal window on this PC running “claude auth login” for this account's folder. Finish the login there; this page updates when it lands."
            }
            onClick={() => guard(() => transport.profileLogin(id))}
          >
            {a?.loggedIn ? "Switch account" : "Log in"}
          </button>
        </div>
        <p className="muted small">
          Claude folder: <code>{a?.configDir ?? p?.configDir ?? "~/.claude"}</code>
        </p>
        {limits && (
          <p className="muted small">
            Today: {usd(limits.budget.spent)}
            {limits.budget.limit !== null ? ` of ${usd(limits.budget.limit)}` : ""}
            {limits.usage.fiveHour ? ` · 5-hour usage ${limits.usage.fiveHour.pct}%` : ""}
            {limits.usage.week ? ` · weekly ${limits.usage.week.pct}%` : ""}
            {limits.usageLimit && limits.usageLimit.until > now ? ` · usage limit until ${clock(limits.usageLimit.until)}` : ""}
          </p>
        )}
        <p className="muted small">
          {repos.length
            ? `Used by ${repos.map(baseName).join(", ")}`
            : p
              ? "No open repo uses it yet; pick it in a repo's header."
              : "Repos without a profile use it."}
        </p>
        {p && (
          <div className="row account-edit">
            <label>
              Name
              <input
                defaultValue={p.name}
                maxLength={60}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== p.name) void save(profiles.map((x) => (x.id === p.id ? { ...x, name: v } : x)));
                }}
              />
            </label>
            <BudgetField
              value={p.dailyBudget}
              onSave={(v) => void save(profiles.map((x) => (x.id === p.id ? { ...x, dailyBudget: v === null ? undefined : v } : x)))}
            />
            <span className="spacer" />
            {confirmDelete === p.id ? (
              <>
                <button className="danger" onClick={() => void save(profiles.filter((x) => x.id !== p.id)).then(() => setConfirmDelete(""))}>
                  Remove profile
                </button>
                <button onClick={() => setConfirmDelete("")}>Cancel</button>
              </>
            ) : (
              <button
                className="danger"
                disabled={busy}
                title={
                  busy
                    ? "A repo on this profile runs or waits; stop it first"
                    : "Its repos go back to the default account. The Claude folder and its login stay on disk."
                }
                onClick={() => setConfirmDelete(p.id)}
              >
                Remove…
              </button>
            )}
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="page accounts-page">
      <header className="page-head">
        <h2>Claude accounts</h2>
        <p className="muted">
          Use a different Claude login per repo, for example a work account for work repos and your own for the rest. Each profile keeps its own Claude folder
          (login, settings, plugins, agents), usage limit and daily budget. A repo picks its profile in its header; the rest use the default account.
        </p>
      </header>
      <div className="row">
        <span className="spacer" />
        <button className="ghost" disabled={checking} onClick={check}>
          {checking ? "Checking…" : "Check logins"}
        </button>
      </div>
      {row(null)}
      {profiles.map((p) => row(p.id, p))}
      <section className="card">
        <h3>Add a profile</h3>
        <form
          className="row account-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <label>
            Name
            <input placeholder="Work" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </label>
          <label title="Optional: an existing Claude folder to use. Empty: a new one under ~/.yaaiorch/profiles.">
            Claude folder
            <input placeholder="new folder" value={folder} onChange={(e) => setFolder(e.target.value)} />
          </label>
          <button className="primary" type="submit" disabled={!name.trim()}>
            Add
          </button>
        </form>
        <p className="muted small">
          A new profile starts logged out: add it, then Log in. Its plugins, MCP servers and your own agents are set up separately from the default account.
        </p>
      </section>
    </div>
  );
}
