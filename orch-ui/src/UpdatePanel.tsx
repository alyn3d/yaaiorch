// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

import { useState } from "react";
import { isTauri } from "./transport";
import { Markdown } from "./AgentText";
import { checkForUpdates, downloadAndInstallUpdate, isUpdateInProgress, type UpdateInfo, type UpdateProgress } from "./updater";

/** App updates (desktop only), shown in the About dialog. `busy`: a run is active, so installing (which restarts the app) waits. */
export function UpdatePanel({ busy }: { busy: boolean }) {
  const [status, setStatus] = useState<"idle" | "checking" | "up-to-date" | "available" | "downloading" | "installing" | "error">("idle");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string>("");

  const handleCheckForUpdates = async () => {
    if (status !== "idle" && status !== "error" && status !== "up-to-date") return;
    if (isUpdateInProgress()) return;

    setStatus("checking");
    setError("");
    setUpdateInfo(null);
    setProgress(null);

    try {
      const info = await checkForUpdates();
      setUpdateInfo(info);

      if (info.availableVersion && info.availableVersion !== info.currentVersion) {
        setStatus("available");
      } else {
        setStatus("up-to-date");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to check for updates";
      setError(message);
      setStatus("error");
    }
  };

  const handleDownloadAndInstall = async () => {
    if (status !== "available") return;
    if (isUpdateInProgress()) return;

    setStatus("downloading");
    setError("");
    setProgress({ bytesDownloaded: 0, totalBytes: 0, percentage: 0 });

    try {
      await downloadAndInstallUpdate((p) => {
        setProgress(p);
        setStatus(p.percentage === 100 ? "installing" : "downloading");
      });
      // Note: relaunch will close the app, so we might not reach here
      setStatus("idle");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to download and install update";
      setError(message);
      setStatus("error");
      setProgress(null);
    }
  };

  const isLoading = status === "checking" || status === "downloading" || status === "installing";
  const checkDisabled = isLoading || isUpdateInProgress();
  const installDisabled = busy || checkDisabled;

  if (!isTauri) {
    return null;
  }

  return (
    <div className="update-panel">
      {updateInfo?.availableVersion && updateInfo.availableVersion !== updateInfo.currentVersion && (
        <div className="row">
          <div className="update-status">
            <div className="version-display">
              <span className="available-version">
                Update available: <strong>{updateInfo.availableVersion}</strong>
              </span>
            </div>
          </div>
        </div>
      )}

      {status === "available" && updateInfo?.availableVersion && (
        <div className="row">
          <div className="update-info">
            {updateInfo.releaseNotes && (
              <details className="release-notes">
                <summary>Release notes</summary>
                {/* Plain Markdown, never HTML: the notes come from the network. */}
                <Markdown className="notes-content" text={updateInfo.releaseNotes} />
              </details>
            )}
          </div>
        </div>
      )}

      {status === "available" && busy && (
        <div className="row">
          <p className="muted">Installing restarts the app; wait until no repo or group is running.</p>
        </div>
      )}

      {(status === "downloading" || status === "installing") && progress && (
        <div className="row">
          <div className="download-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress.percentage}%` }} />
            </div>
            <span className="progress-text">{progress.percentage}%</span>
            {progress.totalBytes > 0 && (
              <span className="progress-size">
                {(progress.bytesDownloaded / 1024 / 1024).toFixed(1)} MB / {(progress.totalBytes / 1024 / 1024).toFixed(1)} MB
              </span>
            )}
          </div>
        </div>
      )}

      {status === "installing" && (
        <div className="row">
          <div className="installing-status">
            <span className="spinner" aria-hidden="true">
              ⟳
            </span>
            Installing update...
          </div>
        </div>
      )}

      {error && (
        <div className="row">
          <p className="error" role="alert">
            {error}
          </p>
        </div>
      )}

      {status === "up-to-date" && (
        <div className="row">
          <p className="muted">You are running the latest version.</p>
        </div>
      )}

      <div className="row update-actions">
        {(status === "idle" || status === "error" || status === "up-to-date") && (
          <button onClick={handleCheckForUpdates} disabled={checkDisabled} title="Check GitHub Releases for a newer version">
            Check for updates
          </button>
        )}

        {status === "available" && (
          <button
            onClick={handleDownloadAndInstall}
            disabled={installDisabled}
            title={busy ? "Installing restarts the app: wait until no run is active" : "Download and install the update"}
          >
            {`Update to ${updateInfo?.availableVersion}`}
          </button>
        )}

        {status === "downloading" && (
          <button disabled title="Installation in progress">
            {`Downloading... (${progress?.percentage}%)`}
          </button>
        )}

        {status === "installing" && (
          <button disabled title="Installation in progress">
            Installing...
          </button>
        )}

        {status === "error" && (
          <button onClick={handleCheckForUpdates} disabled={checkDisabled} title="Retry checking for updates">
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
