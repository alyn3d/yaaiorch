#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// SPDX-FileCopyrightText: 2026 alyn3d and contributors
// SPDX-License-Identifier: GPL-3.0-only

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
    /// A repo's folder, or a repo group's run dir.
    repo: PathBuf,
    /// Set on a repo group's session: its config from `orch group list --json` (name, dir, repos). Its process is
    /// `orch group run|rollback NAME`.
    group: Option<Value>,
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
    /// The group that has `repo` as a member and runs (or waits to start), if any: its name.
    fn busy_group_of(&self, repo: &Path) -> Option<String> {
        let key = key_of(repo);
        self.sessions
            .iter()
            .filter(|g| g.running.is_some() || g.pending.is_some())
            .filter_map(|g| g.group.as_ref())
            .find(|g| group_paths(g).iter().any(|p| key_of(Path::new(p)) == key))
            .map(|g| g["name"].as_str().unwrap_or_default().to_string())
    }
    /// The keys of a group session's member repos that are open.
    fn members_of(&self, i: usize) -> Vec<String> {
        self.sessions[i]
            .group
            .as_ref()
            .map(group_paths)
            .unwrap_or_default()
            .iter()
            .map(|p| key_of(Path::new(p)))
            .filter(|k| self.find(k).is_some())
            .collect()
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

/// One session per folder; Windows paths are case-insensitive and take either slash.
fn key_of(p: &Path) -> String {
    let s = p.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s
    }
}

fn read_json(path: PathBuf, fallback: Value) -> Value {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(fallback)
}

/// The member repo paths of a group config.
fn group_paths(g: &Value) -> Vec<String> {
    g["repos"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["path"].as_str().map(str::to_string))
        .collect()
}

fn session_value(g: &Inner, s: &Session, gate: Option<&str>) -> Value {
    let dir = s.repo.join(".orchestrator");
    let mut v = json!({
        "repo": s.repo.to_string_lossy(),
        "running": s.running.as_ref().map(|r| json!({ "pid": r.pid, "label": r.label, "startedAt": r.started_at })),
        "queued": s.pending.is_some(),
        "waitReason": s.pending.as_ref().map(|_| gate.unwrap_or("free slot")),
        "queue": read_json(dir.join("queue.json"), json!([])),
        "lastRun": read_json(dir.join("last-run.json"), Value::Null),
    });
    match &s.group {
        Some(cfg) => v["group"] = cfg.clone(),
        None => {
            if let Some(name) = g.busy_group_of(&s.repo) {
                v["inGroup"] = name.into();
            }
        }
    }
    v
}

fn init_value(g: &Inner) -> Value {
    let gate = g.gate();
    json!({
        "sessions": g.sessions.iter().map(|s| json!({ "state": session_value(g, s, gate.as_deref()), "log": s.log, "events": s.events })).collect::<Vec<_>>(),
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
            .map(|s| session_value(&g, s, gate.as_deref()))
            .collect();
        (g.global_value(), waiting)
    };
    let _ = app.emit("orch-global", global);
    for s in waiting {
        let _ = app.emit("orch-session", s);
    }
}

/// Count money spent today toward the daily budget (agent calls, Agent M's chat).
fn add_spent<R: Runtime>(app: &AppHandle<R>, cost: f64) {
    if cost.is_nan() || cost <= 0.0 {
        return;
    }
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

/// `orch group run` wraps each member's own event in `group_child {repo, role, event}`: the member repo's path and that
/// event, unchanged. Any other event comes back as it is, without a repo.
fn unwrap_group_event(v: &Value) -> (Option<String>, &Value) {
    let inner = &v["event"];
    if v["type"] != "group_child" || !inner["type"].is_string() {
        return (None, v);
    }
    (v["repo"].as_str().filter(|r| !r.is_empty()).map(str::to_string), inner)
}

/// Count agent-call costs, hold new starts on a usage limit, stop a loop at its next goal when the
/// day's budget is used up. A group member's event whose repo has no session of its own counts here, unwrapped.
fn on_event<R: Runtime>(app: &AppHandle<R>, key: &str, ev: &Value) {
    let (_, ev) = unwrap_group_event(ev);
    let kind = ev["type"].as_str().unwrap_or("");
    let cost = ev["cost"].as_f64().filter(|c| *c > 0.0);
    if let Some(cost) = cost.filter(|_| {
        matches!(
            kind,
            "plan" | "task_end" | "review" | "learn_end" | "notes_tidy" | "share_end" | "split_proposal" | "coverage" | "group_plan" | "group_fault"
        )
    }) {
        add_spent(app, cost);
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

/// One session's state; a group's members too, since they show "in group" while it runs or waits.
fn emit_session<R: Runtime>(app: &AppHandle<R>, key: &str) {
    let values: Vec<Value> = {
        let st = app.state::<AppState>();
        let g = st.0.lock().unwrap();
        let gate = g.gate();
        match g.find(key) {
            Some(i) => std::iter::once(i)
                .chain(g.members_of(i).iter().filter_map(|k| g.find(k)))
                .map(|j| session_value(&g, &g.sessions[j], gate.as_deref()))
                .collect(),
            None => Vec::new(),
        }
    };
    for v in values {
        let _ = app.emit("orch-session", v);
    }
}

/// Whether a group member's event from session `from` goes to session `member`: an open session other than the group's
/// with no run of its own (live or waiting to start), so it never mixes into that run.
fn routes_to(g: &Inner, from: &str, member: &str) -> bool {
    member != from
        && g.find(member)
            .is_some_and(|i| g.sessions[i].running.is_none() && g.sessions[i].pending.is_none())
}

/// One structured event from the process of session `key`. A group member's wrapped event goes to the session of that
/// member's repo as if its own process had printed it; without such a session, or while that session has its own run,
/// it stays here (the group's), still wrapped.
fn push_event<R: Runtime>(app: &AppHandle<R>, key: &str, ev: Value) {
    if let (Some(member), inner) = unwrap_group_event(&ev) {
        let member = key_of(Path::new(&member));
        let route = {
            let st = app.state::<AppState>();
            let g = st.0.lock().unwrap();
            routes_to(&g, key, &member)
        };
        if route {
            let inner = inner.clone();
            return push_event(app, &member, inner);
        }
    }
    let repo = {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        let Some(i) = g.find(key) else { return };
        let s = &mut g.sessions[i];
        if ev["type"] == "goal_start" || ev["type"] == "group_start" {
            s.events.clear();
        }
        s.events.push(ev.clone());
        s.repo.to_string_lossy().to_string()
    };
    let _ = app.emit("orch-ev", json!({ "repo": repo, "ev": ev }));
    on_event(app, key, &ev);
}

fn push_line<R: Runtime>(app: &AppHandle<R>, key: &str, line: String) {
    if let Some(ev) = line.strip_prefix(MARK).and_then(|rest| serde_json::from_str::<Value>(rest).ok()) {
        return push_event(app, key, ev);
    }
    let repo = {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        let Some(i) = g.find(key) else { return };
        let s = &mut g.sessions[i];
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
            "repos": g.sessions.iter().filter(|s| s.group.is_none()).map(|s| s.repo.to_string_lossy()).collect::<Vec<_>>(),
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
    let dev = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/resources/orch.mjs"));
    if cfg!(debug_assertions) && dev.exists() {
        return Ok(dev);
    }
    if let Ok(p) = app.path().resolve("resources/orch.mjs", BaseDirectory::Resource) {
        if p.exists() {
            return Ok(strip_verbatim(p));
        }
    }
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
        let is_group = g.sessions[i].group.is_some();
        if g.sessions[i].running.is_some() || g.sessions[i].pending.is_some() {
            return Err(format!(
                "this {} already has a run (or one waiting to start)",
                if is_group { "group" } else { "repo" }
            ));
        }
        if is_group && args.first().map(String::as_str) != Some("group") {
            return Err("not available for a repo group".into());
        }
        if let Some(name) = g.busy_group_of(&g.sessions[i].repo).filter(|_| !is_group) {
            return Err(format!("this repo is busy in group \"{name}\"; stop the group first"));
        }
        if let Some(busy) = g
            .members_of(i)
            .iter()
            .filter_map(|k| g.find(k))
            .find(|&j| g.sessions[j].running.is_some() || g.sessions[j].pending.is_some())
        {
            return Err(format!(
                "{} has a run of its own (or one waiting to start); stop it first",
                g.sessions[busy].repo.display()
            ));
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
    if args.len() > 2 && args[0] == "group" && args[1] == "run" {
        // `orch group run` takes no usage caps (the holds still stop new starts); it gets the day's budget left as
        // --max-cost, before its goal, which comes last.
        let Some(left) = left else { return args };
        let goal = args.pop().unwrap_or_default();
        let mut own = f64::INFINITY;
        let mut out = Vec::with_capacity(args.len() + 3);
        let mut it = args.into_iter();
        while let Some(a) = it.next() {
            if a == "--max-cost" {
                own = it.next().and_then(|v| v.parse().ok()).unwrap_or(f64::INFINITY);
            } else {
                out.push(a);
            }
        }
        out.extend(["--max-cost".into(), format!("{:.2}", own.min(left)), goal]);
        return out;
    }
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
    worktrees: Option<bool>,
    pr: Option<bool>,
    approve_plan: Option<bool>,
    ask: Option<bool>,
    /// Agent M: implementers may run shell commands a human approves (--commands).
    commands: Option<bool>,
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
    if let Some(fast) = extra.fast {
        v.push(if fast { "--fast" } else { "--no-fast" }.into());
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
    if let Some(worktrees) = extra.worktrees {
        v.push(if worktrees { "--worktrees" } else { "--no-worktrees" }.into());
    }
    if extra.pr.unwrap_or(false) {
        v.push("--pr".into());
    }
    if extra.approve_plan.unwrap_or(false) {
        v.push("--approve-plan".into());
    }
    if let Some(ask) = extra.ask {
        v.push(if ask { "--ask" } else { "--no-ask" }.into());
    }
    if let Some(commands) = extra.commands {
        v.push(if commands { "--commands" } else { "--no-commands" }.into());
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
            group: None,
            running: None,
            pending: None,
            log: Vec::new(),
            events: Vec::new(),
        });
    }
    Ok(key)
}

fn home_dir() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// `orch <args>` in the home folder (group commands need no repo); its stdout, or the last line of stderr.
fn orch_home<R: Runtime>(app: &AppHandle<R>, args: &[String]) -> Result<String, String> {
    let out = node_cmd(app, &home_dir(), args)?.output().map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().lines().last().unwrap_or("orch failed").to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// One session per repo group (`orch group list --json`), keyed by its run dir: added, updated, or (when idle) dropped.
fn apply_groups(g: &mut Inner, list: &[Value]) {
    let mut seen = Vec::new();
    for cfg in list {
        let (Some(dir), Some(_)) = (cfg["dir"].as_str(), cfg["name"].as_str()) else {
            continue;
        };
        let dir = PathBuf::from(dir);
        let _ = fs::create_dir_all(&dir);
        let key = key_of(&dir);
        match g.find(&key) {
            Some(i) => g.sessions[i].group = Some(cfg.clone()),
            None => g.sessions.push(Session {
                repo: dir,
                group: Some(cfg.clone()),
                running: None,
                pending: None,
                log: Vec::new(),
                events: Vec::new(),
            }),
        }
        seen.push(key);
    }
    g.sessions
        .retain(|s| s.group.is_none() || seen.contains(&key_of(&s.repo)) || s.running.is_some() || s.pending.is_some());
}

fn sync_groups<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let out = orch_home(app, &["group".into(), "list".into(), "--json".into()])?;
    let list: Vec<Value> = out
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str(l.trim()).ok())
        .ok_or("orch group list returned no list")?;
    apply_groups(&mut app.state::<AppState>().0.lock().unwrap(), &list);
    emit_init(app);
    Ok(())
}

/// A group name: lowercase letters, digits and dashes (orch checks it again).
fn valid_group_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// `orch group add` from the group form: a name, two absolute folders, the backend's serve, the frontend's env.
#[allow(clippy::too_many_arguments)]
fn group_add_args(
    name: &str,
    backend: &str,
    frontend: &str,
    serve_url: Option<&str>,
    serve_command: Option<&str>,
    base_url: Option<&str>,
    env: &serde_json::Map<String, Value>,
) -> Result<Vec<String>, String> {
    if !valid_group_name(name) {
        return Err("group name: lowercase letters, digits and dashes".into());
    }
    let (be, fe) = (Path::new(backend.trim()), Path::new(frontend.trim()));
    if !be.is_absolute() || !fe.is_absolute() {
        return Err("the backend and frontend folders must be absolute paths".into());
    }
    let mut args: Vec<String> = vec![
        "group".into(),
        "add".into(),
        name.into(),
        "--repo".into(),
        format!("{}:backend", be.display()),
        "--repo".into(),
        format!("{}:frontend", fe.display()),
    ];
    let some = |v: Option<&str>| v.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    if let Some(u) = some(serve_url) {
        args.extend(["--serve-url".into(), u]);
    }
    if let Some(c) = some(serve_command) {
        args.extend(["--serve-command".into(), c.chars().take(500).collect()]);
    }
    if let Some(u) = some(base_url) {
        args.extend(["--base-url".into(), u]);
    }
    for (k, v) in env {
        let ok =
            k.chars().next().is_some_and(|c| c.is_ascii_uppercase() || c == '_') && k.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
        let Some(v) = v.as_str().filter(|_| ok) else {
            return Err(format!("env {k}: a NAME in capitals and a text value"));
        };
        args.extend(["--env".into(), format!("{k}={v}")]);
    }
    Ok(args)
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn save_group(
    app: AppHandle,
    name: String,
    backend: String,
    frontend: String,
    serve_url: Option<String>,
    serve_command: Option<String>,
    base_url: Option<String>,
    env: Option<serde_json::Map<String, Value>>,
) -> Result<(), String> {
    let args = group_add_args(
        &name,
        &backend,
        &frontend,
        serve_url.as_deref(),
        serve_command.as_deref(),
        base_url.as_deref(),
        &env.unwrap_or_default(),
    )?;
    orch_home(&app, &args)?;
    sync_groups(&app)
}

#[tauri::command(async)]
fn remove_group(app: AppHandle, name: String) -> Result<(), String> {
    {
        let st = app.state::<AppState>();
        let mut g = st.0.lock().unwrap();
        let i = g
            .sessions
            .iter()
            .position(|s| s.group.as_ref().is_some_and(|c| c["name"] == name.as_str()))
            .ok_or_else(|| format!("unknown group: {name}"))?;
        if g.sessions[i].running.is_some() || g.sessions[i].pending.is_some() {
            return Err("stop this group's run before removing it".into());
        }
        g.sessions.remove(i);
    }
    orch_home(&app, &["group".into(), "remove".into(), name])?;
    sync_groups(&app)
}

/// The group's name when `key` is a group session.
fn group_name<R: Runtime>(app: &AppHandle<R>, key: &str) -> Option<String> {
    let st = app.state::<AppState>();
    let g = st.0.lock().unwrap();
    g.find(key)
        .and_then(|i| g.sessions[i].group.as_ref())
        .and_then(|c| c["name"].as_str().map(str::to_string))
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
    remote: Option<String>,
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
    // orch checks the URL (never an option, no whitespace); any git host or a local path.
    if let Some(r) = remote.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
        args.extend(["--remote".into(), r.chars().take(500).collect()]);
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
        if g.sessions[i].group.is_some() {
            return Err("a group is removed with remove_group".into());
        }
        if g.sessions[i].running.is_some() || g.sessions[i].pending.is_some() {
            return Err("stop this repo's run before closing it".into());
        }
        if g.busy_group_of(&g.sessions[i].repo).is_some() {
            return Err("this repo is busy in a group run; stop the group first".into());
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
    worktrees: Option<bool>,
    pr: Option<bool>,
    approve_plan: Option<bool>,
    ask: Option<bool>,
    commands: Option<bool>,
    plugins: Option<PluginOpts>,
) -> Result<(), String> {
    if goal.trim().is_empty() {
        return Err("goal required".into());
    }
    let key = key_of(Path::new(&repo));
    if let Some(name) = group_name(&app, &key) {
        // A group's goal: its members open as tabs first, so their own events show there.
        let members = {
            let st = app.state::<AppState>();
            let mut g = st.0.lock().unwrap();
            let paths = g.find(&key).and_then(|i| g.sessions[i].group.as_ref()).map(group_paths).unwrap_or_default();
            let before = g.sessions.len();
            for p in paths {
                let _ = add_session(&mut g, Path::new(&p));
            }
            g.sessions.len() != before
        };
        if members {
            persist(&app);
            emit_init(&app);
        }
        let goal = goal.trim().to_string();
        let mut args: Vec<String> = vec!["group".into(), "run".into(), name];
        args.extend(["--power".into(), power, "--max-rounds".into(), max_rounds.clamp(1, 20).to_string()]);
        if let Some(c) = max_cost.filter(|c| *c > 0.0) {
            args.extend(["--max-cost".into(), c.to_string()]);
        }
        if let Some(m) = models.as_deref().filter(|m| valid_model_spec(m)) {
            args.extend(["--model".into(), m.into()]);
        }
        if approve_plan.unwrap_or(false) {
            args.push("--approve-plan".into());
        }
        if let Some(fast) = fast {
            args.push(if fast { "--fast" } else { "--no-fast" }.into());
        }
        if let Some(l) = on_limit.as_deref().filter(|l| *l == "wait" || *l == "stop") {
            args.extend(["--on-limit".into(), l.into()]);
        }
        let label = format!("group: {}", goal.chars().take(60).collect::<String>());
        args.push(goal);
        return request_start(&app, &repo, args, label);
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
        worktrees,
        pr,
        approve_plan,
        ask,
        commands,
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
    worktrees: Option<bool>,
    pr: Option<bool>,
    approve_plan: Option<bool>,
    ask: Option<bool>,
    commands: Option<bool>,
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
        worktrees,
        pr,
        approve_plan,
        ask,
        commands,
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

#[tauri::command(async)]
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
#[tauri::command(async)]
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
fn move_goal(app: AppHandle, repo: String, id: u64, direction: String) -> Result<(), String> {
    if direction != "up" && direction != "down" {
        return Err("direction must be up or down".into());
    }
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let out = node_cmd(&app, &dir, &["move".into(), id.to_string(), direction])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch move failed")
            .to_string());
    }
    emit_session(&app, &key_of(&dir));
    Ok(())
}

#[tauri::command(async)]
fn visual_image(app: AppHandle, repo: String, file: String) -> Result<Vec<u8>, String> {
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let relative = Path::new(&file);
    let parts: Vec<_> = relative.components().collect();
    if parts.len() < 3
        || parts[0].as_os_str() != ".orchestrator"
        || parts[1].as_os_str() != "visual"
        || parts.iter().any(|part| !matches!(part, std::path::Component::Normal(_)))
        || relative.extension().and_then(|ext| ext.to_str()) != Some("png")
    {
        return Err("invalid screenshot path".into());
    }
    let visual_root = fs::canonicalize(dir.join(".orchestrator").join("visual")).map_err(|e| e.to_string())?;
    let image = fs::canonicalize(dir.join(relative)).map_err(|e| e.to_string())?;
    if !image.starts_with(&visual_root) || !image.is_file() {
        return Err("invalid screenshot path".into());
    }
    fs::read(image).map_err(|e| format!("could not read screenshot: {e}"))
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

#[tauri::command(async)]
fn swap_agent(app: AppHandle, repo: String, role: String, target: Option<String>) -> Result<(), String> {
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let args = if let Some(target) = target {
        vec!["agents".into(), "--swap".into(), format!("{role}={target}")]
    } else {
        vec!["agents".into(), "--unswap".into(), role]
    };
    let out = node_cmd(&app, &dir, &args)?.output().map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The `orch agents` flag that turns a skill or custom agent on or off in a repo, or None for an unknown kind.
fn toggle_flag(kind: &str, enabled: bool) -> Option<&'static str> {
    match (kind, enabled) {
        ("skill", true) => Some("--enable-skill"),
        ("skill", false) => Some("--disable-skill"),
        ("agent", true) => Some("--enable-agent"),
        ("agent", false) => Some("--disable-agent"),
        _ => None,
    }
}

/// Turn a skill or custom agent on or off in this repo (`orch agents --disable-skill NAME` and the like).
#[tauri::command(async)]
fn toggle_roster(app: AppHandle, repo: String, kind: String, name: String, enabled: bool) -> Result<(), String> {
    let flag = toggle_flag(&kind, enabled).ok_or("kind must be skill or agent")?;
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let out = node_cmd(&app, &dir, &["agents".into(), flag.into(), name])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch agents failed")
            .to_string())
    }
}

/// The repo's always-allowed commands (`orch allow --json`), optionally removing one first (`--remove RULE`).
#[tauri::command(async)]
fn allowed_commands(app: AppHandle, repo: String, remove: Option<String>) -> Result<Value, String> {
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let mut args = vec!["allow".to_string(), "--json".to_string()];
    if let Some(rule) = remove.filter(|r| !r.is_empty()) {
        args.push("--remove".into());
        args.push(rule);
    }
    let out = node_cmd(&app, &dir, &args)?.output().map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch allow failed")
            .to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("could not read the allowed commands: {e}"))
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
    let key = key_of(Path::new(&repo));
    let dir = repo_of(&app, &key)?;
    let mut args = vec!["approve".to_string()];
    match (&reject, &plan) {
        (Some(r), _) => args.extend(["--reject".into(), r.chars().take(4000).collect()]),
        (None, Some(_)) => args.push("--plan-stdin".into()),
        _ => {}
    }
    if let Some(name) = group_name(&app, &key) {
        args.extend(["--group".into(), name]);
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

/// Agent M: allow, deny or always-allow a shell command an agent wants to run (`orch decide`, which checks the ID).
/// Agent M: gather the machine status in the background (`orch chat --warm`), one at a time, so the first
/// question is quick. Returns at once.
#[tauri::command]
fn agent_m_warm(app: AppHandle) {
    static WARMING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    use std::sync::atomic::Ordering;
    if WARMING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let run = || -> Result<(), String> {
            use std::io::Write;
            let repos: Vec<String> = {
                let st = app.state::<AppState>();
                let g = st.0.lock().unwrap();
                g.sessions.iter().filter(|s| s.group.is_none()).map(|s| s.repo.display().to_string()).collect()
            };
            let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let mut child = node_cmd(&app, &home, &["chat".into(), "--warm".into()])?
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(json!({ "repos": repos }).to_string().as_bytes());
            }
            child.wait().map_err(|e| e.to_string())?;
            Ok(())
        };
        let _ = run();
        WARMING.store(false, Ordering::SeqCst);
    });
}

/// Agent M chat: `orch chat` with the question and every open repo (it reads their status); its cost counts
/// toward the daily budget. Returns {answer, session, cost}.
#[tauri::command(async)]
fn agent_m_ask(app: AppHandle, question: String, session: Option<String>) -> Result<Value, String> {
    use std::io::Write;
    if question.trim().is_empty() || question.chars().count() > 4000 {
        return Err("question required (up to 4000 characters)".into());
    }
    if let Some(s) = &session {
        if s.is_empty() || s.len() > 100 || !s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err("invalid session".into());
        }
    }
    let (repos, running): (Vec<String>, Vec<String>) = {
        let st = app.state::<AppState>();
        let g = st.0.lock().unwrap();
        let repos = g.sessions.iter().filter(|s| s.group.is_none()).map(|s| s.repo.display().to_string()).collect();
        let running = g
            .sessions
            .iter()
            .filter(|s| s.group.is_none() && s.running.is_some())
            .map(|s| s.repo.display().to_string())
            .collect();
        (repos, running)
    };
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let input = json!({ "question": question, "session": session, "repos": repos, "running": running }).to_string();
    let mut child = node_cmd(&app, &home, &["chat".into()])?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("could not open orch stdin")?
        .write_all(input.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("Agent M failed")
            .to_string());
    }
    let reply: Value = String::from_utf8_lossy(&out.stdout)
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str(l.trim()).ok())
        .ok_or("Agent M returned no answer")?;
    add_spent(&app, reply["cost"].as_f64().unwrap_or(0.0));
    Ok(reply)
}

#[tauri::command(async)]
fn decide_command(app: AppHandle, repo: String, id: String, decision: String) -> Result<(), String> {
    if !["allow", "deny", "always", "prefix"].contains(&decision.as_str()) {
        return Err("decision must be allow, deny, always or prefix".into());
    }
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let out = node_cmd(&app, &dir, &["decide".into(), id, decision])?
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch decide failed")
            .to_string());
    }
    Ok(())
}

#[tauri::command(async)]
fn answer_question(app: AppHandle, repo: String, id: String, answer: String) -> Result<(), String> {
    use std::io::Write;
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let mut child = node_cmd(&app, &dir, &["answer".into(), id])?
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("could not open orch stdin")?
        .write_all(answer.as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr)
            .trim()
            .lines()
            .last()
            .unwrap_or("orch answer failed")
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
    let args = match group_name(&app, &key_of(Path::new(&repo))) {
        Some(name) => vec!["group".into(), "rollback".into(), name],
        None => vec!["rollback".into()],
    };
    request_start(&app, &repo, args, "rollback".into())
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
fn doctor(app: AppHandle, repo: String, pr: Option<bool>) -> Value {
    let fail = |detail: String| json!([{ "name": "orchestrator", "level": "fail", "detail": detail }]);
    let mut args = vec!["doctor".to_string(), "--json".to_string()];
    if pr == Some(true) {
        args.push("--pr".into());
    }
    let out = match repo_of(&app, &key_of(Path::new(&repo)))
        .and_then(|dir| node_cmd(&app, &dir, &args))
        .and_then(|mut c| c.output().map_err(|e| format!("{NODE_HINT}: {e}")))
    {
        Ok(o) => o,
        Err(e) => return fail(e),
    };
    // exit 1 just means a "fail" finding; the JSON is still on stdout
    serde_json::from_slice(&out.stdout).unwrap_or_else(|_| fail(String::from_utf8_lossy(&out.stderr).trim().to_string()))
}

#[tauri::command(async)]
fn browser_detect(app: AppHandle, repo: String) -> Result<Value, String> {
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    let out = node_cmd(&app, &dir, &["browser".into(), "detect".into()])?
        .output()
        .map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("invalid browser detection result: {e}"))
}

#[tauri::command(async)]
fn browser_configure(app: AppHandle, repo: String, action: String, id: Option<String>) -> Result<(), String> {
    let dir = repo_of(&app, &key_of(Path::new(&repo)))?;
    if action == "login" {
        return request_start(&app, &repo, vec!["browser".into(), "login".into()], "browser login".into());
    }
    if action != "enable" && action != "disable" {
        return Err("invalid browser action".into());
    }
    let mut args = vec!["browser".into(), action.clone()];
    if action == "enable" {
        let value = id.ok_or("app selection required")?;
        if value != "manual" && (value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())) {
            return Err("invalid app selection".into());
        }
        args.push(value);
    }
    let out = node_cmd(&app, &dir, &args)?.output().map_err(|e| format!("{NODE_HINT}: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
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
    let (pid, cancelled, group_run) = {
        let mut g = state.0.lock().unwrap();
        match g.find(&key) {
            Some(i) => {
                let cancelled = g.sessions[i].pending.take().is_some();
                let s = &g.sessions[i];
                let group_run = s.group.as_ref().filter(|_| s.running.as_ref().is_some_and(|r| r.label.starts_with("group:")));
                (
                    s.running.as_ref().map(|r| r.pid),
                    cancelled,
                    group_run.and_then(|c| c["name"].as_str().map(str::to_string)),
                )
            }
            None => (None, false, None),
        }
    };
    if cancelled {
        push_line(&app, &key, "-- start cancelled --".into());
        emit_session(&app, &key);
    }
    let Some(pid) = pid else { return };
    if let Some(name) = group_run {
        // The group parks both repos when asked through `orch group stop`; killing its tree would leave them unparked.
        // Only when the ask fails (it has not taken its locks yet, or orch cannot start) is the tree killed.
        push_line(&app, &key, "-- stopping: the group parks both repos' work --".into());
        std::thread::spawn(move || {
            if orch_home(&app, &["group".into(), "stop".into(), name]).is_err() {
                let same = {
                    let st = app.state::<AppState>();
                    let g = st.0.lock().unwrap();
                    g.find(&key).is_some_and(|i| g.sessions[i].running.as_ref().is_some_and(|r| r.pid == pid))
                };
                if same {
                    kill_tree(pid);
                }
            }
        });
        return;
    }
    kill_tree(pid);
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
        if !d.is_empty() && !dirs.contains(&d) && (from_shell.split(':').any(|s| s == d) || current.split(':').any(|c| c == d) || Path::new(&d).is_dir()) {
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
            // The repo groups (one node call): in the background, so the window opens at once.
            let groups = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = sync_groups(&groups) {
                    eprintln!("could not list repo groups: {e}");
                }
            });
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
            move_goal,
            intake_goals,
            agents,
            history,
            visual_image,
            save_agent,
            swap_agent,
            toggle_roster,
            allowed_commands,
            stop,
            clear_log,
            rollback,
            learn_repo,
            share_repo,
            approve_plan,
            answer_question,
            decide_command,
            agent_m_ask,
            agent_m_warm,
            save_group,
            remove_group,
            split_brief,
            accept_split,
            stop_after,
            doctor,
            browser_detect,
            browser_configure,
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
    fn group_sessions_mark_their_members_busy() {
        let cfg =
            json!({ "name": "shop", "dir": "/h/groups/shop", "repos": [{ "path": "/w/api", "role": "backend" }, { "path": "/w/web", "role": "frontend" }] });
        let mut g = Inner::default();
        add_session(&mut g, &std::env::temp_dir()).unwrap();
        g.sessions[0].repo = PathBuf::from("/w/api");
        apply_groups(&mut g, std::slice::from_ref(&cfg));
        assert_eq!(g.sessions.len(), 2, "one session per group, keyed by its dir");
        let gi = g.find(&key_of(Path::new("/h/groups/shop"))).unwrap();
        assert_eq!(g.members_of(gi), vec![key_of(Path::new("/w/api"))], "only open members");
        assert_eq!(g.busy_group_of(Path::new("/w/api")), None, "an idle group marks nothing");
        g.sessions[gi].pending = Some((vec!["group".into()], "group: x".into()));
        assert_eq!(g.busy_group_of(Path::new("/w/api")).as_deref(), Some("shop"));
        let v = session_value(&g, &g.sessions[0], None);
        assert_eq!(v["inGroup"], "shop");
        assert_eq!(session_value(&g, &g.sessions[gi], None)["group"]["name"], "shop");
        apply_groups(&mut g, &[]);
        assert_eq!(g.sessions.len(), 2, "a removed group's session stays while it runs or waits");
        g.sessions[gi].pending = None;
        apply_groups(&mut g, &[]);
        assert_eq!(g.sessions.len(), 1, "and goes once idle");
    }

    #[test]
    fn toggle_flags() {
        assert_eq!(toggle_flag("skill", false), Some("--disable-skill"));
        assert_eq!(toggle_flag("skill", true), Some("--enable-skill"));
        assert_eq!(toggle_flag("agent", false), Some("--disable-agent"));
        assert_eq!(toggle_flag("agent", true), Some("--enable-agent"));
        assert_eq!(toggle_flag("plugin", true), None);
    }

    #[test]
    fn group_form_becomes_group_add_args() {
        let mut env = serde_json::Map::new();
        env.insert("API_URL".into(), json!("{backend}"));
        let abs = |p: &str| if cfg!(windows) { format!("C:{p}") } else { p.to_string() };
        let args = group_add_args(
            "shop",
            &abs("/w/api"),
            &abs("/w/web"),
            Some("http://localhost:3999"),
            Some(" node s.js "),
            None,
            &env,
        )
        .unwrap();
        assert_eq!(
            args,
            [
                "group".to_string(),
                "add".into(),
                "shop".into(),
                "--repo".into(),
                format!("{}:backend", abs("/w/api")),
                "--repo".into(),
                format!("{}:frontend", abs("/w/web")),
                "--serve-url".into(),
                "http://localhost:3999".into(),
                "--serve-command".into(),
                "node s.js".into(),
                "--env".into(),
                "API_URL={backend}".into()
            ]
        );
        assert!(group_add_args("Shop", &abs("/a"), &abs("/b"), None, None, None, &env).is_err());
        assert!(group_add_args("shop", "rel", &abs("/b"), None, None, None, &env).is_err());
        env.insert("lower".into(), json!("x"));
        assert!(group_add_args("shop", &abs("/a"), &abs("/b"), None, None, None, &env).is_err());
    }

    #[test]
    fn routes_group_events_only_to_idle_member_sessions() {
        let session = |repo: &str| Session {
            repo: PathBuf::from(repo),
            group: None,
            running: None,
            pending: None,
            log: Vec::new(),
            events: Vec::new(),
        };
        let mut g = Inner {
            sessions: vec![session("/g/group"), session("/g/member")],
            ..Inner::default()
        };
        let (group, member) = (key_of(Path::new("/g/group")), key_of(Path::new("/g/member")));
        assert!(routes_to(&g, &group, &member), "an idle member session gets it");
        assert!(!routes_to(&g, &group, &group), "the group's own session keeps it");
        assert!(!routes_to(&g, &group, &key_of(Path::new("/g/not-open"))), "no session: it stays with the group");
        g.sessions[1].running = Some(Running {
            pid: 1,
            label: "run".into(),
            started_at: 0,
        });
        assert!(!routes_to(&g, &group, &member), "a member with its own live run keeps it apart");
        g.sessions[1].running = None;
        g.sessions[1].pending = Some((vec!["run".into()], "run".into()));
        assert!(!routes_to(&g, &group, &member), "a member with a start waiting keeps it apart");
    }

    #[test]
    fn unwraps_group_child_events() {
        let wrapped = json!({ "type": "group_child", "repo": "C:/Work/Api", "role": "backend", "event": { "type": "task_end", "cost": 0.5 } });
        let (repo, inner) = unwrap_group_event(&wrapped);
        assert_eq!(repo.as_deref(), Some("C:/Work/Api"));
        assert_eq!(inner, &json!({ "type": "task_end", "cost": 0.5 }));
        let bare = json!({ "type": "task_end", "cost": 0.5 });
        let (repo, same) = unwrap_group_event(&bare);
        assert_eq!(repo, None);
        assert_eq!(same, &bare);
        // Without an event (or one without a type) it stays as it is.
        let broken = json!({ "type": "group_child", "repo": "C:/Work/Api" });
        assert_eq!(unwrap_group_event(&broken), (None, &broken));
        let untyped = json!({ "type": "group_child", "repo": "C:/Work/Api", "event": { "cost": 1 } });
        assert_eq!(unwrap_group_event(&untyped), (None, &untyped));
        // The member's key matches the session's whatever the slashes, and the case on Windows.
        if cfg!(windows) {
            assert_eq!(key_of(Path::new("c:/work/API/")), key_of(Path::new(r"C:\Work\Api")));
        } else {
            assert_eq!(key_of(Path::new("/work/Api/")), key_of(Path::new("/work/Api")));
        }
    }

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
        assert_eq!(
            with_budget(v(&["group", "run", "shop", "--max-cost", "5", "--power", "heavy", "goal"]), Some(2.0), "5h=80"),
            v(&["group", "run", "shop", "--power", "heavy", "--max-cost", "2.00", "goal"]),
            "a group run gets the budget left before its goal, and no usage caps"
        );
        assert_eq!(
            with_budget(v(&["group", "run", "shop", "goal"]), None, "5h=80"),
            v(&["group", "run", "shop", "goal"])
        );
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
    fn question_flags() {
        let flags_for = |ask| flags("heavy", 1, false, &Extra { ask, ..Default::default() })[4..].to_vec();
        assert_eq!(flags_for(Some(true)), ["--ask"]);
        assert_eq!(flags_for(Some(false)), ["--no-ask"]);
        assert!(flags_for(None).is_empty());
        let commands_for = |commands| {
            flags(
                "heavy",
                1,
                false,
                &Extra {
                    commands,
                    ..Default::default()
                },
            )[4..]
                .to_vec()
        };
        assert_eq!(commands_for(Some(true)), ["--commands"]);
        assert_eq!(commands_for(Some(false)), ["--no-commands"]);
        assert!(commands_for(None).is_empty());
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
            assert!(session_value(&g, s, None)["queue"].is_array());
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
