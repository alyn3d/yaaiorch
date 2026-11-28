<!-- SPDX-FileCopyrightText: 2026 alyn3d and contributors -->
<!-- SPDX-License-Identifier: GPL-3.0-only -->

# YAAIORCH Auto-Update System

This document describes the auto-update system for YAAIORCH, which uses the official **Tauri 2 updater plugin** with signed releases from GitHub Releases.

## Architecture

The updater system consists of three main components:

1. **Frontend UI** (`src/UpdatePanel.tsx`, `src/updater.ts`):
   - Shown in the **About YAAIORCH** dialog (app-wide, not per repo); installing waits while any run is active
   - Provides check, download, and install flows
   - Displays update status and progress
   - Handles network errors and signature validation

2. **Backend Rust integration** (`src-tauri/src/main.rs`, `Cargo.toml`):
   - Initializes the Tauri updater plugin
   - Manages update verification and installation
   - Handles platform-specific restart behavior

3. **Release automation** (`.github/workflows/release.yml`):
   - Builds for Windows x64, macOS (one universal build for Intel and Apple Silicon), and Linux x64
   - Signs update artifacts with a private key (`--config src-tauri/tauri.updater.conf.json` turns on
     `createUpdaterArtifacts` for release builds only, so a local `npm run tauri build` needs no key)
   - `tauri-action` (`includeUpdaterJson`) writes the `latest.json` manifest and merges every platform into it
   - Uploads everything to a **draft** GitHub release; you review and publish it by hand

## Security

### Signature Verification

All updates are **cryptographically signed** with minisign (Ed25519). The public key is embedded in the application binary at build time (`tauri.conf.json`). Every update check:

1. Fetches the manifest from GitHub Releases
2. Verifies the manifest signature using the embedded public key
3. Verifies downloaded files match the manifest checksums
4. Only installs if **all signatures are valid**

**Private keys are never embedded in the application.** They are stored only in GitHub Secrets and only used during release builds.

### Key Generation

Signing keys are generated using Tauri's built-in ECDSA key generator:

```bash
cd orch-ui
node scripts/generate-keys.mjs --password "<your-secure-password>"
```

This generates two files in `src-tauri/`:
- `tauri.key`: Private key (keep secure, store in GitHub Secret)
- `tauri.key.pub`: Public key (safe to commit)

**Important:** Only generate keys once. Store the private key securely as a GitHub Secret.

## Setup

### 1. Generate Signing Keys

```bash
cd orch-ui
node scripts/generate-keys.mjs --password "your-secure-password-here"
```

The script outputs:
- **PUBLIC_KEY**: Copy this to `tauri.conf.json` → `updater.pubkey`
- **PRIVATE_KEY**: Store in GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`
- **PASSWORD**: Store in GitHub Secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

### 2. Update tauri.conf.json

Replace the placeholder with your actual public key:

```json
{
  "updater": {
    "pubkey": "YOUR_PUBLIC_KEY_HERE",
    "endpoints": [
      "https://github.com/alyn3d/yaaiorch/releases/latest/download/latest.json"
    ]
  }
}
```

### 3. Configure GitHub Secrets

In your GitHub repository settings, add these secrets:

| Secret Name | Value |
|------------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | The full private key content from `tauri.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password used during key generation |

The installers themselves are not code-signed (no Windows certificate, no Apple Developer account). That is separate
from the updater signature: the app checks the updater signature before installing any update.

### 4. Test Locally (Optional)

Before releasing, verify the updater plugin is installed:

```bash
cd orch-ui
npm run tauri dev
```

The app should start without errors. **About YAAIORCH** shows the version and a **Check for updates** button.

## Publishing a Release

### Version Tagging Convention

YAAIORCH uses semantic versioning with a `v` prefix:

```
v<MAJOR>.<MINOR>.<PATCH>
```

Examples: `v0.6.1`, `v1.0.0`

**Update the version in two places before tagging:**

1. **`orch-ui/package.json`**: `"version": "0.6.7"`
2. **`orch-ui/src-tauri/Cargo.toml`**: `version = "0.6.7"`
3. **`orch-ui/src-tauri/tauri.conf.json`**: `"version": "0.6.7"`

### Publishing Steps

1. **Update version in source files** (see above)

2. **Commit and tag:**
   ```bash
   git add orch-ui/package.json orch-ui/src-tauri/Cargo.toml orch-ui/src-tauri/tauri.conf.json
   git commit -m "chore: bump version to v0.6.7"
   git tag v0.6.7
   git push origin main v0.6.7
   ```

3. **Monitor the GitHub Actions workflow** (`.github/workflows/release.yml`):
   - Build jobs create platform-specific installers
   - Artifacts are signed with the private key
   - `latest.json` manifest is generated and uploaded
   - Release is published as a draft

4. **Review the draft release** on GitHub:
   - Verify all platform artifacts are present
   - Check the generated `latest.json` file
   - Review the release notes

5. **Publish the release:**
   ```bash
   gh release edit v0.6.7 --draft=false
   ```

   Or use the web interface: GitHub Releases → Edit Draft → "Publish release"

   Installed apps see the update only from this point: `releases/latest` skips drafts and pre-releases.

## Update Distribution

### How Updates Are Discovered

When a user clicks **Check for updates** in **About YAAIORCH**:

1. The app fetches `latest.json` from GitHub Releases
2. If it lists a newer version, the **Update available** state is shown
3. The user clicks **Update to v0.6.7** to download it
4. The app checks the download against its signature in `latest.json` (public key embedded in the app) and installs only if it matches

### Update Channels

The updater currently supports only the **stable** channel. Prereleases are not distributed to stable installations.

To exclude a release from the updater:
- Do **not** publish it to the main release feed
- Mark it as a "Pre-release" on GitHub (this is separate from publishing)

### Platform Support

| Platform | Distribution | Mechanism |
|----------|-------------|-----------|
| Windows x64 | NSIS `.exe` installer | Tauri updater |
| macOS (universal: Intel and Apple Silicon) | `.dmg` application bundle | Tauri updater |
| Linux x64 | `.AppImage` | Tauri updater |
| CLI | `yaaiorch-cli-*.mjs` | Manual download (Node.js) |

**Note:** The CLI bundle does not use the auto-updater. Users download it manually from the Releases page.

## Troubleshooting

### "No update available" but a newer version exists

- **Cause:** The public key in `tauri.conf.json` does not match the key used to sign
- **Fix:** Ensure the public key is correctly copied from `tauri.key.pub` and the GitHub Secret is set correctly

### Update download hangs or fails

- **Cause:** Network issue, GitHub rate-limiting, or corrupted download
- **Fix:**
  - Try again later
  - Check your internet connection
  - Look for error messages in the app logs

### "Signature verification failed"

- **Cause:** The release was not properly signed, or the public key changed
- **Fix:**
  - Verify the GitHub Secrets are set correctly
  - Re-run the release workflow
  - Check that all platform builds completed successfully

### macOS: "Cannot verify developer" on first run

- **Cause:** The app is not code-signed or notarized by Apple
- **Fix:**
  - Right-click the app → Open
  - Or: `xattr -d com.apple.quarantine /Applications/YAAIORCH.app`

### Windows: SmartScreen warning

- **Cause:** The installer is not code-signed
- **Fix:** Choose **More info** → **Run anyway**

## Supported Platforms and Build Artifacts

### Desktop Application

Updater-signed (not code-signed), updated through **About YAAIORCH**:

- **Windows x64**: NSIS `.exe` or `.msi` installer (updates use the NSIS installer)
- **macOS (universal)**: `.dmg` disk image with `.app` bundle, for Intel and Apple Silicon
- **Linux x64**: `.AppImage` (AppImage format; run with `chmod +x` and double-click)

### CLI Bundle

Unsigned, requires manual download:

- **All platforms**: `yaaiorch-cli-v0.6.7.mjs` (Node.js 20+ required)
- Includes `SHA256SUMS.txt` for integrity verification

## Local Testing

### Test Update Check (without network)

```bash
cd orch-ui
npm run tauri dev
```

Click **About YAAIORCH** → **Check for updates**. This will attempt to fetch from GitHub. If no network is available, an error is shown.

### Test Building Signed Artifacts

Build for your current platform:

```bash
cd orch-ui
npm run build:app
npm run tauri build -- --sign
```

The signed artifacts appear in `src-tauri/target/release/bundle/`.

## Limitations and Future Improvements

### Current Limitations

1. **No delta updates**: Full application is downloaded each time (suitable for small app)
2. **No staged rollout**: All users receive updates at once
3. **No automatic update installation**: User must click "Install" (prevents disruption)
4. **Linux AppImage limitations**: AppImage has no built-in signing; consider documenting manual updates or exploring alternative Linux distribution methods
5. **Offline updates**: Not supported; internet required

### Possible Future Improvements

- Delta/binary updates to reduce download size
- Automatic install with configurable timing (e.g., on shutdown)
- Staged rollout with kill switch
- Multiple update channels (stable, beta, nightly)
- In-app changelog with links to detailed release notes
- DEB/RPM packages for Linux with native package manager integration

## Maintenance

### Key Rotation

If the private signing key is compromised:

1. **Stop the release workflow**
2. **Generate new keys:**
   ```bash
   node scripts/generate-keys.mjs --password "new-password"
   ```
3. **Update GitHub Secrets** with the new private key and password
4. **Update `tauri.conf.json`** with the new public key
5. **Commit and push** to main branch (not through release workflow)
6. **Tag and release** the next version

Existing installations will refuse to update until they receive a version signed with the new key.

### Monitoring

Monitor for failed update checks:

- Check the Release page for missing artifacts
- Monitor GitHub Actions workflows for failures
- Watch for user reports of update failures

## See Also

- [Tauri Updater Documentation](https://v2.tauri.app/features/updater/)
- [GitHub Releases API](https://docs.github.com/en/rest/releases)
- [Semantic Versioning](https://semver.org/)
