// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { check as checkUpdate, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  currentVersion: string;
  availableVersion?: string;
  releaseNotes?: string;
  releaseDate?: string;
}

export interface UpdateProgress {
  bytesDownloaded: number;
  totalBytes: number;
  percentage: number;
}

export type UpdateStatus = "idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "error";

export interface UpdateState {
  status: UpdateStatus;
  info?: UpdateInfo;
  progress?: UpdateProgress;
  error?: string;
}

/** Singleton instance: holds pending update and prevents duplicate operations. */
let pendingUpdate: Update | null = null;
let isOperationInProgress = false;

/** Get the current application version. */
export async function getCurrentVersion(): Promise<string> {
  try {
    const pkg = await import("../package.json", { assert: { type: "json" } });
    return pkg.version;
  } catch {
    // Fallback version
    return "0.6.1";
  }
}

/** Check for available updates from GitHub Releases. */
export async function checkForUpdates(): Promise<UpdateInfo> {
  if (isOperationInProgress) {
    throw new Error("An update operation is already in progress");
  }

  isOperationInProgress = true;
  try {
    const currentVersion = await getCurrentVersion();

    try {
      const update = await checkUpdate();

      if (update) {
        pendingUpdate = update;
        return {
          currentVersion,
          availableVersion: update.version,
          releaseNotes: update.body,
          releaseDate: update.date,
        };
      }

      return {
        currentVersion,
      };
    } catch (error) {
      // Tauri updater throws if no update is available. That's OK.
      if (error instanceof Error && error.message.includes("no update available")) {
        return {
          currentVersion,
        };
      }
      throw error;
    }
  } finally {
    isOperationInProgress = false;
  }
}

/** Download and install the pending update, then relaunch the application. */
export async function downloadAndInstallUpdate(onProgress?: (progress: UpdateProgress) => void): Promise<void> {
  if (!pendingUpdate) {
    throw new Error("No pending update. Call checkForUpdates first.");
  }

  if (isOperationInProgress) {
    throw new Error("An update operation is already in progress");
  }

  isOperationInProgress = true;
  try {
    let totalBytes = 0;
    let downloadedBytes = 0;

    const handleProgress = (event: DownloadEvent) => {
      if (event.event === "Started" && event.data.contentLength) {
        totalBytes = event.data.contentLength;
        downloadedBytes = 0;
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        if (onProgress) {
          const percentage = totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0;
          onProgress({
            bytesDownloaded: downloadedBytes,
            totalBytes,
            percentage,
          });
        }
      }
    };

    // Download and install with progress reporting
    await pendingUpdate.downloadAndInstall(handleProgress);

    // After successful installation, relaunch the application
    // Note: On Windows, the app will exit automatically
    // On macOS/Linux, we explicitly relaunch
    try {
      await relaunch();
    } catch {
      // relaunch may fail or be unnecessary on Windows (app exits), which is OK
    }
  } finally {
    isOperationInProgress = false;
    pendingUpdate = null;
  }
}

/** Cancel the pending update and clear the state. */
export async function cancelUpdate(): Promise<void> {
  if (pendingUpdate) {
    try {
      await pendingUpdate.close();
    } catch {
      // Ignore errors
    }
  }
  pendingUpdate = null;
  isOperationInProgress = false;
}

/** Check if an update operation is currently in progress. */
export function isUpdateInProgress(): boolean {
  return isOperationInProgress;
}

/** Get the pending update info without checking again. */
export function getPendingUpdate(): UpdateInfo | null {
  if (!pendingUpdate) {
    return null;
  }

  return {
    currentVersion: pendingUpdate.currentVersion,
    availableVersion: pendingUpdate.version,
    releaseNotes: pendingUpdate.body,
    releaseDate: pendingUpdate.date,
  };
}
