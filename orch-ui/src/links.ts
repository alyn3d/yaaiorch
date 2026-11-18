// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./transport";

/** A link out of the app: the desktop app's webview does not open new windows, so ask the system browser. */
export function openExternal(e: React.MouseEvent, url: string) {
  if (!isTauri || !/^https?:\/\//.test(url)) return;
  e.preventDefault();
  openUrl(url).catch(() => {
    /* nothing to do: the URL is on screen to copy */
  });
}
