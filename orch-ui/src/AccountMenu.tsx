// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useEffect, useRef, useState } from "react";
import type { Profile } from "./types";

/**
 * "Claude: Work" plus a menu of the accounts (Default and each profile, the current one checked) and the Accounts page.
 * Looks and behaves like OpenIn's menu. `value`: the profile id, null for the default account.
 */
export function AccountMenu({
  value,
  profiles,
  disabled,
  title,
  onPick,
  onManage,
}: {
  value: string | null;
  profiles: Profile[];
  disabled?: boolean;
  title: string;
  onPick: (profile: string | null) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const current = profiles.find((p) => p.id === value)?.name ?? "Default";

  useEffect(() => {
    if (!open) return;
    (menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.current?.querySelector<HTMLButtonElement>("button"))?.focus();
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const pick = (p: string | null) => {
    setOpen(false);
    toggle.current?.focus();
    if (p !== value) onPick(p);
  };
  const keys = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      setOpen(false);
      toggle.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };
  const item = (id: string | null, name: string) => (
    <button key={id ?? ""} role="menuitemradio" aria-checked={id === value} onClick={() => pick(id)}>
      <span className="check" aria-hidden>
        {id === value ? "✓" : ""}
      </span>
      {name}
    </button>
  );

  return (
    <div className="account-menu" ref={wrap}>
      <button ref={toggle} disabled={disabled} title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="muted">Claude:</span> {current}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Claude account" ref={menu} onKeyDown={keys}>
          {item(null, "Default")}
          {profiles.map((p) => item(p.id, p.name))}
          <hr />
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <span className="check" aria-hidden />
            {profiles.length ? "Manage accounts…" : "Add an account…"}
          </button>
        </div>
      )}
    </div>
  );
}
