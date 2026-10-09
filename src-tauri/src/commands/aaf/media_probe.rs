//! Linked media checked in a child process, never in the app's own.
//!
//! Every playback window, waveform and transcription first confirms that the
//! MXF it is about to read is the file its binding names: a stat, and two
//! 64 KiB reads when the stat has moved (`store::source_fingerprint`). That
//! used to run on the app's own threads. On 2026-10-05 a NEXIS workspace
//! stopped answering mid-read, and a thread that is waiting on a volume that
//! never replies sits in an uninterruptible kernel wait: Force Quit could not
//! end the process, and macOS handed every later launch to the dying one, so
//! the app "would not open" until the Mac was restarted.
//!
//! A child that hangs is the child's problem. It is given `LIMIT` to answer;
//! past that the request fails with words that name the volume, the child is
//! abandoned (it ends when the volume answers), and the app keeps drawing,
//! quits when asked and opens again. The child is this same executable run as
//! `sauce-bunny --probe-media`, so it fingerprints with exactly the code a
//! relink used to record the binding.
//!
//! The memo the in-process check kept is kept here, on the app's side: a stat
//! that has not moved returns the remembered fingerprint without reading, and
//! a file verified moments ago is not asked about again (`RECHECK`), which is
//! what keeps one child per five-second window per mic from becoming the cost.
use super::{process, store};
use crate::AppError;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, io::{BufRead, Write}, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

/// One file a read is about to use, and the fingerprint its binding promises.
#[derive(Debug, Clone, PartialEq)]
pub struct Expect { pub path: PathBuf, pub fingerprint: String }

/// How long the child gets for one batch. A cold NEXIS stat plus two reads
/// measured 2 s; ten times that is a volume that is not coming back soon.
const LIMIT: Duration = Duration::from_secs(20);
/// A file verified this recently is not asked about again.
const RECHECK: Duration = Duration::from_secs(15);
/// Past this the memo starts again (about 250 bytes an entry).
const KEPT: usize = 16_384;

pub const NOT_ANSWERING: &str = "The drive holding this audio is not answering (NEXIS or another network volume). Sauce Bunny stopped waiting so the app stays responsive. Try again once the drive is back.";
const CHANGED: &str = "Linked media changed. Locate media again before processing.";
const OFFLINE: &str = "Audio is offline. Locate media first.";

#[derive(Serialize, Deserialize)]
struct Ask { path: String, known: Option<store::Stamp> }

#[derive(Serialize, Deserialize, Debug)]
struct Answer {
    path: String,
    #[serde(default)] stamp: Option<store::Stamp>,
    /// Absent when the stat matched `known`: nothing was read.
    #[serde(default)] fingerprint: Option<String>,
    /// The file is not there (unmounted, renamed, deleted).
    #[serde(default)] missing: bool,
    #[serde(default)] error: Option<String>,
}

struct Known { stamp: store::Stamp, fingerprint: String, checked: Instant }
static MEMO: Mutex<Option<HashMap<PathBuf, Known>>> = Mutex::new(None);

/// Confirm every file is the one its binding names, from a child process.
pub async fn verify(app: &AppHandle, job: &str, expect: Vec<Expect>) -> Result<(), AppError> {
    let asks = pending(&expect, Instant::now());
    if asks.is_empty() { return Ok(()); }
    let answers = process::until_cancelled(app, job, ask_child(child()?, &asks, LIMIT)).await??;
    settle(&expect, answers, Instant::now())
}

/// What still needs asking: files not verified within `RECHECK`, each with
/// the stat the memo last saw so an unmoved file is not read again.
fn pending(expect: &[Expect], now: Instant) -> Vec<Ask> {
    let memo = MEMO.lock().ok();
    let known = |path: &Path| memo.as_ref().and_then(|memo| memo.as_ref()).and_then(|memo| memo.get(path));
    let mut asks: Vec<Ask> = Vec::new();
    for item in expect {
        let seen = known(&item.path);
        if seen.is_some_and(|seen| seen.fingerprint == item.fingerprint && now.duration_since(seen.checked) < RECHECK) { continue; }
        let path = item.path.to_string_lossy().into_owned();
        if asks.iter().any(|ask| ask.path == path) { continue; }
        asks.push(Ask { path, known: seen.map(|seen| seen.stamp) });
    }
    asks
}

/// Fold the child's answers into the memo and judge them against the bindings.
fn settle(expect: &[Expect], answers: Vec<Answer>, now: Instant) -> Result<(), AppError> {
    let mut memo = MEMO.lock().map_err(|_| AppError::internal("Media check is unavailable"))?;
    let memo = memo.get_or_insert_with(HashMap::new);
    for answer in answers {
        let path = PathBuf::from(&answer.path);
        if answer.missing { return Err(AppError::not_found(OFFLINE)); }
        if let Some(error) = answer.error { return Err(AppError::internal(format!("Could not read {}: {error}", answer.path))); }
        let stamp = answer.stamp.ok_or_else(|| AppError::internal("Media check answered without a stat"))?;
        let fingerprint = match answer.fingerprint {
            Some(value) => value,
            // Unmoved since the memo's stat: the memo's fingerprint stands.
            None => memo.get(&path).filter(|seen| seen.stamp == stamp).map(|seen| seen.fingerprint.clone())
                .ok_or_else(|| AppError::internal("Media check skipped a file it had not seen"))?,
        };
        if memo.len() >= KEPT { memo.clear(); }
        memo.insert(path, Known { stamp, fingerprint, checked: now });
    }
    for item in expect {
        match memo.get(&item.path) {
            Some(seen) if seen.fingerprint == item.fingerprint => {}
            Some(_) => return Err(AppError::invalid(CHANGED)),
            None => return Err(AppError::internal("Media check did not answer for every file")),
        }
    }
    Ok(())
}

/// This executable, as the probe. Never a shell: paths go over stdin.
fn child() -> Result<tokio::process::Command, AppError> {
    let exe = std::env::current_exe().map_err(|e| AppError::internal(format!("Cannot find the app to check media with: {e}")))?;
    let mut command = tokio::process::Command::new(exe);
    command.arg("--probe-media");
    Ok(command)
}

/// Run one batch through a child, giving it `limit` to finish. On the limit
/// the child is killed if it can be and left behind if it cannot (a wait on a
/// dead volume ends only when the volume answers); either way the app moves on.
async fn ask_child(mut command: tokio::process::Command, asks: &[Ask], limit: Duration) -> Result<Vec<Answer>, AppError> {
    let mut input = Vec::new();
    for ask in asks { serde_json::to_writer(&mut input, ask)?; input.push(b'\n'); }
    command.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| AppError::internal(format!("Cannot start the media check: {e}")))?;
    let mut stdin = child.stdin.take().ok_or_else(|| AppError::internal("Media check has no input"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::internal("Media check has no output"))?;
    let exchange = async move {
        stdin.write_all(&input).await?;
        drop(stdin);
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let mut answers = Vec::new();
        while let Some(line) = lines.next_line().await? {
            if line.trim().is_empty() { continue; }
            answers.push(serde_json::from_str::<Answer>(&line)?);
        }
        Ok::<_, AppError>(answers)
    };
    match tokio::time::timeout(limit, exchange).await {
        Ok(answers) => { let _ = child.wait().await; answers }
        Err(_) => { let _ = child.start_kill(); Err(AppError::invalid(NOT_ANSWERING)) }
    }
}

/// The child's side: one JSON question per line in, one answer per line out.
pub fn serve(input: impl BufRead, mut output: impl Write) -> i32 {
    for line in input.lines() {
        let Ok(line) = line else { return 1 };
        if line.trim().is_empty() { continue; }
        let answer = match serde_json::from_str::<Ask>(&line) {
            Ok(ask) => answer(&ask),
            Err(error) => Answer { path: String::new(), stamp: None, fingerprint: None, missing: false, error: Some(error.to_string()) },
        };
        if serde_json::to_writer(&mut output, &answer).is_err() || output.write_all(b"\n").is_err() || output.flush().is_err() { return 1; }
    }
    0
}

fn answer(ask: &Ask) -> Answer {
    let path = Path::new(&ask.path);
    let failed = |error: std::io::Error| Answer { path: ask.path.clone(), stamp: None, fingerprint: None,
        missing: error.kind() == std::io::ErrorKind::NotFound, error: (error.kind() != std::io::ErrorKind::NotFound).then(|| error.to_string()) };
    let metadata = match std::fs::metadata(path) { Ok(metadata) => metadata, Err(error) => return failed(error) };
    let stamp = store::stamp(&metadata);
    if ask.known == Some(stamp) { return Answer { path: ask.path.clone(), stamp: Some(stamp), fingerprint: None, missing: false, error: None }; }
    match store::source_fingerprint(path) {
        Ok(value) => Answer { path: ask.path.clone(), stamp: Some(stamp), fingerprint: Some(value), missing: false, error: None },
        Err(error) => Answer { path: ask.path.clone(), stamp: Some(stamp), fingerprint: None, missing: false, error: Some(error.to_string()) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(bytes: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("media-probe-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    fn served(asks: &[Ask]) -> Vec<Answer> {
        let mut input = Vec::new();
        for ask in asks { serde_json::to_writer(&mut input, ask).unwrap(); input.push(b'\n'); }
        let mut output = Vec::new();
        assert_eq!(serve(&input[..], &mut output), 0);
        String::from_utf8(output).unwrap().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
    }

    #[test]
    fn the_child_fingerprints_exactly_as_a_relink_recorded() {
        let path = temp(b"first recording");
        let answers = served(&[Ask { path: path.to_string_lossy().into_owned(), known: None }]);
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].fingerprint.as_deref(), Some(store::source_fingerprint(&path).unwrap().as_str()));
        // Told the stat it already knows, it answers without reading.
        let stamp = answers[0].stamp;
        let again = served(&[Ask { path: path.to_string_lossy().into_owned(), known: stamp }]);
        assert_eq!(again[0].stamp, stamp);
        assert!(again[0].fingerprint.is_none(), "an unmoved file was read again");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_missing_file_is_offline_and_a_changed_one_is_changed() {
        let path = temp(b"first recording");
        let expect = vec![Expect { path: path.clone(), fingerprint: store::source_fingerprint(&path).unwrap() }];
        let now = Instant::now();
        let asks = pending(&expect, now);
        assert_eq!(asks.len(), 1);
        assert!(settle(&expect, served(&asks), now).is_ok());
        // Verified moments ago: not asked again.
        assert!(pending(&expect, now + Duration::from_secs(1)).is_empty());
        // Rewritten (same size): after the recheck window it reads as changed.
        std::fs::write(&path, b"other recording").unwrap();
        let later = now + RECHECK + Duration::from_secs(1);
        let asks = pending(&expect, later);
        assert!(matches!(settle(&expect, served(&asks), later), Err(AppError::Invalid(message)) if message == CHANGED));
        // Gone: offline, not changed.
        std::fs::remove_file(&path).unwrap();
        let asks = pending(&expect, later);
        assert!(matches!(settle(&expect, served(&asks), later), Err(AppError::NotFound(message)) if message == OFFLINE));
    }

    /// The point of the module: a child that never answers costs the app
    /// `limit`, not the app.
    #[tokio::test]
    async fn a_child_that_never_answers_is_abandoned_at_the_limit() {
        let mut command = tokio::process::Command::new("/bin/sleep");
        command.arg("30");
        let asks = [Ask { path: "/Volumes/Gone/a.mxf".into(), known: None }];
        let started = Instant::now();
        let result = ask_child(command, &asks, Duration::from_millis(300)).await;
        assert!(started.elapsed() < Duration::from_secs(5), "waited {:?} on a child past its limit", started.elapsed());
        assert!(matches!(result, Err(AppError::Invalid(message)) if message == NOT_ANSWERING));
    }
}
