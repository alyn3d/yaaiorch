#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri shell for YAAIORCH, for several repos at once (one session per repo). Spawns the bundled
//! `orch.mjs` (built from ../orch.ts) with `node` inside each repo and forwards its output and
//! structured events to the UI, tagged with the repo. At most `max_parallel` sessions run at once;
//! further starts wait for a free slot. One run per repo at a time.

use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
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

struct Session {
    repo: PathBuf,
    running: Option<Running>,
    /// A start waiting for a free slot: (args, label).
    pending: Option<(Vec<String>, String)>,
    log: Vec<String>,
    /// Structured events since the last goal_start.
    events: Vec<Value>,
}

struct Inner {
    sessions: Vec<Session>,
    /// Keys of sessions waiting for a slot, oldest first.
    start_queue: VecDeque<String>,
    max_parallel: usize,
    /// Set when any repo hits the Claude usage limit: (repo, until ms). New starts everywhere wait.
    usage_limit: Option<(String, u64)>,
    /// Daily budget in USD across all repos (None: no budget).
    daily_budget: Option<f64>,
    /// Local date (YYYY-MM-DD) and what agent calls cost on it.
    spent_day: String,
    spent_usd: f64,
    /// Latest subscription usage reading per window (see WINDOWS): (percent used, resets at ms).
    usage: [Option<(f64, u64)>; 2],
    /// Percent caps per window (None: no cap); passed to runs as --usage-cap and holding new starts.
    usage_cap: [Option<f64>; 2],
}

/// The subscription's usage windows: (key in events and the UI, label, --usage-cap key).
const WINDOWS: [(&str, &str, &str); 2] = [("fiveHour", "5-hour", "5h"), ("week", "weekly", "week")];

impl Default for Inner {
    fn default() -> Self {
        Inner {
            sessions: Vec::new(),
            start_queue: VecDeque::new(),
            max_parallel: 2,
            usage_limit: None,
            daily_budget: None,
            spent_day: today(),
            spent_usd: 0.0,
            usage: [None; 2],
            usage_cap: [None; 2],
        }
    }
}

impl Inner {
    fn find(&self, key: &str) -> Option<usize> {
        self.sessions.iter().position(|s| key_of(&s.repo) == key)
    }
    fn running_count(&self) -> usize {
        self.sessions.iter().filter(|s| s.running.is_some()).count()
    }
    /// Why new runs may not start right now, or None.
    fn gate(&self) -> Option<String> {
        if let Some((_, until)) = self.usage_limit.as_ref().filter(|(_, u)| *u > now_ms()) {
            let t = chrono::DateTime::from_timestamp_millis(*until as i64).map(|d| d.with_timezone(&chrono::Local).format("%H:%M").to_string());
            return Some(format!("usage limit (resets {})", t.unwrap_or_default()));
        }
        if let Some(b) = self.daily_budget.filter(|b| self.spent_usd >= *b) {
            return Some(format!("daily budget of ${b} used up"));
        }
        for (i, (_, label, _)) in WINDOWS.iter().enumerate() {
            if let (Some((pct, resets)), Some(cap)) = (self.usage[i], self.usage_cap[i]) {
                if pct >= cap && resets > now_ms() {
                    let t = chrono::DateTime::from_timestamp_millis(resets as i64).map(|d| d.with_timezone(&chrono::Local).format("%a %H:%M").to_string());
                    return Some(format!("{label} usage at {pct}% (cap {cap}%, resets {})", t.unwrap_or_default()));
                }
            }
        }
        None
    }
    /// "5h=80,week=90" for --usage-cap, or "" without caps.
    fn cap_spec(&self) -> String {
        WINDOWS
            .iter()
            .zip(self.usage_cap)
            .filter_map(|((_, _, cli), c)| c.map(|c| format!("{cli}={c}")))
            .collect::<Vec<_>>()
            .join(",")
    }
    fn global_value(&self) -> Value {
        json!({
            "usageLimit": self.usage_limit.as_ref().map(|(repo, until)| json!({ "repo": repo, "until": until })),
            "budget": { "limit": self.daily_budget, "spent": (self.spent_usd * 10_000.0).round() / 10_000.0, "day": self.spent_day },
            "usage": WINDOWS.iter().zip(self.usage).filter_map(|((k, _, _), u)| u.map(|(pct, resets)| (k.to_string(), json!({ "pct": pct, "resetsAt": resets })))).collect::<serde_json::Map<_, _>>(),
            "usageCap": { "fiveHour": self.usage_cap[0], "week": self.usage_cap[1] },
        })
    }
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

struct AppState(Mutex<Inner>);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// One session per folder; Windows paths are case-insensitive.
fn key_of(p: &Path) -> String {
    let s = p.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

fn read_json(path: PathBuf, fallback: Value) -> Value {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(fallback)
}

fn session_value(s: &Session, gate: Option<&str>) -> Value {
    let dir = s.repo.join(".orchestrator");
    json!({
        "repo": s.repo.to_string_lossy(),
        "running": s.running.as_ref().map(|r| json!({ "pid": r.pid, "label": r.label, "startedAt": r.started_at })),
        "queued": s.pending.is_some(),
        "waitReason": s.pending.as_ref().map(|_| gate.unwrap_or("free slot")),
        "queue": read_json(dir.join("queue.json"), json!([])),
        "lastRun": read_json(dir.join("last-run.json"), Value::Null),
    })
}

fn init_value(g: &Inner) -> Value {
    let gate = g.gate();
    json!({
        "sessions": g.sessions.iter().map(|s| json!({ "state": session_value(s, gate.as_deref()), "log": s.log, "events": s.events })).collect::<Vec<_>>(),
        "maxParallel": g.max_parallel,
        "global": g.global_value(),
    })
}

/// The shared limit/budget state changed: tell the UI, and refresh waiting repos' reasons.
fn emit_global<R: Runtime>(app: &AppHandle<R>) {
    let (global, waiting) = {
        let st = app.state::<AppState>();
        let g = st.0.lock().unwrap();
        let gate = g.gate();
        let waiting: Vec<Value> = g
            .sessions
            .iter()
            .filter(|s| s.pending.is_some())
            .map(|s| session_value(s, gate.as_deref()))
            .collect();
        (g.global_value(), waiting)
    };
    let _ = app.emit("orch-global", global);
    for s in waiting {
        let _ = app.emit("orch-session", s);
    }
}

/// Count agent-call costs, hold new starts on a usage limit, stop a loop at its next goal when the
/// day's budget is used up.
fn on_event<R: Runtime>(app: &AppHandle<R>, key: &str, ev: &Value) {
    let kind = ev["type"].as_str().unwrap_or("");
    let cost = ev["cost"].as_f64().filter(|c| *c > 0.0);
    if let Some(cost) = cost.filter(|_| {
        matches!(
            kind,
            "plan" | "task_end" | "review" | "learn_end" | "notes_tidy" | "share_end" | "split_proposal" | "coverage"
        )
    }) {
        {
            let st = app.state::<AppState>();
            let mut g = st.0.lock().unwrap();
            if g.spent_day != today() {
                g.spent_day = today();
                g.spent_usd = 0.0;
            }
            g.spent_usd += cost;
        }
        persist(app);
        emit_global(app);
    }
    // The loop changed queue.json: send the queue again, so statuses and the brief's progress stay current.
    if matches!(kind, "queue_item" | "queue_changed" | "blocked" | "coverage") {
        emit_session(app, key);
    }
    if kind == "queue_item" {
        let pid = {
            let st = app.state::<AppState>();
            let g = st.0.lock().unwrap();
            let over = matches!(g.daily_budget, Some(b) if g.spent_usd >= b);
            g.find(key).and_then(|i| g.sessions[i].running.as_ref().map(|r| r.pid)).filter(|_| over)
        };
        if let Some(pid) = pid {
            push_line(app, key, "-- daily budget used up: stopping the queue before its next goal --".into());
            kill_tree(pid);
        }
    }
    if kind == "usage" {
        // The windows are per account, so the latest reading from any repo holds for all of them.
        {
            let st = app.state::<AppState>();
            let mut g = st.0.lock().unwrap();
            for (i, (k, _, _)) in WINDOWS.iter().enumerate() {
                if let (Some(pct), Some(resets)) = (ev[*k]["pct"].as_f64(), ev[*k]["resetsAt"].as_u64()) {
                    g.usage[i] = Some((pct, resets));
                }
            }
        }
        emit_global(app);
    }
    // A run pausing at its own usage cap needs no extra hold: the reading over the cap already holds new starts.
    let waiting_until = if kind == "waiting" && ev["reason"] != "usage_cap" {
        ev["until"].as_u64()
    } else {
        None
    };
    if kind == "usage_limit" || waiting_until.is_some() {
        let until = waiting_until.or_else(|| ev["resetAt"].as_u64()).unwrap_or(now_ms() + 30 * 60_000);
        let shown = {
            let st = app.state::<AppState>();
            let mut g = st.0.lock().unwrap();
            let repo = g.find(key).map(|i| g.sessions[i].repo.to_string_lossy().to_string()).unwrap_or_default();
            if g.usage_limit.as_ref().is_none_or(|(_, u)| until > *u) {
                g.usage_limit = Some((repo, until));
            }
            g.usage_limit.as_ref().map(|(_, u)| *u).unwrap_or(until)
        };
        let t = chrono::DateTime::from_timestamp_millis(shown as i64).map(|d| d.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string());
        push_line(
            app,
            key,
            format!("-- usage limit: new runs in all repos wait until {} --", t.unwrap_or_default()),
        );
        emit_global(app);
    }
}

fn emit_init<R: Runtime>(app: &AppHandle<R>) {
    let v = init_value(&app.state::<AppState>().0.lock().unwrap());
    let _ = app.emit("orch-init", v);
}

fn emit_session<R: Runtime>(app: &AppHandle<R>, key: &str) {
    let v = {
        let st = app.state::<AppState>();
        let g = st.0.lock().unwrap();
        let gate = g.gate();
        g.find(key).map(|i| session_value(&g.sessions[i], gate.as_deref()))
    };
    if let Some(v) = v {
        let _ = app.emit("orch-session", v);
    }
}

fn push_line<R: Runtime>(app: &AppHandle<R>, key: &str, line: String) {
    let repo = {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        let Some(i) = g.find(key) else { return };
        let s = &mut g.sessions[i];
        if let Some(rest) = line.strip_prefix(MARK) {
            if let Ok(ev) = serde_json::from_str::<Value>(rest) {
                if ev["type"] == "goal_start" {
                    s.events.clear();
                }
                s.events.push(ev.clone());
                let repo = s.repo.to_string_lossy().to_string();
                drop(g);
                let _ = app.emit("orch-ev", json!({ "repo": repo, "ev": ev }));
                on_event(app, key, &ev);
                return;
            }
        }
        s.log.push(line.clone());
        let len = s.log.len();
        if len > MAX_LOG {
            s.log.drain(0..len - MAX_LOG);
        }
        s.repo.to_string_lossy().to_string()
    };
    let _ = app.emit("orch-log", json!({ "repo": repo, "line": line }));
}

/// Remember the open repos, the parallel limit, the daily budget and today's spending.
fn persist<R: Runtime>(app: &AppHandle<R>) {
    let v = {
        let st = app.state::<AppState>();
        let g = st.0.lock().unwrap();
        json!({
            "repos": g.sessions.iter().map(|s| s.repo.to_string_lossy()).collect::<Vec<_>>(),
            "maxParallel": g.max_parallel,
            "dailyBudget": g.daily_budget,
            "usageCap": { "fiveHour": g.usage_cap[0], "week": g.usage_cap[1] },
            "spent": { "day": g.spent_day, "usd": g.spent_usd },
        })
    };
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = fs::write(dir.join("repos.json"), v.to_string());
    }
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

fn repo_of<R: Runtime>(app: &AppHandle<R>, key: &str) -> Result<PathBuf, String> {
    let st = app.state::<AppState>();
    let g = st.0.lock().unwrap();
    g.find(key).map(|i| g.sessions[i].repo.clone()).ok_or_else(|| format!("unknown repo: {key}"))
}

fn node_cmd<R: Runtime>(app: &AppHandle<R>, repo: &Path, args: &[String]) -> Result<Command, String> {
    let mut cmd = Command::new(node_bin());
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

const NODE_HINT: &str = "failed to start node (the one bundled with the app, or Node.js 20+ on PATH)";

/// The Node.js that runs orch: YAAIORCH_NODE if set, else the one installed next to the app (Tauri externalBin,
/// see scripts/fetch-node.mjs), else `node` on PATH (a build without it, or a source checkout).
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

/// Start now if a slot is free, else queue the start. One run per repo.
fn request_start<R: Runtime>(app: &AppHandle<R>, repo: &str, args: Vec<String>, label: String) -> Result<(), String> {
    let key = key_of(Path::new(repo));
    let start_now = {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        let i = g.find(&key).ok_or_else(|| format!("unknown repo: {repo}"))?;
        if g.sessions[i].running.is_some() || g.sessions[i].pending.is_some() {
            return Err("this repo already has a run (or one waiting to start)".into());
        }
        let held = g.gate();
        if held.is_none() && g.running_count() < g.max_parallel {
            None
        } else {
            g.sessions[i].pending = Some((args.clone(), label.clone()));
            g.start_queue.push_back(key.clone());
            Some(held.unwrap_or_else(|| format!("free slot ({} repo(s) may run at once)", g.max_parallel)))
        }
    };
    match start_now {
        None => spawn_orch(app, &key, args, label),
        Some(reason) => {
            push_line(app, &key, format!("-- waiting: {reason} --"));
            emit_session(app, &key);
            Ok(())
        }
    }
}

/// Run and loop get the global limits: --usage-cap from the caps (`caps`, "" for none), and with a daily
/// budget a --max-cost of at most what is left today (their own --max-cost, if lower).
fn with_budget(mut args: Vec<String>, left: Option<f64>, caps: &str) -> Vec<String> {
    if !matches!(args.first().map(String::as_str), Some("run" | "loop" | "learn" | "share" | "split" | "new")) {
        return args;
    }
    if !caps.is_empty() && !args.iter().any(|a| a == "--usage-cap") {
        args.push("--usage-cap".into());
        args.push(caps.into());
    }
    let Some(left) = left else { return args };
    // A loop (or a new project that starts building) gets what is left today as its budget for all goals together,
    // so the goal it runs out in stays pending instead of failing; a single call or goal gets it as its own cap.
    let key = match args.first().map(String::as_str) {
        Some("loop") => "--max-cost-total",
        Some("new") if args.iter().any(|a| a == "--start") => "--max-cost-total",
        _ => "--max-cost",
    };
    let mut own = f64::INFINITY;
    let mut out = Vec::with_capacity(args.len() + 2);
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == key {
            own = it.next().and_then(|v| v.parse().ok()).unwrap_or(f64::INFINITY);
        } else {
            out.push(a);
        }
    }
    out.push(key.into());
    out.push(format!("{:.2}", own.min(left)));
    out
}

fn start_next<R: Runtime>(app: &AppHandle<R>) {
    loop {
        let next = {
            let st = app.state::<AppState>();
            let mut g = st.0.lock().unwrap();
            if g.running_count() >= g.max_parallel || g.gate().is_some() {
                return;
            }
            let Some(key) = g.start_queue.pop_front() else { return };
            match g.find(&key) {
                Some(i) => g.sessions[i].pending.take().map(|(args, label)| (key, args, label)),
                None => None,
            }
        };
        if let Some((key, args, label)) = next {
            if let Err(e) = spawn_orch(app, &key, args, label) {
                push_line(app, &key, format!("-- could not start: {e} --"));
                emit_session(app, &key);
            }
        }
    }
}

fn spawn_orch<R: Runtime>(app: &AppHandle<R>, key: &str, args: Vec<String>, label: String) -> Result<(), String> {
    let repo = repo_of(app, key)?;
    let (left, caps) = {
        let st = app.state::<AppState>();
        let g = st.0.lock().unwrap();
        (g.daily_budget.map(|b| (b - g.spent_usd).max(0.01)), g.cap_spec())
    };
    let args = with_budget(args, left, &caps);
    let mut cmd = node_cmd(app, &repo, &args)?;
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
        if let Some(i) = g.find(key) {
            g.sessions[i].running = Some(Running {
                pid: child.id(),
                label,
                started_at: now_ms(),
            });
        }
    }
    push_line(app, key, format!("$ orch {}", args.join(" ")));
    emit_session(app, key);

    let readers: Vec<_> = [Box::new(out) as Box<dyn std::io::Read + Send>, Box::new(err)]
        .into_iter()
        .map(|r| {
            let app = app.clone();
            let key = key.to_string();
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
                                push_line(&app, &key, line.to_string());
                            }
                        }
                    }
                }
            })
        })
        .collect();

    let app = app.clone();
    let key = key.to_string();
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        for r in readers {
            let _ = r.join();
        }
        push_line(&app, &key, format!("-- exited ({}) --", code.map(|c| c.to_string()).unwrap_or("killed".into())));
        {
            let st = app.state::<AppState>();
            let mut g = st.0.lock().unwrap();
            if let Some(i) = g.find(&key) {
                g.sessions[i].running = None;
            }
        }
        emit_session(&app, &key);
        start_next(&app);
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

/// Options beyond power and rounds (the UI sends them as camelCase command arguments).
#[derive(Default)]
struct Extra {
    max_cost: Option<f64>,
    /// A loop's budget for all its goals together (--max-cost-total).
    max_cost_total: Option<f64>,
    /// "architect=opus,be=sonnet"
    models: Option<String>,
    /// "wait" or "stop"
    on_limit: Option<String>,
    fast: Option<bool>,
    critic: Option<bool>,
    diff_critic: Option<bool>,
    review: Option<bool>,
    /// "security-reviewer,backend-reviewer": the user's agents instead of the built-in reviewer
    reviewers: Option<String>,
    branch: Option<bool>,
    pr: Option<bool>,
    approve_plan: Option<bool>,
    /// A GitHub label: loops pull new issues with it in (--intake github:LABEL).
    intake_label: Option<String>,
    plugins: Option<PluginOpts>,
}

/// A GitHub label name with safe characters only (orch checks it again).
fn valid_label(s: &str) -> bool {
    !s.is_empty() && s.len() <= 50 && s.chars().all(|c| c.is_ascii_alphanumeric() || " _.:/-".contains(c))
}

/// Agent names, comma-separated, with safe characters only (orch checks them against the agents it finds).
fn valid_reviewers(s: &str) -> bool {
    !s.is_empty()
        && s.split(',')
            .all(|a| a.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && a.chars().all(|c| c.is_ascii_alphanumeric() || "._:-".contains(c)))
}

/// Which of the user's Claude Code plugins and hooks the agents get (see `orch plugins`).
#[derive(serde::Deserialize, Default)]
struct PluginOpts {
    off: Option<bool>,
    disable: Option<Vec<String>>,
    hooks: Option<bool>,
}

/// A plugin id like `name@marketplace` with safe characters only (orch validates it again).
fn valid_plugin_id(s: &str) -> bool {
    let part = |p: &str| p.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && p.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    let mut it = s.splitn(2, '@');
    it.next().is_some_and(part) && it.next().is_none_or(part)
}

/// A model spec of key=value pairs with safe characters only (orch validates the names again).
fn valid_model_spec(s: &str) -> bool {
    let safe = |p: &str, extra: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "_-".contains(c) || extra.contains(c));
    !s.is_empty()
        && s.split(',').all(|pair| match pair.split_once('=') {
            Some((k, v)) => safe(k, "") && safe(v, ".:[]"),
            None => false,
        })
}

fn flags(power: &str, max_rounds: u32, dry_run: bool, extra: &Extra) -> Vec<String> {
    let mut v = vec!["--power".into(), power.into(), "--max-rounds".into(), max_rounds.to_string()];
    if dry_run {
        v.push("--dry-run".into());
    }
    if let Some(c) = extra.max_cost.filter(|c| *c > 0.0) {
        v.push("--max-cost".into());
        v.push(c.to_string());
    }
    if let Some(c) = extra.max_cost_total.filter(|c| *c > 0.0) {
        v.push("--max-cost-total".into());
        v.push(c.to_string());
    }
    if let Some(m) = extra.models.as_deref().filter(|m| valid_model_spec(m)) {
        v.push("--model".into());
        v.push(m.into());
    }
    if let Some(l) = extra.on_limit.as_deref().filter(|l| *l == "wait" || *l == "stop") {
        v.push("--on-limit".into());
        v.push(l.into());
    }
    if extra.fast.unwrap_or(false) {
        v.push("--fast".into());
    }
    if extra.critic.unwrap_or(false) {
        v.push("--critic".into());
    }
    if extra.diff_critic.unwrap_or(false) {
        v.push("--diff-critic".into());
    }
    if extra.review.unwrap_or(false) {
        v.push("--review".into());
        if let Some(r) = extra.reviewers.as_deref().filter(|r| valid_reviewers(r)) {
            v.extend(["--reviewers".into(), r.into()]);
        }
    }
    if extra.branch.unwrap_or(false) {
        v.push("--branch".into());
    }
    if extra.pr.unwrap_or(false) {
        v.push("--pr".into());
    }
    if extra.approve_plan.unwrap_or(false) {
        v.push("--approve-plan".into());
    }
    if let Some(l) = extra.intake_label.as_deref().filter(|l| valid_label(l)) {
        v.extend(["--intake".into(), format!("github:{l}")]);
    }
    if let Some(p) = &extra.plugins {
        if p.off.unwrap_or(false) {
            v.extend(["--plugins".into(), "off".into()]);
        }
        let ids: Vec<&str> = p.disable.iter().flatten().map(String::as_str).filter(|s| valid_plugin_id(s)).collect();
        if !ids.is_empty() {
            v.extend(["--disable-plugins".into(), ids.join(",")]);
        }
        if p.hooks == Some(false) {
            v.push("--no-hooks".into());
        }
    }
    v
}

/// Add a repo (or return the existing session). Returns its key.
fn add_session(g: &mut Inner, path: &Path) -> Result<String, String> {
    if !path.is_dir() {
        return Err(format!("not a folder: {}", path.display()));
    }
    let key = key_of(path);
    if g.find(&key).is_none() {
        g.sessions.push(Session {
            repo: path.to_path_buf(),
            running: None,
            pending: None,
            log: Vec::new(),
            events: Vec::new(),
        });
    }
    Ok(key)
}

#[tauri::command]
fn snapshot(state: State<AppState>) -> Value {
    init_value(&state.0.lock().unwrap())
}

#[tauri::command]
fn add_repo(app: AppHandle, state: State<AppState>, path: String) -> Result<(), String> {
    add_session(&mut state.0.lock().unwrap(), Path::new(&path))?;
    persist(&app);
    emit_init(&app);
    Ok(())
}

/// A plain folder name for a new project: letters, digits, dots, dashes and underscores, starting with a letter or
/// digit, at most 64 characters (so no path separators, "..", drive letters or reserved leading characters).
fn valid_project_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// A new folder (parent + a plain name), opened as a repo tab, then `orch new` runs there like any run. The spec goes
/// to orch in a temporary file, which orch deletes once read. Returns the repo path as the tabs show it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn new_project(
    app: AppHandle,
    state: State<AppState>,
    parent: String,
    name: String,
    spec: String,
    setup: Option<String>,
    start: Option<bool>,
    power: String,
    max_cost: Option<f64>,
    max_cost_total: Option<f64>,
    plugins: Option<PluginOpts>,
) -> Result<String, String> {
    if !valid_project_name(&name) {
        return Err("project name: letters, digits, dots, dashes and underscores".into());
    }
    if spec.trim().is_empty() {
        return Err("spec required".into());
    }
    let parent = Path::new(&parent);
    if !parent.is_dir() {
        return Err(format!("not a folder: {}", parent.display()));
    }
    let dir = parent.join(&name);
    if dir.is_dir() && std::fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(true) {
        return Err(format!("{} is not empty", dir.display()));
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    add_session(&mut state.0.lock().unwrap(), &dir)?;
    persist(&app);
    emit_init(&app);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = std::env::temp_dir().join(format!("yaaiorch-brief-{}-{nanos}.md", std::process::id()));
    std::fs::write(&file, spec).map_err(|e| e.to_string())?;
    let mut args = vec![
        "new".to_string(),
        ".".into(),
        "--brief-file".into(),
        file.to_string_lossy().into_owned(),
        "--brief-file-temp".into(),
    ];
    if let Some(s) = setup.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        args.extend(["--setup".into(), s.chars().take(300).collect()]);
    }
    if start.unwrap_or(false) {
        args.push("--start".into());
    }
    let extra = Extra {
        max_cost,
        max_cost_total,
        plugins,
        ..Default::default()
    };
    args.extend(flags(&power, 5, false, &extra));
    let repo = dir.to_string_lossy().into_owned();
    request_start(&app, &repo, args, "new project".into())?;
    Ok(repo)
}

#[tauri::command]
fn remove_repo(app: AppHandle, state: State<AppState>, repo: String) -> Result<(), String> {
    {
        let mut g = state.0.lock().unwrap();
        let i = g.find(&key_of(Path::new(&repo))).ok_or_else(|| format!("unknown repo: {repo}"))?;
        if g.sessions[i].running.is_some() || g.sessions[i].pending.is_some() {
            return Err("stop this repo's run before closing it".into());
        }
        g.sessions.remove(i);
    }
    persist(&app);
    emit_init(&app);
    Ok(())
}

#[tauri::command]
fn set_max_parallel(app: AppHandle, state: State<AppState>, max_parallel: usize) -> Result<(), String> {
    if !(1..=16).contains(&max_parallel) {
        return Err("maxParallel must be 1 to 16".into());
    }
    state.0.lock().unwrap().max_parallel = max_parallel;
    persist(&app);
    emit_init(&app);
    start_next(&app);
    Ok(())
}

/// Daily budget across all repos in USD; None (or 0) removes it.
#[tauri::command]
fn set_daily_budget(app: AppHandle, state: State<AppState>, daily_budget: Option<f64>) -> Result<(), String> {
    let b = match daily_budget {
        Some(b) if !b.is_finite() || b < 0.0 => return Err("dailyBudget must be a positive number".into()),
        Some(0.0) => None,
        b => b,
    };
    state.0.lock().unwrap().daily_budget = b;
    persist(&app);
    emit_global(&app);
    start_next(&app);
    Ok(())
}

/// Percent caps on the subscription's 5-hour and weekly usage (None: no cap).
#[tauri::command]
fn set_usage_cap(app: AppHandle, state: State<AppState>, five_hour: Option<f64>, week: Option<f64>) -> Result<(), String> {
    for (name, v) in [("5-hour", five_hour), ("weekly", week)] {
        if v.is_some_and(|v| !(v > 0.0 && v <= 100.0)) {
            return Err(format!("the {name} cap must be a percentage from 1 to 100"));
        }
    }
    state.0.lock().unwrap().usage_cap = [five_hour, week];
    persist(&app);
    emit_global(&app);
    start_next(&app);
    Ok(())
}

/// "Try now": lift the usage-limit hold before its reset time, and forget readings over a cap.
#[tauri::command]
fn clear_limit(app: AppHandle, state: State<AppState>) {
    {
        let mut g = state.0.lock().unwrap();
        g.usage_limit = None;
        g.usage = [None; 2];
    }
    emit_global(&app);
    start_next(&app);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn run_goal(
    app: AppHandle,
    repo: String,
    goal: String,
    power: String,
    max_rounds: u32,
    dry_run: Option<bool>,
    max_cost: Option<f64>,
    models: Option<String>,
    on_limit: Option<String>,
    fast: Option<bool>,
    critic: Option<bool>,
    diff_critic: Option<bool>,
    review: Option<bool>,
    reviewers: Option<String>,
    branch: Option<bool>,
    pr: Option<bool>,
    approve_plan: Option<bool>,
    plugins: Option<PluginOpts>,
) -> Result<(), String> {
    if goal.trim().is_empty() {
        return Err("goal required".into());
    }
    // One goal: no loop budget, nothing to pull in.
    let extra = Extra {
        intake_label: None,
        max_cost,
        max_cost_total: None,
        models,
        on_limit,
        fast,
        critic,
        diff_critic,
        review,
        reviewers,
        branch,
        pr,
        approve_plan,
        plugins,
    };
    let mut args = vec!["run".to_string()];
    args.extend(flags(&power, max_rounds, dry_run.unwrap_or(false), &extra));
    let label = format!("run: {}", goal.chars().take(60).collect::<String>());
    args.push(goal);
    request_start(&app, &repo, args, label)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn run_loop(
    app: AppHandle,
    repo: String,
    power: String,
    max_rounds: u32,
    dry_run: Option<bool>,
    until_empty: Option<bool>,
    max_cost: Option<f64>,
    max_cost_total: Option<f64>,
    models: Option<String>,
    on_limit: Option<String>,
    fast: Option<bool>,
    critic: Option<bool>,
    diff_critic: Option<bool>,
    review: Option<bool>,
    reviewers: Option<String>,
    branch: Option<bool>,
    pr: Option<bool>,
    approve_plan: Option<bool>,
    intake_label: Option<String>,
    plugins: Option<PluginOpts>,
) -> Result<(), String> {
    let extra = Extra {
        max_cost,
        max_cost_total,
        models,
        on_limit,
        fast,
        critic,
        diff_critic,
        review,
        reviewers,
        branch,
        pr,
        approve_plan,
        intake_label,
        plugins,
    };
    let mut args = vec!["loop".to_string()];
    args.extend(flags(&power, max_rounds, dry_run.unwrap_or(false), &extra));
    if until_empty.unwrap_or(false) {
        args.push("--until-empty".into());
    }
    request_start(&app, &repo, args, "queue loop".into())
}

#[tauri::command]
fn add_goal(app: AppHandle, repo: String, goal: String) -> Result<(), String> {
    if goal.trim().is_empty() {
        return Err("goal required".into());
    }
    let key = key_of(Path::new(&repo));
    let out = node_cmd(&app, &repo_of(&app, &key)?, &["add".into(), goal])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    emit_session(&app, &key);
    Ok(())
}

/// `orch intake --github LABEL`: open GitHub issues with the label, each queued once.
#[tauri::command(async)]
fn intake_goals(app: AppHandle, repo: String, github: String) -> Result<(), String> {
    if !valid_label(&github) {
        return Err("a GitHub label is required".into());
    }
    let key = key_of(Path::new(&repo));
    let out = node_cmd(&app, &repo_of(&app, &key)?, &["intake".into(), "--github".into(), github])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch intake failed")
            .to_string());
    }
    emit_session(&app, &key);
    Ok(())
}

/// `orch retry ID`: a failed or blocked goal, and the goals it blocked, back in the queue.
#[tauri::command]
fn retry_goal(app: AppHandle, repo: String, id: u64) -> Result<(), String> {
    let key = key_of(Path::new(&repo));
    let out = node_cmd(&app, &repo_of(&app, &key)?, &["retry".into(), id.to_string()])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch retry failed")
            .to_string());
    }
    emit_session(&app, &key);
    Ok(())
}

#[tauri::command(async)]
fn agents(app: AppHandle, repo: String) -> Result<Value, String> {
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let out = node_cmd(&app, &dir, &["agents".into(), "--json".into()])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("could not read agent roster: {e}"))
}

#[tauri::command(async)]
fn history(app: AppHandle, repo: String, id: Option<String>) -> Result<Value, String> {
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let mut args = vec!["history".into(), "--json".into()];
    if let Some(id) = id {
        args.push(id);
    }
    let out = node_cmd(&app, &dir, &args)?.output().map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("could not read run history: {e}"))
}

#[tauri::command(async)]
fn save_agent(app: AppHandle, repo: String, name: String, content: String) -> Result<(), String> {
    use std::io::Write;
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let mut child = node_cmd(&app, &dir, &["agents".into(), "--save-agent".into(), name])?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `orch learn`: a read-only pass that writes the project brief. A run like any other (slot, budget, log).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn learn_repo(
    app: AppHandle,
    repo: String,
    power: String,
    max_rounds: Option<u32>,
    max_cost: Option<f64>,
    models: Option<String>,
    on_limit: Option<String>,
    critic: Option<bool>,
    plugins: Option<PluginOpts>,
) -> Result<(), String> {
    let extra = Extra {
        max_cost,
        models,
        on_limit,
        fast: None,
        critic,
        plugins,
        ..Default::default()
    };
    let mut args = vec!["learn".to_string()];
    args.extend(flags(&power, max_rounds.unwrap_or(1), false, &extra));
    request_start(&app, &repo, args, "learn repo".into())
}

/// `orch split --propose`: the architect splits a big brief into goals (a run like learn: slot, budget, log). The
/// brief goes to orch in a temporary file, which orch deletes once read.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn split_brief(
    app: AppHandle,
    repo: String,
    brief: String,
    power: String,
    max_cost: Option<f64>,
    models: Option<String>,
    on_limit: Option<String>,
    plugins: Option<PluginOpts>,
) -> Result<(), String> {
    if brief.trim().is_empty() {
        return Err("brief required".into());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let file = std::env::temp_dir().join(format!("yaaiorch-brief-{}-{nanos}.md", std::process::id()));
    std::fs::write(&file, brief).map_err(|e| e.to_string())?;
    let extra = Extra {
        max_cost,
        models,
        on_limit,
        plugins,
        ..Default::default()
    };
    let mut args = vec![
        "split".to_string(),
        "--propose".into(),
        "--brief-file".into(),
        file.to_string_lossy().into_owned(),
        "--brief-file-temp".into(),
    ];
    args.extend(flags(&power, 1, false, &extra));
    request_start(&app, &repo, args, "split brief".into())
}

/// `orch split --accept`: queue the (edited) goals of a split brief; the brief and goals go on stdin.
#[tauri::command(async)]
fn accept_split(app: AppHandle, repo: String, brief: String, goals: Vec<String>) -> Result<(), String> {
    use std::io::Write;
    let key = key_of(Path::new(&repo));
    let dir = repo_of(&app, &key)?;
    let mut child = node_cmd(&app, &dir, &["split".into(), "--accept".into()])?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(json!({ "brief": brief, "goals": goals }).to_string().as_bytes())
            .map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch split failed")
            .to_string());
    }
    emit_session(&app, &key);
    Ok(())
}

/// `orch approve` for a run waiting with --approve-plan: approve (an edited plan goes on stdin) or reject with a reason.
#[tauri::command(async)]
fn approve_plan(app: AppHandle, repo: String, plan: Option<Value>, reject: Option<String>) -> Result<(), String> {
    use std::io::Write;
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let mut args = vec!["approve".to_string()];
    match (&reject, &plan) {
        (Some(r), _) => args.extend(["--reject".into(), r.chars().take(4000).collect()]),
        (None, Some(_)) => args.push("--plan-stdin".into()),
        _ => {}
    }
    let mut child = node_cmd(&app, &dir, &args)?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if let (None, Some(p), Some(mut stdin)) = (&reject, &plan, child.stdin.take()) {
        stdin.write_all(p.to_string().as_bytes()).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch approve failed")
            .to_string());
    }
    Ok(())
}

/// `orch share`: proposes a CLAUDE.md section on an orchestrator/claude-md-* branch (the working tree is untouched).
#[tauri::command]
fn share_repo(
    app: AppHandle,
    repo: String,
    power: String,
    max_cost: Option<f64>,
    models: Option<String>,
    on_limit: Option<String>,
    plugins: Option<PluginOpts>,
) -> Result<(), String> {
    let extra = Extra {
        max_cost,
        models,
        on_limit,
        plugins,
        ..Default::default()
    };
    let mut args = vec!["share".to_string()];
    args.extend(flags(&power, 1, false, &extra));
    request_start(&app, &repo, args, "share to CLAUDE.md".into())
}

/// Runs as a normal orch process: one per repo, output streams to that repo's log.
#[tauri::command]
fn rollback(app: AppHandle, repo: String) -> Result<(), String> {
    request_start(&app, &repo, vec!["rollback".into()], "rollback".into())
}

/// `orch plugins --json --details` in a repo: the user's Claude Code plugins with their token cost.
/// Async: it makes one CLI call per plugin.
#[tauri::command(async)]
fn plugins(app: AppHandle, repo: String) -> Result<Value, String> {
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let out = node_cmd(&app, &dir, &["plugins".into(), "--json".into(), "--details".into()])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .lines()
        .find(|l| l.starts_with('['))
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or_else(|| {
            String::from_utf8_lossy(&out.stderr)
                .trim()
                .lines()
                .last()
                .unwrap_or("could not list plugins")
                .to_string()
        })
}

/// `orch doctor --json` in a repo. Async so starting node does not freeze the window.
#[tauri::command(async)]
fn doctor(app: AppHandle, repo: String) -> Value {
    let fail = |detail: String| json!([{ "name": "orchestrator", "level": "fail", "detail": detail }]);
    let out = match repo_of(&app, &key_of(Path::new(&repo)))
        .and_then(|dir| node_cmd(&app, &dir, &["doctor".into(), "--json".into()]))
        .and_then(|mut c| c.output().map_err(|e| format!("{NODE_HINT}: {e}")))
    {
        Ok(o) => o,
        Err(e) => return fail(e),
    };
    // exit 1 just means a "fail" finding; the JSON is still on stdout
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| fail(String::from_utf8_lossy(&out.stderr).trim().to_string()))
}

/// Ask a running queue loop to stop before its next goal (the file `orch stop-after` writes).
#[tauri::command]
fn stop_after(app: AppHandle, state: State<AppState>, repo: String) -> Result<(), String> {
    let key = key_of(Path::new(&repo));
    let dir = {
        let g = state.0.lock().unwrap();
        let i = g.find(&key).ok_or("unknown repo")?;
        if g.sessions[i].running.is_none() {
            return Err("nothing is running in this repo".into());
        }
        g.sessions[i].repo.join(".orchestrator")
    };
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("stop-after-goal"), now_ms().to_string()).map_err(|e| e.to_string())?;
    push_line(&app, &key, "-- the queue will stop after the current goal --".into());
    Ok(())
}

/// Cancel a start waiting for a slot, or kill the repo's run (whole process tree).
#[tauri::command]
fn stop(app: AppHandle, state: State<AppState>, repo: String) {
    let key = key_of(Path::new(&repo));
    let (pid, cancelled) = {
        let mut g = state.0.lock().unwrap();
        match g.find(&key) {
            Some(i) => {
                let cancelled = g.sessions[i].pending.take().is_some();
                (g.sessions[i].running.as_ref().map(|r| r.pid), cancelled)
            }
            None => (None, false),
        }
    };
    if cancelled {
        push_line(&app, &key, "-- start cancelled --".into());
        emit_session(&app, &key);
    }
    if let Some(pid) = pid {
        kill_tree(pid);
    }
}

#[tauri::command]
fn clear_log(app: AppHandle, state: State<AppState>, repo: String) {
    {
        let mut g = state.0.lock().unwrap();
        if let Some(i) = g.find(&key_of(Path::new(&repo))) {
            g.sessions[i].log.clear();
        }
    }
    emit_init(&app);
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState(Mutex::new(Inner::default())))
        .setup(|app| {
            if let Ok(dir) = app.path().app_config_dir() {
                let saved = read_json(dir.join("repos.json"), json!({}));
                // Before multi-repo support the app remembered one repo in repo.txt.
                let mut repos: Vec<String> = saved["repos"]
                    .as_array()
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                if repos.is_empty() {
                    if let Ok(s) = fs::read_to_string(dir.join("repo.txt")) {
                        repos.push(s.trim().to_string());
                    }
                }
                let st = app.state::<AppState>();
                let mut g = st.0.lock().unwrap();
                if let Some(n) = saved["maxParallel"].as_u64().filter(|n| (1..=16).contains(n)) {
                    g.max_parallel = n as usize;
                }
                g.daily_budget = saved["dailyBudget"].as_f64().filter(|b| *b > 0.0);
                for (i, (k, _, _)) in WINDOWS.iter().enumerate() {
                    g.usage_cap[i] = saved["usageCap"][*k].as_f64().filter(|c| *c > 0.0 && *c <= 100.0);
                }
                if saved["spent"]["day"].as_str() == Some(today().as_str()) {
                    g.spent_usd = saved["spent"]["usd"].as_f64().unwrap_or(0.0);
                }
                for r in repos {
                    let _ = add_session(&mut g, Path::new(&r));
                }
            }
            // Lift an expired usage-limit hold and start a new budget day, then start what waits.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(30));
                let changed = {
                    let st = handle.state::<AppState>();
                    let mut g = st.0.lock().unwrap();
                    let mut changed = false;
                    if g.usage_limit.as_ref().is_some_and(|(_, u)| *u <= now_ms()) {
                        g.usage_limit = None;
                        changed = true;
                    }
                    if g.spent_day != today() {
                        g.spent_day = today();
                        g.spent_usd = 0.0;
                        changed = true;
                    }
                    for u in g.usage.iter_mut() {
                        if u.is_some_and(|(_, resets)| resets <= now_ms()) {
                            *u = None; // that window has reset; the next agent call brings a fresh reading
                            changed = true;
                        }
                    }
                    changed
                };
                if changed {
                    persist(&handle);
                    emit_global(&handle);
                    start_next(&handle);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            snapshot,
            add_repo,
            new_project,
            remove_repo,
            set_max_parallel,
            set_daily_budget,
            set_usage_cap,
            clear_limit,
            run_goal,
            run_loop,
            add_goal,
            retry_goal,
            intake_goals,
            agents,
            history,
            save_agent,
            stop,
            clear_log,
            rollback,
            learn_repo,
            share_repo,
            approve_plan,
            split_brief,
            accept_split,
            stop_after,
            doctor,
            plugins
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let pids: Vec<u32> = handle
                .state::<AppState>()
                .0
                .lock()
                .unwrap()
                .sessions
                .iter()
                .filter_map(|s| s.running.as_ref().map(|r| r.pid))
                .collect();
            for pid in pids {
                kill_tree(pid);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_caps_max_cost() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            with_budget(v(&["run", "g", "--max-cost", "5"]), Some(1.0), ""),
            v(&["run", "g", "--max-cost", "1.00"])
        );
        assert_eq!(
            with_budget(v(&["run", "g", "--max-cost", "0.5"]), Some(1.0), ""),
            v(&["run", "g", "--max-cost", "0.50"])
        );
        // A loop gets it as the budget for all its goals; a goal's own --max-cost stays as given.
        assert_eq!(with_budget(v(&["loop"]), Some(2.5), ""), v(&["loop", "--max-cost-total", "2.50"]));
        assert_eq!(
            with_budget(v(&["loop", "--max-cost", "1", "--max-cost-total", "9"]), Some(2.5), ""),
            v(&["loop", "--max-cost", "1", "--max-cost-total", "2.50"])
        );
        assert_eq!(
            with_budget(v(&["new", ".", "--start", "--max-cost", "1"]), Some(2.0), ""),
            v(&["new", ".", "--start", "--max-cost", "1", "--max-cost-total", "2.00"])
        );
        assert_eq!(with_budget(v(&["new", "."]), Some(2.0), ""), v(&["new", ".", "--max-cost", "2.00"]));
        assert_eq!(with_budget(v(&["run", "g"]), None, ""), v(&["run", "g"]));
        assert_eq!(with_budget(v(&["rollback"]), Some(1.0), "5h=80"), v(&["rollback"]));
        assert_eq!(
            with_budget(v(&["run", "g"]), None, "5h=80,week=90"),
            v(&["run", "g", "--usage-cap", "5h=80,week=90"])
        );
        assert_eq!(
            with_budget(v(&["run", "g", "--usage-cap", "5h=50"]), None, "5h=80"),
            v(&["run", "g", "--usage-cap", "5h=50"])
        );
    }

    #[test]
    fn intake_flag() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let tail = |l: &str| {
            flags(
                "heavy",
                1,
                false,
                &Extra {
                    intake_label: Some(l.into()),
                    ..Default::default()
                },
            )[4..]
                .to_vec()
        };
        assert_eq!(tail("orch: ready"), v(&["--intake", "github:orch: ready"]));
        assert!(tail("a;rm -rf /").is_empty());
        assert!(tail("").is_empty());
    }

    #[test]
    fn project_names() {
        for ok in ["app", "my-app", "a.b_c-1", "9lives", &"x".repeat(64)] {
            assert!(valid_project_name(ok), "{ok}");
        }
        for bad in ["", ".hidden", "-x", "a/b", "a\\b", "..", "C:", "a b", "naïve", &"x".repeat(65)] {
            assert!(!valid_project_name(bad), "{bad}");
        }
    }

    #[test]
    fn review_flags() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let tail = |e: Extra| flags("heavy", 1, false, &e)[4..].to_vec();
        let on = Extra {
            diff_critic: Some(true),
            review: Some(true),
            reviewers: Some("security-reviewer,a.b:c".into()),
            ..Default::default()
        };
        assert_eq!(tail(on), v(&["--diff-critic", "--review", "--reviewers", "security-reviewer,a.b:c"]));
        let bad = Extra {
            review: Some(true),
            reviewers: Some("a;rm -rf".into()),
            ..Default::default()
        };
        assert_eq!(tail(bad), v(&["--review"]));
        let off = Extra {
            reviewers: Some("a".into()),
            ..Default::default()
        };
        assert!(tail(off).is_empty());
    }

    #[test]
    fn plugin_flags() {
        let extra = |p: PluginOpts| Extra {
            plugins: Some(p),
            ..Default::default()
        };
        let tail = |e: Extra| flags("heavy", 1, false, &e)[4..].to_vec();
        assert!(tail(extra(PluginOpts::default())).is_empty());
        let p = PluginOpts {
            off: Some(true),
            disable: Some(vec!["caveman@caveman".into(), "a b;rm".into(), "@x".into(), "x@".into()]),
            hooks: Some(false),
        };
        assert_eq!(tail(extra(p)), ["--plugins", "off", "--disable-plugins", "caveman@caveman", "--no-hooks"]);
        assert!(valid_plugin_id("superpowers@claude-plugins-official") && valid_plugin_id("local-plugin"));
        assert!(!valid_plugin_id("a@b@c") && !valid_plugin_id("") && !valid_plugin_id("-x"));
    }

    #[test]
    fn gate_reports_limit_then_budget() {
        let mut g = Inner {
            daily_budget: Some(1.0),
            spent_usd: 0.5,
            ..Inner::default()
        };
        assert_eq!(g.gate(), None);
        g.spent_usd = 1.0;
        assert!(g.gate().unwrap().contains("daily budget"));
        g.usage_limit = Some(("r".into(), now_ms() + 60_000));
        assert!(g.gate().unwrap().starts_with("usage limit"));
        g.usage_limit = Some(("r".into(), now_ms() - 1));
        assert!(g.gate().unwrap().contains("daily budget"));

        let mut g = Inner {
            usage: [Some((85.0, now_ms() + 60_000)), Some((20.0, now_ms() + 60_000))],
            ..Inner::default()
        };
        assert_eq!(g.gate(), None, "no caps set");
        g.usage_cap = [Some(90.0), Some(20.0)];
        assert!(g.gate().unwrap().starts_with("weekly usage at 20% (cap 20%"), "{:?}", g.gate());
        assert_eq!(g.cap_spec(), "5h=90,week=20");
        g.usage[1] = Some((20.0, now_ms() - 1));
        assert_eq!(g.gate(), None, "a reset window holds nothing");
    }

    fn wait_idle<R: Runtime>(h: &AppHandle<R>) {
        for _ in 0..300 {
            {
                let st = h.state::<AppState>();
                let g = st.0.lock().unwrap();
                if g.running_count() == 0 && g.sessions.iter().all(|s| s.pending.is_none()) {
                    return;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        panic!("runs did not finish in time");
    }

    /// Spawns the real orch.mjs with the fake claude in two repos. Ignored by default because it needs:
    /// TEST_REPO (an empty dir), ORCH_PATH (built orch.mjs) and CLAUDE_BIN (test/fake-claude/claude[.cmd]).
    /// Run with `cargo test -- --ignored` (CI does).
    #[test]
    #[ignore]
    fn runs_orch_in_two_repos_within_the_parallel_limit() {
        let repo = PathBuf::from(std::env::var("TEST_REPO").expect("set TEST_REPO, ORCH_PATH and CLAUDE_BIN to run this test"));
        assert!(std::env::var("ORCH_PATH").is_ok(), "set ORCH_PATH to the built orch.mjs");
        assert!(
            std::env::var("CLAUDE_BIN").is_ok(),
            "set CLAUDE_BIN to test/fake-claude/claude.cmd (or claude on POSIX)"
        );
        let second = repo.join("second-repo");
        fs::create_dir_all(&second).unwrap();

        let app = tauri::test::mock_builder()
            .manage(AppState(Mutex::new(Inner::default())))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let h = app.handle().clone();
        let (a, b) = {
            let st = h.state::<AppState>();
            let mut g = st.0.lock().unwrap();
            g.max_parallel = 1;
            (add_session(&mut g, &repo).unwrap(), add_session(&mut g, &second).unwrap())
        };
        let run_args = || {
            let mut args = vec!["run".to_string()];
            args.extend(flags("heavy", 5, false, &Extra::default()));
            args.push("hello".into());
            args
        };
        request_start(&h, &a, run_args(), "a".into()).unwrap();
        assert!(
            request_start(&h, &a, vec!["agents".into()], "x".into()).is_err(),
            "a second run in the same repo is refused"
        );
        request_start(&h, &b, run_args(), "b".into()).unwrap();
        {
            let st = h.state::<AppState>();
            let g = st.0.lock().unwrap();
            let sb = &g.sessions[g.find(&b).unwrap()];
            assert!(sb.pending.is_some() && sb.running.is_none(), "with max_parallel 1 the second repo waits");
        }
        wait_idle(&h);

        let st = h.state::<AppState>();
        let g = st.0.lock().unwrap();
        for key in [&a, &b] {
            let s = &g.sessions[g.find(key).unwrap()];
            let types: Vec<&str> = s.events.iter().map(|e| e["type"].as_str().unwrap()).collect();
            assert_eq!(types.first().copied(), Some("goal_start"), "{key}");
            let end = s.events.last().unwrap();
            assert_eq!(end["type"], "goal_end");
            assert_eq!(end["passed"], true);
            assert!(s.log.iter().any(|l| l.starts_with("-- exited (0)")), "log: {:?}", s.log);
            assert!(session_value(s, None)["queue"].is_array());
            let list = node_cmd(&h, &s.repo, &["history".into(), "--json".into()]).unwrap().output().unwrap();
            assert!(list.status.success(), "{}", String::from_utf8_lossy(&list.stderr));
            let entries: Value = serde_json::from_slice(&list.stdout).unwrap();
            let id = entries[0]["id"].as_str().unwrap();
            assert_eq!(entries[0]["status"], "passed");
            let replay = node_cmd(&h, &s.repo, &["history".into(), "--json".into(), id.into()])
                .unwrap()
                .output()
                .unwrap();
            assert!(replay.status.success(), "{}", String::from_utf8_lossy(&replay.stderr));
            let recording: Value = serde_json::from_slice(&replay.stdout).unwrap();
            assert_eq!(recording["events"][0]["type"], "goal_start");
            assert!(recording["events"].as_array().unwrap().iter().any(|e| e["type"] == "goal_end"));
        }
        let sb = &g.sessions[g.find(&b).unwrap()];
        assert!(sb.log.iter().any(|l| l.contains("waiting: free slot")), "log: {:?}", sb.log);
    }
}
