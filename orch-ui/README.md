# orch-ui

Web UI and Tauri desktop app for `../orch.ts`. Layout: `orch.ts` and `orch-ui/` side by side.

## Desktop app (Tauri v2)
Needs Node on PATH (runs the orchestrator), Rust (MSVC toolchain on Windows), and the `claude` CLI.

    npm install
    npm run tauri dev        # dev window (bundles ../orch.ts -> src-tauri/resources/orch.mjs)
    npm run tauri build      # installer in src-tauri/target/release/bundle

Pick the target repo in the app ("Choose repo…"); it is remembered between launches.

## Browser only (no Rust)
    npm run build
    set ORCH_REPO=C:\path\to\repo && npm start     # http://localhost:4317
