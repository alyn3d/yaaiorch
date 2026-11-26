#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

//! Tauri shell for YAAIORCH. The backend is `server.mjs` (bundled from ../server.ts, the same server browser mode
//! uses): the app starts it with the bundled Node.js on a free local port and hands its address and session token to
//! the webview, which talks to it over HTTP and SSE like the browser UI does. What stays here is only what needs the
//! desktop: the window, the native plugins (folder picker, opener, notifications, updater) and the server's lifetime.
//! The server stops its runs and exits when the app is gone (`YAAIORCH_PARENT_PID`); a server that dies is restarted.

use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Condvar, Mutex},
    time::Duration,
};
use tauri::{path::BaseDirectory, AppHandle, Manager, RunEvent, Runtime, State};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// What the server prints once it listens: `@@READY@@ {"port":N,"token":"..."}`.
const READY: &str = "@@READY@@ ";
/// The webview's origins (macOS and Linux, Windows), which the server allows cross-origin; in a dev build also Vite's.
const APP_ORIGINS: &str = "tauri://localhost,http://tauri.localhost,https://tauri.localhost";
const DEV_ORIGIN: &str = "http://localhost:5173";
/// Restarts of a server that keeps dying, before the app gives up and shows the error.
const MAX_RESTARTS: u32 = 5;

/// The running server: where it listens and its token once ready, or why it is not running.
#[derive(Default)]
struct Server {
    pid: Option<u32>,
    port: Option<u16>,
    token: String,
    error: Option<String>,
    /// The server's last output lines, for the error shown when it does not start.
    tail: VecDeque<String>,
    /// Set on exit: the supervisor stops restarting.
    quitting: bool,
}

struct ServerState(Mutex<Server>, Condvar);

fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

/// A bundled resource (`orch.mjs`, `server.mjs`): `env` if set, the build output in a dev build, else the installed one.
fn resource<R: Runtime>(app: &AppHandle<R>, env: &str, name: &str) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var(env) {
        return Ok(PathBuf::from(p));
    }
    let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/resources")).join(name);
    if cfg!(debug_assertions) && dev.exists() {
        return Ok(dev);
    }
    if let Ok(p) = app.path().resolve(format!("resources/{name}"), BaseDirectory::Resource) {
        if p.exists() {
            return Ok(strip_verbatim(p));
        }
    }
    if dev.exists() {
        return Ok(dev);
    }
    Err(format!("{name} not found (run `npm run build:app`)"))
}

const NODE_HINT: &str = "failed to start node (the one bundled with the app, or Node.js 20+ on PATH)";

/// The Node.js that runs the server and orch: YAAIORCH_NODE if set, else the one installed next to the app (Tauri
/// externalBin, see scripts/fetch-node.mjs), else `node` on PATH (a build without it, or a source checkout).
fn node_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("YAAIORCH_NODE").filter(|p| !p.is_empty()) {
        return PathBuf::from(p);
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join(name)))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("node"))
}

fn home_dir() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// The server's command: node, server.mjs, and where it finds orch and keeps its settings (`repos.json` in the app's
/// config dir, the file this app has always used). Port 0: the system picks a free one, which the server prints.
fn server_cmd(node: PathBuf, server: PathBuf, orch: PathBuf, settings: PathBuf, dist: Option<PathBuf>) -> Command {
    let mut origins = APP_ORIGINS.to_string();
    if cfg!(debug_assertions) {
        origins = format!("{origins},{DEV_ORIGIN}");
    }
    let mut cmd = Command::new(node);
    if let Some(d) = dist {
        cmd.env("YAAIORCH_DIST", d);
    }
    cmd.arg(server)
        .current_dir(home_dir())
        .env("PORT", "0")
        .env("YAAIORCH_APP", "1")
        .env("YAAIORCH_APP_ORIGINS", origins)
        .env("YAAIORCH_UI_SETTINGS", settings)
        .env("YAAIORCH_PARENT_PID", std::process::id().to_string())
        .env("ORCH_PATH", orch)
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // kill_tree signals the whole group: the server and every run it started
    }
    cmd
}

/// `{port, token}` from the server's ready line.
fn parse_ready(line: &str) -> Option<(u16, String)> {
    let v: Value = serde_json::from_str(line.strip_prefix(READY)?).ok()?;
    let port = u16::try_from(v["port"].as_u64()?).ok()?;
    let token = v["token"].as_str().filter(|t| t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit()))?;
    Some((port, token.to_string()))
}

fn keep_tail(st: &ServerState, line: String) {
    let mut s = st.0.lock().unwrap();
    s.tail.push_back(line);
    if s.tail.len() > 20 {
        s.tail.pop_front();
    }
}

/// Start the server and keep it running: read its ready line, keep its output (drained, so it never blocks on a full
/// pipe), and when it exits, restart it (up to MAX_RESTARTS times in a row), unless the app is quitting.
fn supervise<R: Runtime>(app: AppHandle<R>) {
    let mut restarts = 0;
    loop {
        let st = app.state::<ServerState>();
        let started = (|| {
            let server = resource(&app, "SERVER_PATH", "server.mjs")?;
            let orch = resource(&app, "ORCH_PATH", "orch.mjs")?;
            let settings = app.path().app_config_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&settings).map_err(|e| e.to_string())?;
            // The built UI, which the server serves to a paired phone (the window itself loads the copy inside the app).
            let dist = resource(&app, "YAAIORCH_DIST", "dist").ok();
            server_cmd(node_bin(), server, orch, settings.join("repos.json"), dist)
                .spawn()
                .map_err(|e| format!("{NODE_HINT}: {e}"))
        })();
        let mut child = match started {
            Ok(c) => c,
            Err(e) => {
                st.0.lock().unwrap().error = Some(e);
                st.1.notify_all();
                return;
            }
        };
        {
            let mut s = st.0.lock().unwrap();
            if s.quitting {
                drop(s);
                kill_tree(child.id());
                return;
            }
            s.pid = Some(child.id());
            s.error = None;
        }
        if let Some(err) = child.stderr.take() {
            let h = app.clone();
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    eprintln!("[server] {line}");
                    keep_tail(&h.state::<ServerState>(), line);
                }
            });
        }
        if let Some(out) = child.stdout.take() {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Some((port, token)) = parse_ready(&line) {
                    let mut s = st.0.lock().unwrap();
                    s.port = Some(port);
                    s.token = token;
                    drop(s);
                    st.1.notify_all();
                    restarts = 0;
                } else {
                    println!("[server] {line}");
                    keep_tail(&st, line);
                }
            }
        }
        let status = child.wait().map(|s| s.to_string()).unwrap_or_else(|e| e.to_string());
        let mut s = st.0.lock().unwrap();
        s.pid = None;
        s.port = None;
        if s.quitting {
            return;
        }
        restarts += 1;
        let tail = s.tail.iter().cloned().collect::<Vec<_>>().join("\n");
        s.error = Some(format!(
            "the YAAIORCH server stopped ({status}){}",
            if tail.is_empty() { String::new() } else { format!(":\n{tail}") }
        ));
        drop(s);
        st.1.notify_all();
        if restarts > MAX_RESTARTS {
            return;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Where the webview finds the server: `{url, token}`, waiting up to 30 s for it to start. The UI calls it again
/// after losing the connection, since a restarted server has a new port and token.
#[tauri::command(async)]
fn server_info(state: State<ServerState>) -> Result<Value, String> {
    let (lock, ready) = (&state.0, &state.1);
    let (s, _) = ready
        .wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(30), |s| s.port.is_none() && s.error.is_none())
        .unwrap();
    match (s.port, &s.error) {
        (Some(port), _) => Ok(json!({ "url": format!("http://127.0.0.1:{port}"), "token": s.token })),
        (None, Some(e)) => Err(e.clone()),
        (None, None) => Err("the YAAIORCH server did not start within 30 seconds".into()),
    }
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", "--", &format!("-{pid}")]).status();
    }
}

/// macOS/Linux: an app started from Finder, the Dock or a desktop launcher gets a minimal PATH
/// (/usr/bin:/bin:/usr/sbin:/sbin), not the one the user's shell sets up, so `claude`, `gh`, `git` from
/// Homebrew or `node` would not be found. Take PATH from the login shell (bounded by a timeout, its output
/// fenced by markers so rc-file chatter is ignored), then add the usual install dirs that exist.
#[cfg(not(windows))]
fn fix_path() {
    use std::time::{Duration, Instant};
    const MARK: &str = "__YAAIORCH_PATH__";
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let from_shell = (|| {
        let mut child = Command::new(&shell)
            .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if start.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(25)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
            }
        }
        let mut out = String::new();
        std::io::Read::read_to_string(&mut child.stdout.take()?, &mut out).ok()?;
        out.split(MARK).nth(1).map(str::to_string)
    })()
    .unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = [
        format!("{home}/.local/bin"),
        format!("{home}/.claude/local"),
        format!("{home}/.npm-global/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.volta/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
    ];
    let current = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<String> = Vec::new();
    for d in from_shell.split(':').chain(current.split(':')).map(str::to_string).chain(extra) {
        if !d.is_empty()
            && !dirs.contains(&d)
            && (from_shell.split(':').any(|s| s == d) || current.split(':').any(|c| c == d) || std::path::Path::new(&d).is_dir())
        {
            dirs.push(d);
        }
    }
    std::env::set_var("PATH", dirs.join(":"));
}

fn main() {
    #[cfg(not(windows))]
    fix_path();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(ServerState(Mutex::new(Server::default()), Condvar::new()))
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || supervise(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![server_info])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let st = handle.state::<ServerState>();
            let pid = {
                let mut s = st.0.lock().unwrap();
                s.quitting = true;
                s.pid
            };
            // The server and every run it started (taskkill /T, or the process group).
            if let Some(pid) = pid {
                kill_tree(pid);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn ready_line() {
        let t = "ab".repeat(32);
        assert_eq!(parse_ready(&format!("@@READY@@ {{\"port\":4317,\"token\":\"{t}\"}}")), Some((4317, t.clone())));
        assert_eq!(parse_ready(&format!("@@READY@@ {{\"port\":70000,\"token\":\"{t}\"}}")), None, "not a port");
        assert_eq!(parse_ready("@@READY@@ {\"port\":4317,\"token\":\"short\"}"), None, "not a token");
        assert_eq!(parse_ready("YAAIORCH ui  0 repo(s)"), None);
    }

    /// One HTTP/1.0 request (so the answer is not chunked) to the server, as the webview makes it (its origin and the token): status and body.
    fn request(port: u16, token: &str, method: &str, path: &str, body: &str) -> (u16, String) {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
        write!(
            s,
            "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://tauri.localhost\r\nx-orch-token: {token}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        let status = out.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
        let body = out.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();
        (status, body)
    }

    /// End to end: the bundled server starts as the app starts it, prints its ready line, accepts the webview's origin
    /// and token, runs a goal in a repo with the fake claude, and stops when its parent is gone.
    /// Needs TEST_REPO (an empty dir), SERVER_PATH and ORCH_PATH (the built server.mjs and orch.mjs) and CLAUDE_BIN
    /// (test/fake-claude/claude[.cmd]). Run with `cargo test -- --ignored` (CI does).
    #[test]
    #[ignore]
    fn the_server_runs_a_goal_for_the_app() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set TEST_REPO, SERVER_PATH, ORCH_PATH and CLAUDE_BIN ({k} missing)"));
        let (repo, server, orch) = (
            PathBuf::from(var("TEST_REPO")),
            PathBuf::from(var("SERVER_PATH")),
            PathBuf::from(var("ORCH_PATH")),
        );
        var("CLAUDE_BIN");
        let settings = repo.join("settings.json");
        let mut child = server_cmd(node_bin(), server, orch, settings.clone(), None).spawn().expect(NODE_HINT);
        let out = BufReader::new(child.stdout.take().unwrap());
        let (port, token) = out.lines().map_while(Result::ok).find_map(|l| parse_ready(&l)).expect("a ready line");

        assert_eq!(request(port, "wrong", "GET", "/api/state", "").0, 403, "the token is required");
        assert_eq!(request(port, &token, "GET", "/api/token", "").0, 403, "the app's token is never handed out");
        let work = repo.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let path = serde_json::to_string(&work.to_string_lossy()).unwrap();
        let (code, body) = request(port, &token, "POST", "/api/add-repo", &format!("{{\"path\":{path}}}"));
        assert_eq!(code, 200, "{body}");
        let (code, body) = request(
            port,
            &token,
            "POST",
            "/api/run",
            &format!("{{\"repo\":{path},\"goal\":\"hello\",\"power\":\"heavy\",\"maxRounds\":5}}"),
        );
        assert_eq!(code, 200, "{body}");
        let mut last = Value::Null;
        let mut done = None;
        for _ in 0..240 {
            std::thread::sleep(Duration::from_millis(500));
            last = serde_json::from_str(&request(port, &token, "GET", "/api/state", "").1).unwrap();
            done = last["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| s["events"].as_array().is_some_and(|e| !e.is_empty()) && s["state"]["running"].is_null())
                .cloned();
            if done.is_some() {
                break;
            }
        }
        kill_tree(child.id());
        let _ = child.wait();
        let s = done.unwrap_or_else(|| panic!("the goal did not finish: {last}"));
        let end = s["events"].as_array().unwrap().last().unwrap();
        assert_eq!(end["type"], "goal_end", "{s}");
        assert_eq!(end["passed"], true, "{s}");
        assert!(std::fs::read_to_string(&settings).unwrap().contains("work"), "the repo is remembered");
    }
}
