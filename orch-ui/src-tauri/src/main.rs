#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri shell for the orchestrator. Spawns the bundled `orch.mjs` (built from ../orch.ts)
//! with `node` inside the chosen repo, forwards its output + structured events to the UI.

use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Command, Stdio},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, RunEvent, Runtime, State};

const MARK: &str = "@@ORCH@@ ";
const MAX_LOG: usize = 5000;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Running {
    pid: u32,
    label: String,
    started_at: u64,
}

#[derive(Default)]
struct Inner {
    repo: Option<PathBuf>,
    running: Option<Running>,
    log: Vec<String>,
    events: Vec<Value>, // structured events since the last goal_start
}

struct AppState(Mutex<Inner>);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn read_json(path: PathBuf, fallback: Value) -> Value {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(fallback)
}

fn state_value(g: &Inner) -> Value {
    let (queue, last_run) = match &g.repo {
        Some(r) => (
            read_json(r.join(".orchestrator").join("queue.json"), json!([])),
            read_json(r.join(".orchestrator").join("last-run.json"), Value::Null),
        ),
        None => (json!([]), Value::Null),
    };
    json!({
        "repo": g.repo.as_ref().map(|r| r.to_string_lossy().to_string()),
        "running": g.running.as_ref().map(|r| json!({ "pid": r.pid, "label": r.label, "startedAt": r.started_at })),
        "queue": queue,
        "lastRun": last_run,
    })
}

fn init_value(g: &Inner) -> Value {
    json!({ "state": state_value(g), "log": g.log, "events": g.events })
}

fn emit_state<R: Runtime>(app: &AppHandle<R>) {
    let v = state_value(&app.state::<AppState>().0.lock().unwrap());
    let _ = app.emit("orch-state", v);
}

fn push_line<R: Runtime>(app: &AppHandle<R>, line: String) {
    if let Some(rest) = line.strip_prefix(MARK) {
        if let Ok(ev) = serde_json::from_str::<Value>(rest) {
            {
                let st = app.state::<AppState>();
                let mut g = st.0.lock().unwrap();
                if ev["type"] == "goal_start" {
                    g.events.clear();
                }
                g.events.push(ev.clone());
            }
            let _ = app.emit("orch-ev", ev);
            return;
        }
    }
    {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        g.log.push(line.clone());
        let len = g.log.len();
        if len > MAX_LOG {
            g.log.drain(0..len - MAX_LOG);
        }
    }
    let _ = app.emit("orch-log", line);
}

fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

fn orch_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("ORCH_PATH") {
        return Ok(PathBuf::from(p));
    }
    if let Ok(p) = app.path().resolve("resources/orch.mjs", BaseDirectory::Resource) {
        if p.exists() {
            return Ok(strip_verbatim(p));
        }
    }
    let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/orch.mjs"));
    if dev.exists() {
        return Ok(dev);
    }
    Err("orch.mjs not found (run `npm run build:orch`)".into())
}

fn node_cmd<R: Runtime>(app: &AppHandle<R>, args: &[String]) -> Result<Command, String> {
    let repo = app
        .state::<AppState>()
        .0
        .lock()
        .unwrap()
        .repo
        .clone()
        .ok_or("choose a repo first")?;
    let mut cmd = Command::new("node");
    cmd.arg(orch_path(app)?)
        .args(args)
        .current_dir(repo)
        .env("ORCH_EVENTS", "1")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    Ok(cmd)
}

const NODE_HINT: &str = "failed to start node (is Node.js installed and on PATH?)";

fn spawn_orch<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, label: String) -> Result<(), String> {
    if app.state::<AppState>().0.lock().unwrap().running.is_some() {
        return Err("something is already running".into());
    }
    let mut cmd = node_cmd(app, &args)?;
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        g.running = Some(Running { pid: child.id(), label, started_at: now_ms() });
    }
    push_line(app, format!("$ orch {}", args.join(" ")));
    emit_state(app);

    let readers: Vec<_> = [Box::new(out) as Box<dyn std::io::Read + Send>, Box::new(err)]
        .into_iter()
        .map(|r| {
            let app = app.clone();
            std::thread::spawn(move || {
                // Read raw bytes per line: `lines()` stops at the first invalid UTF-8 line,
                // which would close the pipe and lose the rest of the output.
                let mut reader = BufReader::new(r);
                let mut buf = Vec::new();
                loop {
                    buf.clear();
                    match reader.read_until(b'\n', &mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            let text = String::from_utf8_lossy(&buf);
                            let line = text.trim_end_matches(['\r', '\n']);
                            if !line.is_empty() {
                                push_line(&app, line.to_string());
                            }
                        }
                    }
                }
            })
        })
        .collect();

    let app = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        for r in readers {
            let _ = r.join();
        }
        push_line(&app, format!("-- exited ({}) --", code.map(|c| c.to_string()).unwrap_or("killed".into())));
        app.state::<AppState>().0.lock().unwrap().running = None;
        emit_state(&app);
    });
    Ok(())
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

fn flags(power: &str, max_rounds: u32, dry_run: bool, max_cost: Option<f64>) -> Vec<String> {
    let mut v = vec!["--power".into(), power.into(), "--max-rounds".into(), max_rounds.to_string()];
    if dry_run {
        v.push("--dry-run".into());
    }
    if let Some(c) = max_cost.filter(|c| *c > 0.0) {
        v.push("--max-cost".into());
        v.push(c.to_string());
    }
    v
}

#[tauri::command]
fn snapshot(state: State<AppState>) -> Value {
    init_value(&state.0.lock().unwrap())
}

#[tauri::command]
fn set_repo(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err(format!("not a folder: {path}"));
    }
    if state.0.lock().unwrap().running.is_some() {
        return Err("stop the current run before switching repo".into());
    }
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("repo.txt"), &path);
    }
    state.0.lock().unwrap().repo = Some(p);
    let v = init_value(&state.0.lock().unwrap());
    let _ = app.emit("orch-init", v);
    Ok(())
}

#[tauri::command]
fn run_goal(
    app: AppHandle,
    goal: String,
    power: String,
    max_rounds: u32,
    dry_run: Option<bool>,
    max_cost: Option<f64>,
) -> Result<(), String> {
    if goal.trim().is_empty() {
        return Err("goal required".into());
    }
    let mut args = vec!["run".to_string()];
    args.extend(flags(&power, max_rounds, dry_run.unwrap_or(false), max_cost));
    let label = format!("run: {}", goal.chars().take(60).collect::<String>());
    args.push(goal);
    spawn_orch(&app, args, label)
}

#[tauri::command]
fn run_loop(
    app: AppHandle,
    power: String,
    max_rounds: u32,
    dry_run: Option<bool>,
    until_empty: Option<bool>,
    max_cost: Option<f64>,
) -> Result<(), String> {
    let mut args = vec!["loop".to_string()];
    args.extend(flags(&power, max_rounds, dry_run.unwrap_or(false), max_cost));
    if until_empty.unwrap_or(false) {
        args.push("--until-empty".into());
    }
    spawn_orch(&app, args, "queue loop".into())
}

#[tauri::command]
fn add_goal(app: AppHandle, goal: String) -> Result<(), String> {
    if goal.trim().is_empty() {
        return Err("goal required".into());
    }
    let out = node_cmd(&app, &["add".into(), goal])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    emit_state(&app);
    Ok(())
}

#[tauri::command]
fn agents(app: AppHandle) -> Result<String, String> {
    let out = node_cmd(&app, &["agents".into()])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Runs as a normal orch process: refused while a goal runs, output streams to the log.
#[tauri::command]
fn rollback(app: AppHandle) -> Result<(), String> {
    spawn_orch(&app, vec!["rollback".into()], "rollback".into())
}

/// `orch doctor --json`. Async so starting node does not freeze the window.
#[tauri::command(async)]
fn doctor(app: AppHandle) -> Value {
    let fail = |detail: String| json!([{ "name": "orchestrator", "level": "fail", "detail": detail }]);
    let out = match node_cmd(&app, &["doctor".into(), "--json".into()]).and_then(|mut c| c.output().map_err(|e| format!("{NODE_HINT}: {e}"))) {
        Ok(o) => o,
        Err(e) => return fail(e),
    };
    // exit 1 just means a "fail" finding; the JSON is still on stdout
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| fail(String::from_utf8_lossy(&out.stderr).trim().to_string()))
}

#[tauri::command]
fn stop(state: State<AppState>) {
    if let Some(r) = &state.0.lock().unwrap().running {
        kill_tree(r.pid);
    }
}

#[tauri::command]
fn clear_log(app: AppHandle, state: State<AppState>) {
    state.0.lock().unwrap().log.clear();
    let v = init_value(&state.0.lock().unwrap());
    let _ = app.emit("orch-init", v);
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState(Mutex::new(Inner::default())))
        .setup(|app| {
            if let Ok(dir) = app.path().app_config_dir() {
                if let Ok(s) = fs::read_to_string(dir.join("repo.txt")) {
                    let p = PathBuf::from(s.trim());
                    if p.is_dir() {
                        app.state::<AppState>().0.lock().unwrap().repo = Some(p);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot, set_repo, run_goal, run_loop, add_goal, agents, stop, clear_log, rollback, doctor
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(r) = &handle.state::<AppState>().0.lock().unwrap().running {
                kill_tree(r.pid);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs TEST_REPO (empty dir), ORCH_PATH (built orch.mjs) and CLAUDE_BIN (fake claude); skipped otherwise.
    #[test]
    fn spawns_orch_and_captures_events() {
        let Ok(repo) = std::env::var("TEST_REPO") else { return };
        let app = tauri::test::mock_builder()
            .manage(AppState(Mutex::new(Inner::default())))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let h = app.handle().clone();
        h.state::<AppState>().0.lock().unwrap().repo = Some(PathBuf::from(repo));

        let mut args = vec!["run".to_string()];
        args.extend(flags("heavy", 5, false, None));
        args.push("hello".into());
        spawn_orch(&h, args, "test".into()).unwrap();
        assert!(spawn_orch(&h, vec!["agents".into()], "x".into()).is_err(), "second run must be refused");

        for _ in 0..200 {
            if h.state::<AppState>().0.lock().unwrap().running.is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let st = h.state::<AppState>();
        let g = st.0.lock().unwrap();
        assert!(g.running.is_none());
        let types: Vec<String> = g.events.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect();
        assert_eq!(types.first().map(String::as_str), Some("goal_start"));
        let end = g.events.last().unwrap();
        assert_eq!(end["type"], "goal_end");
        assert_eq!(end["passed"], true);
        assert!(g.log.iter().any(|l| l.starts_with("-- exited (0)")), "log: {:?}", g.log);
        assert!(state_value(&g)["queue"].is_array());
    }
}
