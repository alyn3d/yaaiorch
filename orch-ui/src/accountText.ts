// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

// Pure helpers for the Accounts page (Accounts.tsx), unit-tested.
import type { AccountStatus } from "./types";

/** A profile id from its name: lowercase letters, digits and dashes (what the server accepts), unique among `taken`. */
export function profileId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "profile";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** Who an account is logged in as, in a few words, and the badge tone for it. */
export function loginText(a: AccountStatus | undefined): { text: string; tone: string } {
  if (!a) return { text: "not checked yet", tone: "" };
  if (a.pending) return { text: "login window open: finish it there", tone: "warn" };
  if (a.loggedIn === true)
    return { text: `logged in${a.email ? ` as ${a.email}` : ""}${a.org ? ` · ${a.org}` : ""}${a.plan ? ` · ${a.plan}` : ""}`, tone: "done" };
  if (a.loggedIn === false) return { text: "not logged in", tone: "failed" };
  return { text: "login status unknown", tone: "warn" };
}
