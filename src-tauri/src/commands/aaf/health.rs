//! The app's health, as the Pipeline sees it.
//!
//! Two things go quiet when the app hangs, and neither can say so itself: the
//! app's MAIN thread (it draws the window and carries every call the page
//! makes), and the page's own JavaScript. A watchdog thread checks both and
//! writes what it finds into the pipeline journal (`diagnostics.rs`). That
//! journal is on disk, so a hang that ends in Force Quit is still in the
//! Pipeline on the next launch, with the time it started and how long it ran.
//!
//! When the main thread has been silent for a few seconds the watchdog also
//! asks macOS's `sample` for every thread's stack, once per hang, so the log
//! says what it was stuck ON. A signed build may refuse that (the hardened
//! runtime), and the row says so; Activity Monitor ▸ Sample Process still can.
use super::diagnostics;
use crate::AppError;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// How often the watchdog looks.
const TICK: Duration = Duration::from_millis(500);
/// A tick this late means the whole process was held (App Nap, a debugger),
/// not one thread: the waits it measured are not hangs.
const HELD: Duration = Duration::from_secs(3);
/// The page beats once a second; this much past a beat before it counts as silent.
const PAGE_GRACE: Duration = Duration::from_secs(1);
/// How long the main thread is silent before its stacks are recorded.
const SAMPLE_AFTER: Duration = Duration::from_secs(5);
/// Hang samples kept in the log folder; older ones are removed.
const SAMPLES_KEPT: usize = 5;

static STARTED: Mutex<Option<Instant>> = Mutex::new(None);
static MAIN_WAIT_MS: AtomicU64 = AtomicU64::new(0);
static BEAT: Mutex<Option<Beat>> = Mutex::new(None);

#[derive(Clone)]
struct Beat { at: Instant, page: String, visible: bool }

/// When a wait earns a row: 2 s, 10 s, 30 s, a minute, then every minute.
fn milestone(reported: u32) -> Duration {
    Duration::from_secs(match reported { 0 => 2, 1 => 10, 2 => 30, n => 60 * u64::from(n - 2) })
}

/// One thing the watchdog waits on, and how much of its silence it has reported.
#[derive(Default)]
struct Wait { reported: u32, longest: Duration }

impl Wait {
    /// Silent for `silent`: true when that crosses the next milestone, which is then reported.
    fn overdue(&mut self, silent: Duration) -> bool {
        self.longest = self.longest.max(silent);
        if silent < milestone(self.reported) { return false; }
        self.reported += 1;
        true
    }
    /// It answered. The length of the reported silence it ends, if there was one.
    fn answered(&mut self) -> Option<Duration> {
        let ended = (self.reported > 0).then_some(self.longest);
        *self = Self::default();
        ended
    }
}

pub(super) fn seconds(duration: Duration) -> String {
    let s = duration.as_secs_f64();
    if s < 10.0 { format!("{s:.1} s") } else if s < 120.0 { format!("{s:.0} s") } else { format!("{:.1} min", s / 60.0) }
}

fn running_jobs(app: &AppHandle) -> Vec<String> {
    app.try_state::<crate::commands::JobRegistry>().map(|jobs| jobs.running()).unwrap_or_default()
}

/// Starts the watchdog. Called once, from setup.
pub fn start_pipeline_watchdog(app: AppHandle) {
    if let Ok(mut started) = STARTED.lock() { started.get_or_insert_with(Instant::now); }
    let spawned = std::thread::Builder::new().name("pipeline-watchdog".into()).spawn(move || watch(app));
    if let Err(error) = spawned { eprintln!("pipeline watchdog did not start: {error}"); }
}

fn watch(app: AppHandle) {
    let answered = Arc::new(AtomicBool::new(true));
    let mut asked = Instant::now();
    let (mut main, mut page) = (Wait::default(), Wait::default());
    let mut sampled = false;
    let mut last = Instant::now();
    loop {
        std::thread::sleep(TICK);
        let held = last.elapsed() > HELD;
        last = Instant::now();
        if held {
            // Nothing was measured fairly while the process itself was held.
            main = Wait::default(); page = Wait::default();
            asked = Instant::now();
            continue;
        }

        if answered.swap(false, Ordering::AcqRel) {
            if let Some(silence) = main.answered() {
                diagnostics::log(&app, "", "ok", "health", &format!("The app's main thread answered again after {}.", seconds(silence)));
            }
            MAIN_WAIT_MS.store(0, Ordering::Relaxed);
            sampled = false;
            asked = Instant::now();
            let flag = answered.clone();
            // Fails only once the event loop has ended: the app is quitting.
            if app.run_on_main_thread(move || flag.store(true, Ordering::Release)).is_err() { return; }
        } else {
            let silent = asked.elapsed();
            MAIN_WAIT_MS.store(silent.as_millis() as u64, Ordering::Relaxed);
            if main.overdue(silent) {
                let jobs = running_jobs(&app);
                diagnostics::log(&app, "", "warn", "health", &format!(
                    "The app's main thread has not answered for {}: the window cannot draw or take a click until it does.{}",
                    seconds(silent), if jobs.is_empty() { String::new() } else { format!(" Running: {}.", jobs.join(", ")) }));
            }
            if !sampled && silent >= SAMPLE_AFTER { sampled = true; sample(app.clone()); }
        }

        let beat = BEAT.lock().ok().and_then(|beat| beat.clone());
        match beat {
            Some(beat) if beat.visible => {
                let silent = beat.at.elapsed().saturating_sub(PAGE_GRACE);
                if silent.is_zero() {
                    if let Some(silence) = page.answered() {
                        diagnostics::log(&app, "", "ok", "health", &format!("{} answered again after {}.", beat.page, seconds(silence + PAGE_GRACE)));
                    }
                } else if page.overdue(silent) {
                    let also = if main.reported > 0 { " The main thread is not answering either, and the page waits on it." } else { "" };
                    diagnostics::log(&app, "", "warn", "health", &format!("{} has not answered for {}.{also}", beat.page, seconds(silent + PAGE_GRACE)));
                }
            }
            // Hidden, or no page watching: nothing to expect.
            _ => page = Wait::default(),
        }
    }
}

/// Records every thread's stack with macOS's `sample`, on its own thread so
/// the watchdog keeps watching.
fn sample(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("pipeline-sample".into()).spawn(move || {
        let Ok(dir) = app.path().app_log_dir() else { return };
        if std::fs::create_dir_all(&dir).is_err() { return; }
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |time| time.as_millis());
        let file = dir.join(format!("hang-{stamp}.txt"));
        let result = std::process::Command::new("/usr/bin/sample")
            .args([std::process::id().to_string().as_str(), "2", "-mayDie", "-file"]).arg(&file).output();
        match result {
            Ok(output) if output.status.success() && file.is_file() => diagnostics::log(&app, "", "info", "health",
                &format!("Recorded what every thread was doing: {}. Export diagnostics includes the main thread's part.", file.display())),
            Ok(output) => diagnostics::log(&app, "", "info", "health", &format!(
                "Could not record the stacks ({}). Activity Monitor ▸ Sauce Bunny ▸ Sample Process can.",
                String::from_utf8_lossy(&output.stderr).lines().find(|line| !line.trim().is_empty()).unwrap_or("sample failed").trim())),
            Err(error) => diagnostics::log(&app, "", "info", "health", &format!("Could not run sample: {error}.")),
        }
        prune(&dir);
    });
    if let Err(error) = spawned { eprintln!("pipeline sample did not start: {error}"); }
}

fn hang_samples(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found: Vec<_> = std::fs::read_dir(dir).into_iter().flatten().flatten().map(|entry| entry.path())
        .filter(|path| path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.starts_with("hang-") && name.ends_with(".txt")))
        .collect();
    // hang-<unix ms>.txt: the name sorts by time.
    found.sort();
    found.reverse();
    found
}

fn prune(dir: &std::path::Path) {
    for old in hang_samples(dir).into_iter().skip(SAMPLES_KEPT) { let _ = std::fs::remove_file(old); }
}

/// The main thread's part of a `sample` report: the first thread of the call
/// graph, which is the main thread, capped so a report stays readable.
fn main_thread_part(report: &str) -> String {
    let Some(start) = report.find("Call graph:") else { return report.lines().take(60).collect::<Vec<_>>().join("\n") };
    let header = |line: &str| line.split_whitespace().nth(1).is_some_and(|word| word.starts_with("Thread_"));
    let (mut lines, mut in_thread) = (Vec::new(), false);
    for line in report[start..].lines() {
        // The second thread header ends the main thread's block.
        if header(line) { if in_thread { break; } in_thread = true; }
        lines.push(line);
        if lines.len() >= 300 { lines.push("    … (cut at 300 lines; the whole report is in the file)"); break; }
    }
    lines.join("\n")
}

/// The page says it is alive, and whether it can be seen (a hidden page's
/// timers are throttled, so its silence means nothing).
#[tauri::command]
pub async fn pipeline_heartbeat(page: String, visible: bool) -> Result<(), AppError> {
    let page: String = page.chars().filter(|c| !c.is_control()).take(40).collect();
    if let Ok(mut beat) = BEAT.lock() { *beat = Some(Beat { at: Instant::now(), page, visible }); }
    Ok(())
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PipelineHealth {
    /// The app process's resident memory, when macOS reports it.
    #[ts(type = "number | null")]
    pub resident_bytes: Option<u64>,
    #[ts(type = "number")]
    pub uptime_seconds: u64,
    /// Job ids with a sidecar process registered right now.
    pub running_jobs: Vec<String>,
    /// How long the main thread has gone without answering the watchdog; 0 while it answers.
    #[ts(type = "number")]
    pub main_thread_wait_ms: u64,
    /// Mounted volumes other than the startup disk: where, what kind, local or network.
    pub volumes: Vec<String>,
    /// The newest hang sample's file and its main-thread part, if one was recorded.
    pub latest_hang: Option<String>,
    /// The co-review session: off, hosting or joined. Its UDP sockets and relay
    /// connection exist only while one is open (session.rs), so this says
    /// whose they are when Activity Monitor shows them.
    pub co_review: String,
}

#[cfg(target_os = "macos")]
fn resident_bytes() -> Option<u64> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    // SAFETY: proc_pidinfo writes at most `size` bytes into `info`, which is that size.
    let wrote = unsafe { libc::proc_pidinfo(std::process::id() as libc::c_int, libc::PROC_PIDTASKINFO, 0, (&mut info as *mut libc::proc_taskinfo).cast(), size) };
    (wrote == size).then_some(info.pti_resident_size)
}
#[cfg(not(target_os = "macos"))]
fn resident_bytes() -> Option<u64> { None }

/// A mount's source with any `user@` taken out (an SMB URL carries the account).
fn without_account(from: &str) -> String {
    match (from.find("//"), from.find('@')) {
        (Some(slashes), Some(at)) if at > slashes && !from[slashes + 2..at].contains('/') => format!("{}//[account]@{}", &from[..slashes], &from[at + 1..]),
        _ => from.to_string(),
    }
}

/// Every mount but the system's own. MNT_NOWAIT, so a stalled network volume
/// answers from the kernel's cache instead of holding this up.
#[cfg(target_os = "macos")]
fn volumes() -> Vec<String> {
    let mut mounts: *mut libc::statfs = std::ptr::null_mut();
    // SAFETY: getmntinfo points `mounts` at a buffer it owns, holding `count` entries.
    let count = unsafe { libc::getmntinfo(&mut mounts, libc::MNT_NOWAIT) };
    if count <= 0 || mounts.is_null() { return Vec::new(); }
    // SAFETY: as above; the buffer stays valid until the next getmntinfo on this thread.
    let mounts = unsafe { std::slice::from_raw_parts(mounts, count as usize) };
    let text = |chars: &[libc::c_char]| unsafe { std::ffi::CStr::from_ptr(chars.as_ptr()) }.to_string_lossy().into_owned();
    mounts.iter().filter_map(|mount| {
        let on = text(&mount.f_mntonname);
        let kind = text(&mount.f_fstypename);
        let local = mount.f_flags & libc::MNT_LOCAL as u32 != 0;
        let system = on == "/" || on.starts_with("/System/") || on.starts_with("/private/var/") || matches!(kind.as_str(), "devfs" | "autofs" | "nullfs");
        (!system).then(|| format!("{on} · {kind} · {} · from {}", if local { "local" } else { "network" }, without_account(&text(&mount.f_mntfromname))))
    }).collect()
}
#[cfg(not(target_os = "macos"))]
fn volumes() -> Vec<String> { Vec::new() }

#[tauri::command]
pub async fn pipeline_health(app: AppHandle) -> Result<PipelineHealth, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let latest_hang = app.path().app_log_dir().ok().and_then(|dir| hang_samples(&dir).into_iter().next()).and_then(|file| {
            let text = std::fs::read(&file).ok()?;
            let text = String::from_utf8_lossy(&text[..text.len().min(4 * 1024 * 1024)]).into_owned();
            Some(format!("{}\n{}", file.display(), main_thread_part(&text)))
        });
        let uptime_seconds = STARTED.lock().ok().and_then(|started| *started).map_or(0, |started| started.elapsed().as_secs());
        PipelineHealth { resident_bytes: resident_bytes(), uptime_seconds, running_jobs: running_jobs(&app),
            main_thread_wait_ms: MAIN_WAIT_MS.load(Ordering::Relaxed), volumes: volumes(), latest_hang,
            co_review: app.try_state::<crate::commands::SessionManager>().map_or("unknown", |session| session.role_now()).to_string() }
    }).await.map_err(|e| AppError::internal(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wait_is_reported_at_two_ten_thirty_sixty_seconds_then_every_minute() {
        let mut wait = Wait::default();
        let reported: Vec<u64> = (0..=300).filter(|s| wait.overdue(Duration::from_secs(*s))).collect();
        assert_eq!(reported, [2, 10, 30, 60, 120, 180, 240, 300]);
        assert_eq!(wait.answered(), Some(Duration::from_secs(300)));
        assert_eq!(wait.answered(), None, "an answered wait reported its end twice");
        let mut short = Wait::default();
        assert!(!short.overdue(Duration::from_millis(1900)));
        assert_eq!(short.answered(), None, "a silence too short to report announced its end");
    }

    #[test]
    fn the_main_threads_block_is_cut_from_a_sample_report() {
        let report = "Process: sauce-bunny\nCall graph:\n    2001 Thread_1   DispatchQueue_1: com.apple.main-thread  (serial)\n      2001 start\n        2001 read  (in libsystem_kernel.dylib)\n    2001 Thread_2\n      2001 tokio\n";
        let part = main_thread_part(report);
        assert!(part.contains("com.apple.main-thread") && part.contains("read  (in libsystem_kernel.dylib)"));
        assert!(!part.contains("tokio"), "another thread's stack leaked into the main thread's part: {part}");
    }

    #[test]
    fn a_network_mounts_account_is_left_out() {
        assert_eq!(without_account("//editor@nexis.local/Media"), "//[account]@nexis.local/Media");
        assert_eq!(without_account("/dev/disk4s1"), "/dev/disk4s1");
        assert_eq!(without_account("//nexis.local/Media@2"), "//nexis.local/Media@2");
    }

    #[test]
    fn durations_read_as_people_say_them() {
        assert_eq!(seconds(Duration::from_millis(2_400)), "2.4 s");
        assert_eq!(seconds(Duration::from_secs(45)), "45 s");
        assert_eq!(seconds(Duration::from_secs(150)), "2.5 min");
    }
}
