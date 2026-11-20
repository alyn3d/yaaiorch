// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useCallback, useEffect, useState } from "react";
import { transport } from "./transport";

/** `Bash(npm install yaml)` -> ["Bash", "npm install yaml", false]; `Bash(npm install:*)` -> [..., "npm install", true]. */
const split = (rule: string): [string, string, boolean] => {
  const m = /^(\w+)\((.*)\)$/.exec(rule);
  if (!m) return ["", rule, false];
  const prefix = /^(.*):\*$/.exec(m[2]);
  return prefix ? [m[1], prefix[1], true] : [m[1], m[2], false];
};

/** The repo's always-allowed commands (config `allow`, filled by Agent M's "Always allow"), each removable. */
export function AllowedCommands({ repo, busy }: { repo: string; busy: boolean }) {
  const [rules, setRules] = useState<string[] | null>(null);
  const [working, setWorking] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(
    async (remove?: string) => {
      setError("");
      try {
        setRules((await transport.allowed(repo, remove)).allow);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [repo],
  );
  useEffect(() => {
    setRules(null);
    void load();
  }, [load, busy]);

  const remove = async (rule: string) => {
    setWorking(rule);
    await load(rule);
    setWorking("");
  };

  return (
    <details className="models">
      <summary>Always-allowed commands {rules && <span className="muted">({rules.length})</span>}</summary>
      <p className="muted">
        Commands that run without asking in this repo, added with <strong>Always allow</strong> on the Agent M page (config <code>allow</code>). Remove one and
        Agent M asks again next time.
      </p>
      {rules?.length === 0 && <p className="muted">None yet.</p>}
      {rules && rules.length > 0 && (
        <ul className="allowed-commands">
          {rules.map((rule) => {
            const [tool, command, any] = split(rule);
            return (
              <li key={rule}>
                <code title={rule}>
                  {tool === "PowerShell" ? "PS> " : tool ? "$ " : ""}
                  {command}
                  {any && " …"}
                </code>
                {any && (
                  <span className="badge warn" title="Any command starting with these words runs without asking">
                    any arguments
                  </span>
                )}
                <button className="ghost danger" disabled={!!working} onClick={() => void remove(rule)} aria-label={`Remove ${rule}`}>
                  {working === rule ? "Removing…" : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
