//! Recording a review session to a file, natively.
//!
//! WHY NONE OF THIS RUNS IN THE WEBVIEW. The obvious build is
//! `MediaRecorder` over the session's own MediaStream, and it is wrong here
//! for reasons that are facts about this repo rather than platform guesses:
//!
//!   - The session's audio track is not a microphone. `media-devices.ts`
//!     builds mic -> GainNode -> createMediaStreamDestination, and mute is
//!     `gained.enabled = false`, so recording that stream records literal
//!     SILENCE for as long as you are muted. The app has been bitten by this
//!     once already (see AvSettingsPane's mic check).
//!   - That same track is what `replaceTrack` feeds the mesh, capped at
//!     1280x720. Recording it means recording the transport's compromise;
//!     raising the constraint changes what the far side sees.
//!   - There is no incremental write to disk. Both byte-writing commands are
//!     whole-buffer one-shots, and a whole buffer is capped at 4 GiB
//!     (`export-capacity.ts`) against a take that is 8 GB an hour.
//!   - A take would live in the WKWebView content process for its entire
//!     length, and that process can be reloaded or jetsammed by the OS. A
//!     recording that cannot be repeated should not live in the most
//!     disposable process on the machine.
//!
//! So: ScreenCaptureKit for pixels and system audio, bundled ffmpeg for the
//! encode, and the WebView records nothing. This is the same call
//! `transcript.rs` already made for dictation, for the same reason.
//!
//! THE FILE IS FRAGMENTED MP4, AND THAT IS NOT AN OPTIMISATION.
//! `lib.rs` hard-kills every child on `RunEvent::Exit`. A moov-at-stop muxer
//! loses the whole take there. `frag_keyframe+empty_moov+default_base_moof`
//! means a killed recording is still a playable file up to its last fragment.
//!
//! IT WRITES TO ~/Movies, NOT ~/Documents. The plan left this open; the
//! answer arrived from elsewhere in the same session. macOS was found
//! evicting this user's Documents to iCloud - it had already made a git
//! packfile unreadable, emptied the DMG archive to zero-block placeholders,
//! and put 78 seconds of stalled network reads into the transcript scan. A
//! 15 GB take is the worst possible thing to hand that mechanism. ~/Movies is
//! not part of Desktop & Documents sync.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// A recording in flight. One at a time, deliberately: two concurrent
/// captures of the same window is not a feature anyone asked for, and the
/// refusal is a clearer answer than two files fighting over one encoder.
struct Active {
    id: String,
    /// The ScreenCaptureKit engine, writing raw BGRA to ffmpeg's stdin.
    capture: std::process::Child,
    /// The encoder. Its stdin is the engine's output pipe, so it is finalized
    /// by closing that pipe rather than by a control byte.
    ffmpeg: std::process::Child,
    /// Where it is being written, and where it lands on a clean stop.
    part: PathBuf,
    done: PathBuf,
    /// The private directory holding the audio FIFO, removed on stop.
    fifo_dir: Option<PathBuf>,
    started_ms: u64,
}

#[derive(Default)]
pub struct Recorder {
    inner: Mutex<Option<Active>>,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct RecordingHandle {
    pub id: String,
    /// Wall clock when it started, so the UI can run its own elapsed timer
    /// rather than being told the elapsed time twice a second.
    pub started_ms: u64,
    /// Pixel size actually being written, straight off the engine's meta line.
    pub width: u32,
    pub height: u32,
    /// True when system audio is being captured. Video-only is a degrade, not
    /// a failure: a FIFO that cannot be made must not lose the picture too.
    pub audio: bool,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct RecordingResult {
    /// The finished file. A path, and deliberately NOT something that goes on
    /// the wire - see the Recording session message, which carries no path.
    pub path: String,
    pub bytes: u64,
    pub seconds: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `~/Movies/Sauce Bunny/Sessions`. Does not create it - the caller does,
/// so a listing of a machine that has never recorded is an empty shelf
/// rather than a directory the app made for no reason.
pub fn sessions_dir(app: &AppHandle) -> Result<PathBuf, crate::AppError> {
    let movies = app
        .path()
        .video_dir()
        .map_err(|e| crate::AppError::internal(format!("video_dir: {e}")))?;
    Ok(movies.join("Sauce Bunny").join("Sessions"))
}

/// Filesystem-safe, and short enough to read in Finder.
pub(crate) fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && out.len() < 48 {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() { "session".into() } else { trimmed }
}

/// Free bytes on the volume holding `path`, via statvfs.
///
/// Nothing else in this codebase checks disk space, because nothing else can
/// write 8 GB unattended. A refusal that names the number is the difference
/// between "recording failed" and a full startup volume.
pub(crate) fn free_bytes(path: &std::path::Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: `c` is a NUL-terminated path that outlives the call, and the
    // stat buffer is fully initialised by statvfs before we read it.
    unsafe {
        let mut st: libc::statvfs = std::mem::zeroed();
        if libc::statvfs(c.as_ptr(), &mut st) != 0 {
            return None;
        }
        Some(st.f_bavail as u64 * st.f_frsize as u64)
    }
}

/// Refuse under this much headroom. Two minutes of stage recording is ~180 MB;
/// 2 GiB is enough that a take has somewhere to go and the volume survives.
const MIN_FREE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// The private 0700 directory + FIFO the engine writes PCM into. Copied from
/// the share path, including the reason it is random rather than predictable:
/// a fixed /tmp name is open to pre-creation and symlink games by any local
/// process. None means video-only rather than no recording.
fn make_audio_fifo() -> Option<(PathBuf, PathBuf)> {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    let mut rnd = [0u8; 8];
    std::fs::File::open("/dev/urandom").ok()?.read_exact(&mut rnd).ok()?;
    let tag: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
    let dir = std::env::temp_dir().join(format!("saucebunny-rec-{tag}"));
    std::fs::create_dir(&dir).ok()?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).ok()?;
    let p = dir.join("audio.pcm");
    let ok = std::process::Command::new("/usr/bin/mkfifo")
        .arg(&p)
        .status()
        .map(|st| st.success())
        .unwrap_or(false);
    if ok { Some((dir, p)) } else { let _ = std::fs::remove_dir_all(&dir); None }
}

/// Read the engine's one `meta:{"width":W,"height":H}` line, with a deadline.
///
/// On a helper thread because the engine can wedge before printing anything
/// (SCShareableContent has been seen to hang), and a command that blocks
/// forever is worse than one that reports it could not start.
fn read_meta(child: &mut std::process::Child) -> Option<(u32, u32)> {
    use std::io::BufRead;
    let se = child.stderr.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<Option<(u32, u32)>>();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(se);
        let mut line = String::new();
        let mut found = None;
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            if let Some(json) = line.trim().strip_prefix("meta:") {
                let get = |key: &str| {
                    json.split(&format!("\"{key}\":")).nth(1).and_then(|r| {
                        r.trim_start()
                            .split(|c: char| !c.is_ascii_digit())
                            .next()?
                            .parse::<u32>()
                            .ok()
                    })
                };
                found = get("width").zip(get("height"));
                break;
            }
            if line.starts_with("error:") {
                break;
            }
            line.clear();
        }
        let _ = tx.send(found);
    });
    rx.recv_timeout(std::time::Duration::from_secs(8)).unwrap_or(None)
}

impl Recorder {
    pub fn is_recording(&self) -> bool {
        self.inner.lock().map(|g| g.is_some()).unwrap_or(false)
    }

    /// Finalize on app exit. Called from `RunEvent::Exit`, where there is no
    /// time to wait: ask ffmpeg to close its container, give it a bounded
    /// moment, then kill. The fragmented container means even a killed take
    /// plays up to its last fragment, so this is a best effort that improves
    /// the file rather than the thing standing between the user and a file.
    pub fn shutdown(&self) {
        let Ok(mut g) = self.inner.lock() else { return };
        let Some(mut a) = g.take() else { return };
        finalize(&mut a, std::time::Duration::from_millis(1500));
    }
}

/// Ask ffmpeg to finish, wait up to `grace`, then make sure both are dead.
/// Renames `.part` to its final name only if ffmpeg exited on its own terms.
fn finalize(a: &mut Active, grace: std::time::Duration) -> bool {
    // ORDER MATTERS. The engine goes first: closing its stdout gives ffmpeg
    // EOF on the video input, which is what makes ffmpeg write its trailer
    // and exit on its own terms. There is no `q` to send here - stdin is the
    // video (see recording_start) - so this IS the clean-stop mechanism, not
    // a fallback for one.
    let _ = a.capture.kill();
    let deadline = std::time::Instant::now() + grace;
    let mut clean = false;
    while std::time::Instant::now() < deadline {
        match a.ffmpeg.try_wait() {
            Ok(Some(_)) => { clean = true; break; }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    if !clean {
        let _ = a.ffmpeg.kill();
    }
    let _ = a.ffmpeg.wait();
    let _ = a.capture.wait();
    if let Some(d) = &a.fifo_dir {
        let _ = std::fs::remove_dir_all(d);
    }
    // Rename either way when there are bytes: a fragmented file is playable,
    // and leaving a watchable take named `.part` hides it from the user in
    // the name of tidiness. Only a zero-byte file stays `.part`.
    let has_bytes = std::fs::metadata(&a.part).map(|m| m.len() > 0).unwrap_or(false);
    if has_bytes {
        let _ = std::fs::rename(&a.part, &a.done);
    }
    clean
}

/// Start recording the app's own window.
///
/// `window_id` is a CGWindowID the caller found by listing windows and
/// matching the owning pid to this process - see `recording_own_window`.
#[tauri::command]
pub async fn recording_start(
    app: AppHandle,
    rec: State<'_, Recorder>,
    window_id: u32,
    title: Option<String>,
) -> Result<RecordingHandle, crate::AppError> {
    if rec.is_recording() {
        return Err(crate::AppError::invalid("Already recording this session."));
    }
    let root = sessions_dir(&app)?;
    std::fs::create_dir_all(&root)?;

    if let Some(free) = free_bytes(&root) {
        if free < MIN_FREE_BYTES {
            return Err(crate::AppError::invalid(format!(
                "Only {:.1} GB free where sessions are saved. Recording needs at least 2 GB.",
                free as f64 / 1e9
            )));
        }
    }

    let stamp = chrono_stamp();
    let dir = root.join(format!("{stamp}-{}", slugify(title.as_deref().unwrap_or("session"))));
    std::fs::create_dir_all(&dir)?;
    let part = dir.join("stage.mp4.part");
    let done = dir.join("stage.mp4");

    let cap_bin = crate::stream_proxy::capture_path()
        .ok_or_else(|| crate::AppError::internal("the screen capture engine is missing from this build"))?;
    let ff_bin = crate::stream_proxy::ffmpeg_path()
        .ok_or_else(|| crate::AppError::internal("ffmpeg is missing from this build"))?;

    let fifo = make_audio_fifo();
    let mut cc = std::process::Command::new(cap_bin);
    cc.arg("stream")
        .arg("--kind").arg("window")
        .arg("--id").arg(window_id.to_string())
        .arg("--fps").arg("30")
        // An archive, not a stream: no width cap, and our own audio INCLUDED
        // (it is the programme audio plus the room's voices as we render them).
        .arg("--full-res")
        .arg("--include-own-audio");
    if let Some((_, p)) = &fifo {
        cc.arg("--audio-fifo").arg(p);
    }
    cc.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut capture = cc.spawn().map_err(|e| {
        if let Some((d, _)) = &fifo { let _ = std::fs::remove_dir_all(d); }
        crate::AppError::internal(format!("capture engine did not start: {e}"))
    })?;

    let Some((w, h)) = read_meta(&mut capture) else {
        let _ = capture.kill();
        if let Some((d, _)) = &fifo { let _ = std::fs::remove_dir_all(d); }
        return Err(crate::AppError::internal(
            "the capture engine never reported a frame size. Screen Recording permission is granted in \
             System Settings, and a NEW grant only takes effect after Sauce Bunny restarts.",
        ));
    };

    let video = capture.stdout.take().ok_or_else(|| {
        crate::AppError::internal("capture engine produced no output stream")
    })?;

    let mut fc = std::process::Command::new(ff_bin);
    fc.arg("-hide_banner").arg("-loglevel").arg("error")
        .arg("-f").arg("rawvideo")
        .arg("-pix_fmt").arg("bgra")
        .arg("-s").arg(format!("{w}x{h}"))
        .arg("-r").arg("30")
        .arg("-i").arg("pipe:0");
    if let Some((_, p)) = &fifo {
        fc.arg("-f").arg("s16le").arg("-ar").arg("48000").arg("-ac").arg("2")
          .arg("-i").arg(p);
    }
    // Archive bitrates, NOT the share path's 6M/ultrafast/zerolatency - those
    // numbers exist because a share is uploaded once per peer, and baking them
    // into a master file bakes a transport compromise into an archive.
    fc.arg("-c:v").arg("h264_videotoolbox")
        .arg("-b:v").arg("12M").arg("-maxrate").arg("16M").arg("-bufsize").arg("24M")
        .arg("-pix_fmt").arg("yuv420p").arg("-g").arg("60");
    if fifo.is_some() {
        fc.arg("-c:a").arg("aac").arg("-b:a").arg("192k");
    }
    // See the module note: survives the kill on app exit as a playable file.
    fc.arg("-movflags").arg("frag_keyframe+empty_moov+default_base_moof")
        .arg("-y").arg(&part);
    // THE CAPTURE ENGINE'S STDOUT *IS* FFMPEG'S STDIN - a real OS pipe, so the
    // frames never pass through this process.
    //
    // Which settles how a recording stops, and it is worth stating because
    // the obvious answer is wrong. dictate_stop finalizes ffmpeg by writing
    // `q` to its stdin, and the plan for this module said to copy that. It
    // cannot be copied: stdin is carrying the video here, so there is no
    // second stdin to write a `q` into. Fortunately EOF does the same job -
    // ffmpeg writes its trailer and exits 0 when an input ends - so stopping
    // means killing the engine and letting the pipe close, which is exactly
    // what `finalize` does first and why it does it in that order.
    fc.stdin(std::process::Stdio::from(video))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let ffmpeg = fc.spawn().map_err(|e| {
        crate::AppError::internal(format!("ffmpeg did not start: {e}"))
    })?;

    let started_ms = now_ms();
    let id = format!("rec_{started_ms}");
    let handle = RecordingHandle {
        id: id.clone(),
        started_ms,
        width: w,
        height: h,
        audio: fifo.is_some(),
    };
    if let Ok(mut g) = rec.inner.lock() {
        *g = Some(Active {
            id,
            capture,
            ffmpeg,
            part,
            done,
            fifo_dir: fifo.map(|(d, _)| d),
            started_ms,
        });
    }
    Ok(handle)
}

/// Stop, finalize, and say where the file is.
#[tauri::command]
pub async fn recording_stop(
    rec: State<'_, Recorder>,
) -> Result<RecordingResult, crate::AppError> {
    let mut active = {
        let mut g = rec
            .inner
            .lock()
            .map_err(|_| crate::AppError::internal("recorder lock poisoned"))?;
        g.take().ok_or_else(|| crate::AppError::invalid("Nothing is recording."))?
    };
    finalize(&mut active, std::time::Duration::from_secs(6));
    let path = if active.done.exists() { active.done.clone() } else { active.part.clone() };
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(RecordingResult {
        path: path.to_string_lossy().into_owned(),
        bytes,
        seconds: now_ms().saturating_sub(active.started_ms) / 1000,
    })
}

/// What is recording, if anything. The UI asks on mount, for the same reason
/// the session state does: a pushed event cannot tell a reloaded window what
/// was already true.
#[tauri::command]
pub async fn recording_status(
    rec: State<'_, Recorder>,
) -> Result<Option<RecordingHandle>, crate::AppError> {
    let g = rec
        .inner
        .lock()
        .map_err(|_| crate::AppError::internal("recorder lock poisoned"))?;
    Ok(g.as_ref().map(|a| RecordingHandle {
        id: a.id.clone(),
        started_ms: a.started_ms,
        width: 0,
        height: 0,
        audio: a.fifo_dir.is_some(),
    }))
}

/// The CGWindowID of this app's own main window.
///
/// Found by asking the capture engine to list windows and matching the owning
/// pid to ours. The engine reports `pid` for exactly this: every other field
/// in that listing describes a window to a human choosing one.
#[tauri::command]
pub async fn recording_own_window(app: AppHandle) -> Result<u32, crate::AppError> {
    let _ = &app;
    let bin = crate::stream_proxy::capture_path()
        .ok_or_else(|| crate::AppError::internal("the screen capture engine is missing from this build"))?;
    let out = std::process::Command::new(bin)
        .arg("list")
        .output()
        .map_err(|e| crate::AppError::internal(format!("window list failed: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let me = std::process::id();
    // Deliberately a scan rather than a JSON parse: this is one integer out
    // of a listing whose shape belongs to the sidecar, and `media.rs` already
    // reads ffprobe the same way for the same reason.
    let mut best: Option<(u32, u64)> = None;
    for chunk in text.split("{\"") {
        let field = |k: &str| -> Option<u64> {
            chunk.split(&format!("\"{k}\":")).nth(1).and_then(|r| {
                r.trim_start().split(|c: char| !c.is_ascii_digit()).next()?.parse::<u64>().ok()
            })
        };
        let Some(pid) = field("pid") else { continue };
        if pid as u32 != me { continue; }
        let Some(id) = field("id") else { continue };
        let area = field("width").unwrap_or(0) * field("height").unwrap_or(0);
        if best.map(|(_, a)| area > a).unwrap_or(true) {
            best = Some((id as u32, area));
        }
    }
    best.map(|(id, _)| id).ok_or_else(|| {
        crate::AppError::internal(
            "could not find Sauce Bunny's own window to record. Screen Recording permission is granted \
             in System Settings, and a NEW grant only takes effect after Sauce Bunny restarts.",
        )
    })
}

/// `2026-09-02-2314`, local time, for the session folder name.
fn chrono_stamp() -> String {
    // No chrono in this crate's graph; the shell's own date is already used
    // for build stamps in scripts/, and this is the one place a human-readable
    // local timestamp is needed at runtime.
    std::process::Command::new("/bin/date")
        .arg("+%Y-%m-%d-%H%M")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("session-{}", now_ms()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugify_makes_a_finder_safe_name() {
        assert_eq!(slugify("The Order of Herus Chapter 1"), "The-Order-of-Herus-Chapter-1");
        // Runs of punctuation collapse rather than producing `--`.
        assert_eq!(slugify("a///b"), "a-b");
        // Never empty, or the folder name would be a bare timestamp with a
        // trailing dash.
        assert_eq!(slugify(""), "session");
        assert_eq!(slugify("///"), "session");
        // Bounded, so a 200-character clip title cannot make an unreadable
        // directory name.
        assert!(slugify(&"x".repeat(300)).len() <= 48);
    }

    #[test]
    fn free_space_reads_the_volume() {
        // Not a threshold assertion - just that statvfs is wired and returns
        // something plausible for a path that certainly exists. A None here
        // would silently disable the precheck.
        let free = free_bytes(std::path::Path::new("/"));
        assert!(free.is_some(), "statvfs returned nothing for /");
        assert!(free.unwrap() > 0, "the startup volume reports zero free bytes");
    }
}
