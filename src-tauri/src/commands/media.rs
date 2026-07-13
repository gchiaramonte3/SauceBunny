//! Media-processing commands — every flow that talks to ffmpeg.
//!
//! Lives here:
//!   - Clip pipeline: `create_clip` + `spawn_video_clip` /
//!     `spawn_audio_clip` / `run_clip_loop` (ffmpeg progress parsing,
//!     job registry hooks, log fanout).
//!   - Frame extraction: `extract_frame` (URL-source snapshots).
//!   - Local-file ops: `probe_local_file`, `extract_local_frame`,
//!     `generate_local_thumbnail`, `prepare_local_for_playback`.
//!   - ffmpeg output parsers: duration / video / audio probe, progress
//!     time, log-line classifier.
//!
//! Extracted from the 4155-line commands.rs monolith in r47 per the
//! constitution's refactor priority #1.

use super::*;

fn is_ffmpeg_progress(line: &str) -> bool {
    let l = line.trim_start();
    (l.starts_with("frame=") || l.starts_with("size=")) && l.contains("time=")
}

fn parse_ffmpeg_time(line: &str) -> Option<f64> {
    let idx = line.find("time=")?;
    let rest = &line[idx + 5..];
    let end = rest.find(' ').unwrap_or(rest.len());
    let tc = &rest[..end];
    parse_hms_ms(tc)
}

pub(crate) fn find_audio_in_cache(dir: &std::path::Path, prefix: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).find_map(|e| {
        let p = e.path();
        let name = p.file_name()?.to_str()?.to_string();
        if name.starts_with(prefix) && !name.ends_with(".srt") && !name.ends_with(".partial") {
            Some(p)
        } else {
            None
        }
    })
}

#[derive(Deserialize)]
pub struct ClipArgs {
    pub url: String,
    /// HH:MM:SS:FF (or HH:MM:SS) start mark. `None` → no in mark.
    pub start: Option<String>,
    /// HH:MM:SS:FF (or HH:MM:SS) end mark.  `None` → no out mark.
    pub end: Option<String>,
    pub fps: Option<f64>,
    pub output_dir: String,
    pub filename: String,
    pub job_id: String,
    pub format: String,     // "4k" | "1080" | "720" | "audio"
    pub reencode: bool,
    pub captions: bool,
    /// Browser to pull YouTube cookies from. See `cookies_args()`.
    pub cookies_browser: Option<String>,
}

fn yt_dlp_video_format(fmt: &str) -> &'static str {
    match fmt {
        "4k"  => "bv*[height<=2160]+ba/b[height<=2160]/bv*+ba/b",
        "720" => "bv*[height<=720]+ba/b[height<=720]/bv*+ba/b",
        _     => "bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b",
    }
}

/// Helper — emit a clip-done event with optional path/error.
fn emit_clip_done(
    app: &AppHandle,
    job_id: &str,
    success: bool,
    code: Option<i32>,
    path: Option<String>,
    error: Option<String>,
) {
    let _ = app.emit(
        "clip-done",
        DoneEvent {
            job_id: job_id.to_string(),
            success,
            code,
            path,
            error,
        },
    );
}

fn emit_clip_log(app: &AppHandle, job_id: &str, tag: &str, line: String) {
    let _ = app.emit(
        "clip-log",
        LogEvent {
            job_id: job_id.to_string(),
            stream: "stdout".into(),
            tag: tag.to_string(),
            line,
        },
    );
}

#[tauri::command]
pub async fn create_clip(app: AppHandle, args: ClipArgs) -> Result<String, crate::AppError> {
    validate_source_url(&args.url)?;
    let fps = args.fps.unwrap_or(24.0);

    // Section is optional: both marks set → cut that range; both unset →
    // download the entire stream (the "youtube-to-mp3" path, fastest by far);
    // one of each → user error.
    let section_secs: Option<(f64, f64)> = match (&args.start, &args.end) {
        (Some(s), Some(e)) => {
            let s_secs = timecode_to_seconds(s, fps)?;
            let e_secs = timecode_to_seconds(e, fps)?;
            if e_secs <= s_secs + 0.04 {
                return Err("Mark out must be after mark in".into());
            }
            Some((s_secs, e_secs))
        }
        (None, None) => None,
        _ => return Err("Set both marks or neither — not just one.".into()),
    };

    let safe = sanitize_filename(&args.filename);
    if safe.is_empty() {
        return Err("Filename is empty".into());
    }
    let out_dir = PathBuf::from(&args.output_dir);
    if !out_dir.is_dir() {
        return Err("Output folder does not exist".into());
    }

    let target_ext = if args.format == "audio" { "mp3" } else { "mp4" };
    let mut output_path = out_dir.join(&safe);
    let cur_ext = output_path
        .extension()
        .map(|e| e.to_ascii_lowercase().to_string_lossy().to_string());
    if cur_ext.as_deref() != Some(target_ext) {
        output_path.set_extension(target_ext);
    }
    if output_path.exists() {
        return Err(format!("File already exists: {}", output_path.display()).into());
    }
    let output_str = output_path
        .to_str()
        .ok_or_else(|| crate::AppError::internal("output path is not valid utf-8"))?
        .to_string();

    let ffmpeg = sidecar_path("ffmpeg")?;
    if !ffmpeg.exists() {
        return Err(format!("ffmpeg sidecar missing at {}", ffmpeg.display()).into());
    }
    let ffmpeg_str = ffmpeg.to_str().ok_or_else(|| crate::AppError::internal("ffmpeg path not utf-8"))?.to_string();

    let job_id = args.job_id.clone();

    if args.format == "audio" {
        // ── AUDIO 2-PHASE PATH ──
        // yt-dlp downloads the raw audio stream (no post-processing — that's
        // the path that hit the manifest-URL bug). Then ffmpeg encodes to mp3.
        spawn_audio_clip(app, job_id.clone(), args.url.clone(), section_secs,
                         output_str, ffmpeg_str, args.cookies_browser.clone()).await?;
    } else {
        // ── VIDEO SPAWN PATH ──
        spawn_video_clip(app, args, job_id.clone(), section_secs, output_str, ffmpeg_str).await?;
    }

    Ok(job_id)
}

async fn spawn_video_clip(
    app: AppHandle,
    args: ClipArgs,
    job_id: String,
    section_secs: Option<(f64, f64)>,
    output_str: String,
    ffmpeg_str: String,
) -> Result<(), crate::AppError> {
    let mut cmd_args: Vec<String> = vec![
        "-f".into(),
        yt_dlp_video_format(&args.format).into(),
        "--ffmpeg-location".into(),
        ffmpeg_str,
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        "--progress".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "-o".into(),
        output_str.clone(),
        "--merge-output-format".into(),
        "mp4".into(),
        // ─── Concurrent fragments — the actual 10× speedup ─────────────
        // YouTube throttles single-stream downloads to ~1.5–2× realtime
        // (intentional anti-scrape measure). Splitting the DASH manifest
        // into 16 parallel HTTP requests bypasses the per-connection cap
        // and saturates the user's bandwidth instead. Each fragment is
        // typically 1–10s of video, so 16 parallel = ~16× throughput on
        // a fast connection. Combined with hardware re-encode below this
        // gets us close to the user's 10× target.
        "--concurrent-fragments".into(), "16".into(),
        // Bigger HTTP chunks per request → fewer round trips, less per-
        // connection overhead in TLS / TCP handshake.
        "--http-chunk-size".into(), "10M".into(),
    ];
    if let Some((s, e)) = section_secs {
        cmd_args.push("--download-sections".into());
        cmd_args.push(format!("*{:.3}-{:.3}", s, e));
        // Frame-accurate cut only matters when sectioning.
        if args.reencode {
            cmd_args.push("--force-keyframes-at-cuts".into());
            // ─── Hardware-encode the boundary re-cuts ──────────────────
            // Without these args, yt-dlp's ffmpeg sub-invocation defaults
            // to libx264 (software, ~1.5–2× realtime on Apple Silicon).
            // h264_videotoolbox is the macOS hardware H.264 encoder —
            // 10–15× realtime for 1080p, gets us frame-accurate cuts
            // without the slow software-encode penalty.
            //
            // We target both possible ffmpeg invocations yt-dlp may make
            // during the keyframe re-cut:
            //   • `ffmpeg_o` — output args on the final mux
            //   • `Merger`  — the A+V stream merger
            // -b:v 8M ≈ visually transparent for 1080p; bump for 4K via
            // the format selector if needed.
            cmd_args.extend([
                "--postprocessor-args".into(),
                "ffmpeg_o:-c:v h264_videotoolbox -b:v 8M -pix_fmt yuv420p -movflags +faststart".into(),
                "--postprocessor-args".into(),
                "Merger:-c:v h264_videotoolbox -b:v 8M -pix_fmt yuv420p -movflags +faststart".into(),
            ]);
        }
    }
    if args.captions {
        cmd_args.extend([
            "--write-subs".into(),
            "--sub-langs".into(),
            "en.*,en".into(),
            "--embed-subs".into(),
            "--convert-subs".into(),
            "srt".into(),
        ]);
    }
    // `cmd_args` is now the cookie-free, URL-free base; each attempt appends the
    // cookie flag (or not) + the URL so we can retry public on a cookied failure.
    let total_seconds = section_secs.map(|(s, e)| (e - s).max(0.0)).unwrap_or(0.0);
    let url = args.url.clone();
    let cookies_browser = args.cookies_browser.clone();
    let cookied = !cookies_args(cookies_browser.as_deref()).is_empty();

    tokio::spawn(async move {
        let with = |cookies: Option<&str>| {
            let mut a = cmd_args.clone();
            a.extend(cookies_args(cookies));
            a.push(url.clone());
            a
        };
        // Cookies-first (YouTube bot-checks / private content); on a GENUINE
        // failure (not a user Stop) when cookies were applied, retry WITHOUT
        // them — some sites (LinkedIn) serve a logged-in page yt-dlp can't
        // parse. Mirrors the stream resolver's cookie-fallback.
        let mut outcome =
            run_video_attempt(&app, &job_id, with(cookies_browser.as_deref()), total_seconds).await;
        if !outcome.success && !outcome.signalled && cookied {
            emit_clip_log(&app, &job_id, "info",
                "Export failed with sign-in cookies — retrying without…".into());
            // Clear the partial output + yt-dlp format intermediates so the
            // no-cookie retry starts clean. Otherwise --continue resumes the
            // cookied attempt's half-file, and the no-cookie resolve can pick a
            // DIFFERENT format → spliced/corrupt output (or a size-complete file
            // makes yt-dlp print "already downloaded" and exit 0 over junk).
            let _ = std::fs::remove_file(&output_str);
            let _ = std::fs::remove_file(format!("{output_str}.part"));
            let out_path = std::path::Path::new(&output_str);
            if let (Some(dir), Some(stem)) =
                (out_path.parent(), out_path.file_stem().and_then(|s| s.to_str()))
            {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        // `<stem>.fNNN.<ext>` format intermediates (clip.f399.mp4)
                        if name.starts_with(stem) && name[stem.len()..].starts_with(".f") {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
            outcome = run_video_attempt(&app, &job_id, with(None), total_seconds).await;
        }
        let success = outcome.success;
        if success {
            let _ = app.emit("clip-progress", ProgressEvent {
                job_id: job_id.clone(), percent: 100.0,
            });
        }
        let error = if success {
            None
        } else if outcome.signalled {
            Some("Cancelled".into())
        } else if outcome.saw_auth_error {
            Some(YT_AUTH_HINT.into())
        } else {
            Some(format!("yt-dlp exited with code {:?}", outcome.code))
        };
        let path = if success { Some(output_str.clone()) } else { None };
        emit_clip_done(&app, &job_id, success, outcome.code, path, error);
    });
    Ok(())
}

/// Spawn one yt-dlp video attempt, register it for cancellation, and run the
/// streaming loop. Returns the terminal outcome (spawn failures included).
async fn run_video_attempt(
    app: &AppHandle,
    job_id: &str,
    cmd_args: Vec<String>,
    total_seconds: f64,
) -> ClipOutcome {
    let cmd = match ytdlp(app) {
        Ok(c) => c,
        Err(e) => {
            emit_clip_log(app, job_id, "err", format!("yt-dlp unavailable: {e}"));
            return ClipOutcome { success: false, code: None, signalled: false, saw_auth_error: false };
        }
    };
    let (mut rx, child) = match cmd.args(cmd_args).spawn() {
        Ok(v) => v,
        Err(e) => {
            emit_clip_log(app, job_id, "err", format!("failed to spawn yt-dlp: {e}"));
            return ClipOutcome { success: false, code: None, signalled: false, saw_auth_error: false };
        }
    };
    app.state::<JobRegistry>().insert(job_id.to_string(), child);
    run_clip_loop(app, job_id, &mut rx, total_seconds).await
}

async fn spawn_audio_clip(
    app: AppHandle,
    job_id: String,
    url: String,
    section_secs: Option<(f64, f64)>,
    output_str: String,
    ffmpeg_str: String,
    cookies_browser: Option<String>,
) -> Result<(), crate::AppError> {
    // Phase 1: yt-dlp downloads raw bestaudio to cache.
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| crate::AppError::internal(format!("app_cache_dir: {e}")))?;
    std::fs::create_dir_all(&cache)
        .map_err(|e| crate::AppError::internal(format!("mkdir cache: {e}")))?;
    let raw_prefix = format!("saucebunny-{}-raw", job_id);
    let raw_template = cache
        .join(format!("{}.%(ext)s", raw_prefix))
        .to_string_lossy()
        .to_string();

    let mut yt_args: Vec<String> = vec![
        "-f".into(),
        "bestaudio/best".into(),
        // Cut the section with the BUNDLED ffmpeg, not whatever's on PATH.
        // Without this yt-dlp falls back to /opt/homebrew/bin/ffmpeg, which
        // isn't present on a distributed app (DISTRIBUTION.md: self-contained).
        "--ffmpeg-location".into(),
        ffmpeg_str,
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        "--progress".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        // Parallel fragment download — same anti-throttle trick as the
        // video clip path. See spawn_video_clip's comment for the why.
        "--concurrent-fragments".into(), "16".into(),
        "--http-chunk-size".into(), "10M".into(),
        "-o".into(),
        raw_template,
    ];
    yt_args.extend(cookies_args(cookies_browser.as_deref()));
    if let Some((s, e)) = section_secs {
        yt_args.push("--download-sections".into());
        yt_args.push(format!("*{:.3}-{:.3}", s, e));
    }
    yt_args.push(url);

    let cmd = ytdlp(&app)?;
    let (mut rx, child) = cmd
        .args(yt_args)
        .spawn()
        .map_err(|e| format!("failed to spawn yt-dlp: {e}"))?;
    app.state::<JobRegistry>().insert(job_id.clone(), child);

    let app_for = app.clone();
    let job_for = job_id.clone();
    let cache_for = cache.clone();
    let raw_prefix_for = raw_prefix.clone();
    let output_for = output_str.clone();
    // yt-dlp's [download] % is the download progress for this phase. We map
    // it to 0–80% so phase 2 (mp3 encode) can advance the bar through 80–100.

    tokio::spawn(async move {
        // Phase 1 loop — collect log + progress until yt-dlp terminates.
        let mut yt_failed: Option<(Option<i32>, bool)> = None;
        let mut saw_auth_error = false;
        let mut last_log_at = std::time::Instant::now() - std::time::Duration::from_secs(1);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let line = line.trim_end();
                        if line.is_empty() { continue; }
                        if is_youtube_auth_error_line(line) { saw_auth_error = true; }
                        if is_ytdlp_progress(line) {
                            if let Some(pct) = regex_lite_percent(line) {
                                // Reserve the top 20% for the mp3 encode phase.
                                let scaled = pct * 0.8;
                                let _ = app_for.emit("clip-progress", ProgressEvent {
                                    job_id: job_for.clone(), percent: scaled,
                                });
                            }
                            if last_log_at.elapsed().as_millis() < 500 { continue; }
                            last_log_at = std::time::Instant::now();
                        }
                        let tag = classify_line(line);
                        emit_clip_log(&app_for, &job_for, &tag, line.to_string());
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_for.state::<JobRegistry>().take(&job_for);
                    let success = payload.code == Some(0);
                    // Detect cancellation: SIGTERM means non-zero exit and the
                    // raw file may or may not be present.
                    if !success {
                        yt_failed = Some((payload.code, true));
                    }
                    break;
                }
                _ => {}
            }
        }
        if let Some((code, _)) = yt_failed {
            // Clean up any partial raw file yt-dlp wrote before we bail —
            // otherwise cancelled/failed audio jobs accumulate forever in
            // the app cache directory.
            if let Some(p) = find_audio_in_cache(&cache_for, &raw_prefix_for) {
                let _ = std::fs::remove_file(p);
            }
            emit_clip_done(
                &app_for, &job_for, false, code, None,
                Some(if code == Some(-1) || code.is_none() {
                    "Cancelled".into()
                } else if saw_auth_error {
                    YT_AUTH_HINT.into()
                } else {
                    format!("Audio download failed (yt-dlp exit {:?})", code)
                }),
            );
            return;
        }

        // Phase 2: locate raw file and ffmpeg → mp3.
        let raw_path = match find_audio_in_cache(&cache_for, &raw_prefix_for) {
            Some(p) => p,
            None => {
                emit_clip_done(
                    &app_for, &job_for, false, None, None,
                    Some("Audio download produced no file".into()),
                );
                return;
            }
        };
        let raw_mb = raw_path
            .metadata()
            .map(|m| m.len() as f64 / 1_000_000.0)
            .unwrap_or(0.0);
        emit_clip_log(
            &app_for,
            &job_for,
            "info",
            format!("Got {:.1} MB of audio · encoding mp3…", raw_mb),
        );
        let _ = app_for.emit("clip-progress", ProgressEvent {
            job_id: job_for.clone(), percent: 80.0,
        });

        let raw_path_str = raw_path.to_string_lossy().to_string();
        let ff = match app_for.shell().sidecar("ffmpeg") {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&raw_path);
                emit_clip_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("ffmpeg sidecar not found: {e}")),
                );
                return;
            }
        };
        // -vn drops any embedded thumbnail/image track; libmp3lame VBR -q:a 2
        // is the sweet spot (~190 kbps, fast).
        let ff_args = [
            "-y", "-i", &raw_path_str,
            "-vn",
            "-codec:a", "libmp3lame",
            "-q:a", "2",
            "-id3v2_version", "3",
            &output_for,
        ];
        let ff_out = ff.args(ff_args).output().await;
        let _ = std::fs::remove_file(&raw_path);
        let ff_out = match ff_out {
            Ok(o) => o,
            Err(e) => {
                emit_clip_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("ffmpeg failed to run: {e}")),
                );
                return;
            }
        };
        if !ff_out.status.success() {
            let stderr = String::from_utf8_lossy(&ff_out.stderr);
            let _ = std::fs::remove_file(&output_for);
            emit_clip_done(
                &app_for, &job_for, false, ff_out.status.code(), None,
                Some(format!("MP3 encode failed — {}", short_err(&stderr))),
            );
            return;
        }
        let _ = app_for.emit("clip-progress", ProgressEvent {
            job_id: job_for.clone(), percent: 100.0,
        });
        emit_clip_done(
            &app_for, &job_for, true, Some(0),
            Some(output_for.clone()), None,
        );
    });

    Ok(())
}

/// Terminal outcome of one yt-dlp clip attempt, returned by `run_clip_loop`
/// so the caller can decide whether to retry (e.g. WITHOUT cookies) before
/// emitting the single `clip-done` event.
struct ClipOutcome {
    success: bool,
    code: Option<i32>,
    /// The child was killed by a signal (user Stop) — a REAL cancellation, not
    /// a failure. We key cancellation off this, NOT off a missing output file:
    /// a genuine extraction failure (e.g. LinkedIn with auth cookies) also exits
    /// non-zero and writes no file, and mislabelling that as "Cancelled" both
    /// confuses the user and defeats the cookie-retry below.
    signalled: bool,
    saw_auth_error: bool,
}

/// The streaming receiver loop used by the video clip path. Parses progress
/// (% and ffmpeg time=) and throttles chatty log lines. Returns the terminal
/// outcome WITHOUT emitting `clip-done` — the caller owns that so it can retry.
async fn run_clip_loop(
    app: &AppHandle,
    job_id: &str,
    rx: &mut tokio::sync::mpsc::Receiver<CommandEvent>,
    total_seconds: f64,
) -> ClipOutcome {
    let mut last_log_at = std::time::Instant::now() - std::time::Duration::from_secs(1);
    // Track auth-failure markers as they stream — if we hit one and the
    // process then exits non-zero, swap the generic "exited with code X"
    // for the actionable Settings → YouTube auth hint.
    let mut saw_auth_error = false;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                let raw = String::from_utf8_lossy(&bytes).to_string();
                for line in raw.lines() {
                    let line = line.trim_end();
                    if line.is_empty() { continue; }
                    if is_youtube_auth_error_line(line) { saw_auth_error = true; }
                    let is_progress = is_ytdlp_progress(line) || is_ffmpeg_progress(line);
                    if is_progress {
                        if let Some(pct) = regex_lite_percent(line) {
                            let _ = app.emit("clip-progress", ProgressEvent {
                                job_id: job_id.to_string(), percent: pct,
                            });
                        } else if let Some(t) = parse_ffmpeg_time(line) {
                            if total_seconds > 0.0 {
                                let pct = (t / total_seconds * 100.0).clamp(0.0, 100.0);
                                let _ = app.emit("clip-progress", ProgressEvent {
                                    job_id: job_id.to_string(), percent: pct,
                                });
                            }
                        }
                        if last_log_at.elapsed().as_millis() < 500 { continue; }
                        last_log_at = std::time::Instant::now();
                    }
                    let tag = classify_line(line);
                    emit_clip_log(app, job_id, &tag, line.to_string());
                }
            }
            CommandEvent::Terminated(payload) => {
                let _ = app.state::<JobRegistry>().take(job_id);
                return ClipOutcome {
                    success: payload.code == Some(0),
                    code: payload.code,
                    signalled: payload.signal.is_some(),
                    saw_auth_error,
                };
            }
            _ => {}
        }
    }
    // Channel closed without a Terminated event — treat as a failure.
    ClipOutcome { success: false, code: None, signalled: false, saw_auth_error }
}

// Crude classifier: tag every line so the UI can color it.
pub(crate) fn classify_line(line: &str) -> String {
    let l = line.to_ascii_lowercase();
    if l.contains("error") || l.contains("traceback") || l.starts_with("error:") {
        "err".into()
    } else if l.contains("warning") || l.starts_with("warn") {
        "warn".into()
    } else if l.starts_with("[ffmpeg]") || l.starts_with("[merger]") {
        "muxer".into()
    } else if l.starts_with("[download]") && l.contains("100%") {
        "ok".into()
    } else {
        // [download] progress, other [bracketed] sources, and plain lines
        // all render as plain info.
        "info".into()
    }
}

// Tiny no-regex percent extractor for "[download]  10.0% of ~ ..." lines.
pub(crate) fn regex_lite_percent(line: &str) -> Option<f64> {
    if !line.contains('%') {
        return None;
    }
    // Trim leading bracketed source like "[download]".
    let rest = if let Some(idx) = line.find(']') {
        &line[idx + 1..]
    } else {
        line
    };
    // Find the percent token.
    let pct_idx = rest.find('%')?;
    let head = &rest[..pct_idx];
    let num: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let v: f64 = num.parse().ok()?;
    if v.is_finite() && (0.0..=100.0).contains(&v) {
        Some(v)
    } else {
        None
    }
}

// ============================================================
// FRAME EXTRACTION
// Resolve a direct video URL via yt-dlp, then ffmpeg seeks and grabs one frame.
// ============================================================
#[derive(Deserialize)]
pub struct ExtractFrameArgs {
    pub url: String,
    pub timestamp_seconds: f64,
    pub dest: String,
    pub cookies_browser: Option<String>,
}

/// Returned from `extract_frame` so the UI can surface the actual resolution
/// it pulled (e.g. "Saved 3840×2160 frame to …") — gives the user proof we
/// hit the highest-quality stream available.
#[derive(Serialize)]
pub struct ExtractFrameResult {
    pub path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub vcodec: Option<String>,
    pub format_id: Option<String>,
}

#[tauri::command]
pub async fn extract_frame(app: AppHandle, args: ExtractFrameArgs) -> Result<ExtractFrameResult, crate::AppError> {
    validate_source_url(&args.url)?;
    if args.timestamp_seconds < 0.0 {
        return Err("Timestamp must be non-negative".into());
    }
    let dest_path = PathBuf::from(&args.dest);
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Folder does not exist: {}", parent.display()).into());
        }
    }

    // ── Step 1: pick the actually-best video stream ─────────────────────
    // The previous selector `bv*[height<=2160]/bv*/b` was correct in spirit
    // but had two failure modes:
    //   1. If yt-dlp couldn't fully enumerate the DASH manifest (nsig issues,
    //      slow probe), it'd silently fall through to `/b` — which on YouTube
    //      is format 18 (640×360 muxed). That's why snapshots looked tiny
    //      even on 1080p sources.
    //   2. There's no explicit resolution-desc sort, so `bv*` could return
    //      the first format yt-dlp parsed rather than the highest-res one.
    //
    // The fix:
    //   • `-S "res,vbr,ext"` — explicitly sort by resolution descending,
    //     then bitrate, then prefer mp4. yt-dlp guarantees the top of the
    //     list is the absolute best after this.
    //   • `-f "bv*+ba/bv*/b"` — best video (any container) + best audio for
    //     fallback compatibility. We only consume the video URL.
    //   • `--print` twice — line 1 is the URL ffmpeg consumes, line 2 is
    //     human-readable proof of what we picked. Logged to pipeline.
    //   • No height cap — 8K snapshots are fine if YouTube serves them.
    let yt = ytdlp(&app)?;
    let mut yt_invocation: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "-S".into(), "res,vbr,ext".into(),
        "-f".into(), "bv*/b".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        // Two outputs: the direct video URL (line 1) and a JSON-ish
        // descriptor (line 2). Splitting on "\t" lets us parse safely
        // even when fields contain spaces.
        "--print".into(), "url".into(),
        "--print".into(), "%(format_id)s\t%(width)s\t%(height)s\t%(vcodec)s".into(),
    ];
    yt_invocation.extend(cookies_args(args.cookies_browser.as_deref()));
    yt_invocation.push(args.url.clone());
    let yt_out = yt
        .args(yt_invocation)
        .output()
        .await
        .map_err(|e| format!("yt-dlp failed: {e}"))?;
    if !yt_out.status.success() {
        let err = String::from_utf8_lossy(&yt_out.stderr).to_string();
        return Err(humanize_ytdlp_error(&err).into());
    }
    let stdout = String::from_utf8_lossy(&yt_out.stdout).to_string();
    let mut lines = stdout.lines().filter(|l| !l.trim().is_empty());
    let direct_url = lines
        .next()
        .ok_or_else(|| crate::AppError::internal("yt-dlp returned no URL"))?
        .to_string();
    // Format descriptor line — tab-separated: format_id, width, height, vcodec.
    let (format_id, width, height, vcodec) = if let Some(desc) = lines.next() {
        let parts: Vec<&str> = desc.split('\t').collect();
        let fid  = parts.first().filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
        let w    = parts.get(1).and_then(|s| s.parse::<u32>().ok());
        let h    = parts.get(2).and_then(|s| s.parse::<u32>().ok());
        let vc   = parts.get(3).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
        (fid, w, h, vc)
    } else {
        (None, None, None, None)
    };

    // ── Step 2: ffmpeg seeks to the timestamp and grabs one frame ───────
    // -q:v 1 = best JPEG quality (1–31, lower is better). For .png the
    // -q:v flag is ignored and we get lossless output automatically.
    let ts = format!("{:.3}", args.timestamp_seconds);
    let ff = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("sidecar ffmpeg not found: {e}"))?;
    let ff_out = ff
        .args([
            "-y",
            // -ss BEFORE -i = fast seek (uses container index, not decode).
            // For a single frame this is accurate enough and 50× faster than
            // post-input seeking on a remote stream.
            "-ss",
            &ts,
            "-i",
            &direct_url,
            "-frames:v",
            "1",
            "-q:v",
            "1",
            &args.dest,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed: {e}"))?;
    if !ff_out.status.success() {
        let err = String::from_utf8_lossy(&ff_out.stderr).to_string();
        // ffmpeg is chatty; pull just the last line that mentions an error.
        let last = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("(no detail)");
        return Err(format!("ffmpeg failed: {last}").into());
    }
    Ok(ExtractFrameResult {
        path: args.dest,
        width,
        height,
        vcodec,
        format_id,
    })
}

// ============================================================
// LOCAL FILE SUPPORT
// MacWhisper-style: import a local mp3/mp4/mov/etc and run our pipeline
// (Whisper transcription, snapshots, etc.) on it directly — no yt-dlp.
// ============================================================

#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LocalFileMeta {
    pub path: String,
    pub filename: String,
    // See Metadata::view_count for the bigint→number rationale (r49).
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub has_video: bool,
    pub has_audio: bool,
}

fn parse_ffmpeg_duration(stderr: &str) -> Option<f64> {
    // "  Duration: 00:01:23.45, ..."
    let idx = stderr.find("Duration:")?;
    let rest = &stderr[idx + 9..];
    let tc = rest.split(',').next()?.trim();
    parse_hms_ms(tc)
}

// Extract the first "Stream #X:Y... Video: <codec> (... <W>x<H> ... <fps> fps"
fn parse_ffmpeg_video(stderr: &str) -> (Option<u32>, Option<u32>, Option<f64>, Option<String>) {
    for line in stderr.lines() {
        let line = line.trim_start();
        if !line.starts_with("Stream #") || !line.contains("Video:") {
            continue;
        }
        // codec lives between "Video: " and the next " " or "("
        let codec = line
            .split("Video: ").nth(1)
            .and_then(|s| s.split([' ', ',', '(']).next())
            .map(|s| s.to_string());
        // WxH
        let mut w: Option<u32> = None;
        let mut h: Option<u32> = None;
        // Scan tokens for "WxH" where W,H are digits
        for tok in line.split([' ', ',', '[', ']']) {
            if let Some((a, b)) = tok.split_once('x') {
                if let (Ok(aw), Ok(bh)) = (a.parse::<u32>(), b.parse::<u32>()) {
                    if aw >= 16 && bh >= 16 && aw <= 16384 && bh <= 16384 {
                        w = Some(aw);
                        h = Some(bh);
                        break;
                    }
                }
            }
        }
        // fps
        let fps = line.split(", ").find_map(|p| {
            let p = p.trim();
            if let Some(rest) = p.strip_suffix(" fps") {
                rest.trim().parse::<f64>().ok()
            } else { None }
        });
        return (w, h, fps, codec);
    }
    (None, None, None, None)
}

fn parse_ffmpeg_audio(stderr: &str) -> Option<String> {
    for line in stderr.lines() {
        let line = line.trim_start();
        if !line.starts_with("Stream #") || !line.contains("Audio:") {
            continue;
        }
        return line
            .split("Audio: ").nth(1)
            .and_then(|s| s.split([' ', ',', '(']).next())
            .map(|s| s.to_string());
    }
    None
}

#[tauri::command]
pub async fn probe_local_file(app: AppHandle, path: String) -> Result<LocalFileMeta, crate::AppError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        // Typed NotFound (not prose in an `Invalid`): the frontend prunes
        // stale recents by branching on `kind === "NotFound"` (App.tsx
        // handleOpenRecentSource), so this must stay machine-readable.
        return Err(crate::AppError::not_found(path));
    }
    let size_bytes = p.metadata().map(|m| m.len()).unwrap_or(0);
    let filename = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    // `ffmpeg -i <file>` exits non-zero (no output specified) but dumps the
    // stream info to stderr. -hide_banner trims the build header.
    let ff = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar: {e}"))?;
    let out = ff
        .args(["-hide_banner", "-i", &path])
        .output()
        .await
        .map_err(|e| format!("ffmpeg probe failed: {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    let duration = parse_ffmpeg_duration(&stderr);
    let (width, height, fps, vcodec) = parse_ffmpeg_video(&stderr);
    let acodec = parse_ffmpeg_audio(&stderr);

    Ok(LocalFileMeta {
        path,
        filename,
        size_bytes,
        duration,
        width,
        height,
        fps,
        vcodec: vcodec.clone(),
        acodec: acodec.clone(),
        has_video: vcodec.is_some(),
        has_audio: acodec.is_some(),
    })
}

// ────────────────────────────────────────────────────────────────────────
// LOCAL FILE BYTE READS (mediabunny CustomSource backend)
//
// mediabunny's `UrlSource` range-fetches a local file over the Tauri
// `asset://` protocol, which stalls on large local files (an 800 MB mp4
// won't load). The frontend instead backs mediabunny's `CustomSource` with
// these two thin commands: `get_file_size` for the total length and
// `read_file_range` for a lazy `[offset, offset+length)` slice.
//
// This is a hot read path during scrub/playback, so `read_file_range`
// returns `tauri::ipc::Response` — RAW bytes → an ArrayBuffer on the JS
// side. Do NOT change it to `Vec<u8>`: Tauri JSON-encodes that as a decimal
// number array (~4× bloat) and would cripple performance here.
// ────────────────────────────────────────────────────────────────────────

/// Total byte length of a local file — mediabunny's `CustomSource.getSize`.
#[tauri::command]
pub fn get_file_size(path: String) -> Result<u64, crate::AppError> {
    Ok(std::fs::metadata(&path)?.len())
}

/// Byte-reading core, split out so it's unit-testable without a Tauri
/// `Response` (whose body is opaque). Reads at most `length` bytes starting
/// at `offset`, clamped at EOF — a request past the tail returns a short (or
/// empty) buffer rather than erroring.
fn read_file_range_bytes(path: &str, offset: u64, length: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path)?;
    f.seek(SeekFrom::Start(offset))?;
    // `Take` caps the read at `length`; `read_to_end` stops early at EOF, so
    // the two together clamp the range without any explicit size math.
    let mut buf = Vec::new();
    f.take(length).read_to_end(&mut buf)?;
    Ok(buf)
}

/// Read a byte slice of a local file for mediabunny's `CustomSource.read`.
/// Returns RAW bytes via `tauri::ipc::Response` (→ ArrayBuffer on the JS
/// side). See the section header for why this must not return `Vec<u8>`.
#[tauri::command]
pub fn read_file_range(
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, crate::AppError> {
    let bytes = read_file_range_bytes(&path, offset, length)?;
    Ok(tauri::ipc::Response::new(bytes))
}

// ────────────────────────────────────────────────────────────────────────
// LOCAL FRAME EXTRACTION (4K snapshots)
//
// Mirrors `extract_frame` (YouTube path) but skips yt-dlp entirely — the
// file is right there on disk. `-ss` BEFORE `-i` is a fast container seek
// (uses the index, not decode-from-start); for a single still that's
// accurate enough on any well-formed file and orders of magnitude faster.
// Output resolution = source resolution. 4K source → 4K snapshot.
// ────────────────────────────────────────────────────────────────────────
#[derive(Deserialize)]
pub struct ExtractLocalFrameArgs {
    pub input_path: String,
    pub timestamp_seconds: f64,
    pub dest: String,
}

#[tauri::command]
pub async fn extract_local_frame(
    app: AppHandle,
    args: ExtractLocalFrameArgs,
) -> Result<ExtractFrameResult, crate::AppError> {
    let in_path = PathBuf::from(&args.input_path);
    if !in_path.is_file() {
        return Err(format!("File not found: {}", args.input_path).into());
    }
    if args.timestamp_seconds < 0.0 {
        return Err("Timestamp must be non-negative".into());
    }
    let dest_path = PathBuf::from(&args.dest);
    if let Some(parent) = dest_path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Folder does not exist: {}", parent.display()).into());
        }
    }
    let ts = format!("{:.3}", args.timestamp_seconds);
    let ff = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("sidecar ffmpeg not found: {e}"))?;
    let out = ff
        .args([
            "-y",
            "-ss", &ts,
            "-i", &args.input_path,
            "-frames:v", "1",
            "-q:v", "1",
            &args.dest,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("(no detail)");
        return Err(format!("ffmpeg failed: {last}").into());
    }
    // ffmpeg sometimes exits 0 with no output (e.g. -ss past EOF, missing
    // video stream on what we thought was a video file). Belt-and-braces
    // assertion so the UI doesn't get a "Saved → …" for a non-existent
    // file path.
    match std::fs::metadata(&args.dest) {
        Ok(m) if m.len() > 0 => {}
        _ => return Err("ffmpeg reported success but produced no output file".into()),
    }
    // Re-probe the source so we can report the actual snapshot resolution
    // in the success notification (matches YouTube path's UX). Fresh
    // sidecar handle — tauri's Command isn't Clone.
    let (w, h, vcodec) = {
        let probe = app
            .shell()
            .sidecar("ffmpeg")
            .ok()
            .map(|c| c.args(["-hide_banner", "-i", args.input_path.as_str()]));
        if let Some(cmd) = probe {
            match cmd.output().await {
                Ok(o) => {
                    let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                    let (w, h, _fps, vc) = parse_ffmpeg_video(&stderr);
                    (w, h, vc)
                }
                Err(_) => (None, None, None),
            }
        } else {
            (None, None, None)
        }
    };
    Ok(ExtractFrameResult {
        path: args.dest,
        width: w,
        height: h,
        vcodec,
        format_id: None,
    })
}

// ────────────────────────────────────────────────────────────────────────
// LOCAL THUMBNAIL GENERATION
//
// Called once after import so the sidebar isn't a blank black square.
// Writes a small JPEG into the app cache (`saucebunny-thumb-<job>.jpg`) and
// returns its path — frontend converts to asset:// URL and slots it into
// `metadata.thumbnail`. The cache sweep already cleans these up on startup.
// ────────────────────────────────────────────────────────────────────────
#[derive(Deserialize)]
pub struct LocalThumbnailArgs {
    pub input_path: String,
    /// Duration in seconds — we pick min(5s, 10% of duration) so very
    /// short clips don't grab a black post-roll frame.
    pub duration_seconds: Option<f64>,
}

#[tauri::command]
pub async fn generate_local_thumbnail(
    app: AppHandle,
    args: LocalThumbnailArgs,
) -> Result<String, crate::AppError> {
    let in_path = PathBuf::from(&args.input_path);
    if !in_path.is_file() {
        return Err(format!("File not found: {}", args.input_path).into());
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;
    // Stable-per-file name keyed off (path, mtime). Re-importing the same
    // file reuses the cached thumbnail; editing the file invalidates it.
    let mtime = std::fs::metadata(&in_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    args.input_path.hash(&mut hasher);
    mtime.hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());
    let out_path = cache.join(format!("saucebunny-thumb-{key}.jpg"));
    if out_path.exists() {
        return Ok(out_path.to_string_lossy().to_string());
    }

    let ts_secs = match args.duration_seconds {
        Some(d) if d > 0.0 => (d * 0.10).clamp(0.0, 5.0),
        _ => 0.0,
    };
    let ts = format!("{:.3}", ts_secs);

    let ff = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("sidecar ffmpeg not found: {e}"))?;
    // Scale to a max width of 640 — sidebar thumb is ~280px, anything
    // larger is bandwidth waste. `force_original_aspect_ratio` keeps
    // portrait videos from being squished.
    let out = ff
        .args([
            "-y",
            "-ss", &ts,
            "-i", &args.input_path,
            "-frames:v", "1",
            "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
            "-q:v", "3",
            out_path.to_str().ok_or_else(|| crate::AppError::internal("thumb path not utf-8"))?,
        ])
        .output()
        .await
        .map_err(|e| format!("ffmpeg failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        let last = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("(no detail)");
        return Err(format!("thumbnail extraction failed: {last}").into());
    }
    // Same belt-and-braces check as extract_local_frame — ffmpeg can
    // return 0 with no output on weird files. Don't return a path to
    // nothing.
    match std::fs::metadata(&out_path) {
        Ok(m) if m.len() > 0 => {}
        _ => return Err("ffmpeg produced no thumbnail (likely no video stream or seek past EOF)".into()),
    }
    Ok(out_path.to_string_lossy().to_string())
}

// ────────────────────────────────────────────────────────────────────────
// PREPARE LOCAL FOR PLAYBACK
//
// WKWebView on macOS is finicky about which MP4s it'll decode in a <video>
// tag — files with non-standard chroma subsampling, missing faststart
// (moov atom at the end), unusual H.264 profiles, or HEVC just render as a
// black canvas while still reporting a valid duration. Rather than guess
// per-file, we always normalise imports through ffmpeg into a known-good
// MP4 (H.264 baseline-equivalent + yuv420p + faststart) using the
// hardware h264_videotoolbox encoder on Apple Silicon. For audio-only we
// drop straight to MP3.
//
// The original file is untouched — we keep its path for export/transcribe
// flows that should run against the source — but the player points at
// this prepared temp file.
// ────────────────────────────────────────────────────────────────────────

// ─── Playback color routing ──────────────────────────────────────────────
// WKWebView can only present 8-bit SDR: it has no 10-bit VideoFrame path
// (see the ProRes caveat in CLAUDE.md) and no HDR surface, so the prep
// transcode must cut bit depth / dynamic range itself. The old bare
// `-pix_fmt yuv420p` did that with an undithered swscale truncation (sky
// banding) and no tonemap (PQ/HLG washed out), at a flat 4M (blocky HD).
// Routing: 8-bit SDR keeps the untouched fast path; 10-bit SDR goes through
// zscale error-diffusion dither (dither kills banding); HDR is tonemapped
// to bt709 SDR because WKWebView is SDR-only, then dithered to 8-bit.

#[derive(Debug, Clone, Copy, PartialEq)]
enum PlaybackColorClass {
    Sdr8,
    Sdr10,
    Hdr,
}

#[derive(Default)]
struct PlaybackColorProbe {
    width: u32,
    height: u32,
    pix_fmt: Option<String>,
    color_space: Option<String>,
    color_transfer: Option<String>,
    color_primaries: Option<String>,
}

fn classify_playback_color(p: &PlaybackColorProbe) -> PlaybackColorClass {
    if matches!(p.color_transfer.as_deref(), Some("smpte2084" | "arib-std-b67")) {
        return PlaybackColorClass::Hdr;
    }
    let deep = p.pix_fmt.as_deref().is_some_and(|f| {
        ["9le", "9be", "10le", "10be", "12le", "12be", "14le", "14be", "16le", "16be"]
            .iter()
            .any(|d| f.contains(d))
    });
    if deep { PlaybackColorClass::Sdr10 } else { PlaybackColorClass::Sdr8 }
}

/// `-b:v` by long edge (portrait-safe). Local temp file — size is cheap,
/// starving h264_videotoolbox is what made HD/4K playback copies blocky.
fn playback_bitrate(width: u32, height: u32) -> &'static str {
    match width.max(height) {
        0..=1280 => "6M",
        1281..=1920 => "10M",
        1921..=2560 => "14M",
        _ => "20M",
    }
}

// Only names verified against the bundled zscale/setparams option tables
// are passed through; anything else gets the stated default — a close-but
// -assumed value beats zimg's hard "no path between colorspaces" abort on
// untagged frames.
fn safe_matrix<'a>(p: &'a PlaybackColorProbe, default: &'a str) -> &'a str {
    match p.color_space.as_deref() {
        Some(m @ ("bt709" | "bt470bg" | "smpte170m" | "smpte240m" | "bt2020nc" | "bt2020c")) => m,
        _ => default,
    }
}
fn safe_primaries<'a>(p: &'a PlaybackColorProbe, default: &'a str) -> &'a str {
    match p.color_primaries.as_deref() {
        Some(m @ ("bt709" | "bt470m" | "bt470bg" | "smpte170m" | "smpte240m" | "film" | "bt2020")) => m,
        _ => default,
    }
}
fn safe_sdr_transfer(p: &PlaybackColorProbe) -> &str {
    match p.color_transfer.as_deref() {
        Some(t @ ("bt709" | "bt470m" | "bt470bg" | "smpte170m" | "smpte240m")) => t,
        _ => "bt709",
    }
}

/// Encoder/filter args that replace the legacy `-pix_fmt yuv420p -b:v 4M`
/// pair in the video branch, plus a log label. `None` (probe failed) →
/// exactly the legacy args, so prep never fails harder than before.
fn playback_video_quality_args(probe: Option<&PlaybackColorProbe>) -> (Vec<String>, String) {
    let Some(p) = probe else {
        return (
            vec!["-pix_fmt".into(), "yuv420p".into(), "-b:v".into(), "4M".into()],
            "probe failed, legacy yuv420p @ 4M".into(),
        );
    };
    let br = playback_bitrate(p.width, p.height);
    let dims = format!("{}x{}", p.width, p.height);
    match classify_playback_color(p) {
        PlaybackColorClass::Sdr8 => (
            vec!["-pix_fmt".into(), "yuv420p".into(), "-b:v".into(), br.into()],
            format!("sdr-8bit fast path ({dims} @ {br})"),
        ),
        PlaybackColorClass::Sdr10 => {
            // Same colorimetry in and out — only depth (and chroma) change,
            // with error-diffusion dither. min= doubles as the assumption
            // for untagged frames; setparams stamps tags the encoder keeps.
            let mtx = safe_matrix(p, "bt709");
            let prim = safe_primaries(p, "bt709");
            let trc = safe_sdr_transfer(p);
            let vf = format!(
                "zscale=min={mtx}:m={mtx}:dither=error_diffusion,format=yuv420p,setparams=colorspace={mtx}:color_primaries={prim}:color_trc={trc}"
            );
            (
                vec![
                    "-vf".into(), vf,
                    "-colorspace".into(), mtx.into(),
                    "-color_primaries".into(), prim.into(),
                    "-color_trc".into(), trc.into(),
                    "-b:v".into(), br.into(),
                ],
                format!(
                    "sdr-10bit dithered ({}, {dims} @ {br})",
                    p.pix_fmt.as_deref().unwrap_or("?")
                ),
            )
        }
        PlaybackColorClass::Hdr => {
            // PQ/HLG → linear light → hable tonemap → bt709 SDR, dithered
            // to 8-bit. HDR defaults are bt2020 — virtually every HDR file.
            let tin = p.color_transfer.as_deref().unwrap_or("smpte2084");
            let pin = safe_primaries(p, "bt2020");
            let min = safe_matrix(p, "bt2020nc");
            let vf = format!(
                "zscale=tin={tin}:pin={pin}:min={min}:t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=error_diffusion,format=yuv420p"
            );
            (
                vec![
                    "-vf".into(), vf,
                    "-colorspace".into(), "bt709".into(),
                    "-color_primaries".into(), "bt709".into(),
                    "-color_trc".into(), "bt709".into(),
                    "-b:v".into(), br.into(),
                ],
                format!("hdr tonemap → sdr ({tin}, {dims} @ {br})"),
            )
        }
    }
}

/// Best-effort v:0 probe for the prep transcode. `None` on any failure —
/// the caller falls back to the legacy args rather than failing the prep.
async fn probe_playback_color(app: &AppHandle, path: &str) -> Option<PlaybackColorProbe> {
    let v = ffprobe_json(app, &[
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,pix_fmt,color_space,color_transfer,color_primaries",
        "-print_format", "json", path,
    ]).await.ok()?;
    let s = v.get("streams")?.as_array()?.first()?;
    Some(PlaybackColorProbe {
        width: s.get("width").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        height: s.get("height").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        pix_fmt: jstr(s, "pix_fmt"),
        color_space: jstr(s, "color_space"),
        color_transfer: jstr(s, "color_transfer"),
        color_primaries: jstr(s, "color_primaries"),
    })
}

#[derive(Deserialize)]
pub struct PreparePlaybackArgs {
    pub input_path: String,
    /// True if the source has a video stream. Drives the codec choice
    /// (transcoded H.264 MP4 vs. MP3 audio-only).
    pub has_video: bool,
    /// Total duration in seconds — lets us emit accurate % progress by
    /// parsing ffmpeg's `time=HH:MM:SS.MS` stderr lines.
    pub duration_seconds: Option<f64>,
    pub job_id: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct PreparePlaybackDone {
    pub(crate) job_id: String,
    pub(crate) success: bool,
    pub(crate) path: Option<String>,
    pub(crate) error: Option<String>,
}

#[tauri::command]
pub async fn prepare_local_for_playback(
    app: AppHandle,
    args: PreparePlaybackArgs,
) -> Result<String, crate::AppError> {
    let in_path = PathBuf::from(&args.input_path);
    if !in_path.is_file() {
        return Err(format!("Input not found: {}", args.input_path).into());
    }

    // Stage the output inside the app cache so a) we can delete on demand
    // and b) it survives the WebView's range-request access checks (which
    // are strict about scoped paths).
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;
    let ext = if args.has_video { "mp4" } else { "mp3" };
    let out_path = cache.join(format!("saucebunny-playback-{}.{}", args.job_id, ext));
    let out_str = out_path
        .to_str()
        .ok_or_else(|| crate::AppError::internal("playback path not utf-8"))?
        .to_string();

    let ffmpeg = sidecar_path("ffmpeg")?;
    if !ffmpeg.exists() {
        return Err(format!("ffmpeg sidecar missing at {}", ffmpeg.display()).into());
    }

    // Argument list — split video vs. audio path:
    //   • Video: h264_videotoolbox is the hardware encoder on macOS.
    //     5–15× real time on Apple Silicon. yuv420p is the one pixel format
    //     WKWebView reliably renders — depth/HDR reduction is routed per
    //     source by `playback_video_quality_args` (see the color-routing
    //     block above). +faststart moves the moov atom to the head of the
    //     file so progressive playback works without a full download.
    //   • Audio: libmp3lame is universal in WebKit; we keep 320 kbps so
    //     audio quality is preserved.
    let mut cmd_args: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(), // overwrite any leftover from a prior aborted run
        "-i".into(),
        args.input_path.clone(),
    ];
    if args.has_video {
        let probe = probe_playback_color(&app, &args.input_path).await;
        let (quality_args, color_label) = playback_video_quality_args(probe.as_ref());
        let _ = app.emit("playback-prep-log", LogEvent {
            job_id: args.job_id.clone(),
            stream: "stderr".into(),
            tag: "info".into(),
            line: format!("[playback-prep] color path: {color_label}"),
        });
        cmd_args.extend([
            "-map".into(), "0:v:0".into(),
            "-map".into(), "0:a:0?".into(), // optional audio track
            "-c:v".into(), "h264_videotoolbox".into(),
        ]);
        cmd_args.extend(quality_args);
        cmd_args.extend([
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "160k".into(),
            "-movflags".into(), "+faststart".into(),
            // Emit a regular `time=` progress line ffmpeg-style.
            "-progress".into(), "pipe:2".into(),
            "-nostats".into(),
        ]);
    } else {
        cmd_args.extend([
            "-vn".into(),
            "-c:a".into(), "libmp3lame".into(),
            "-b:a".into(), "320k".into(),
            "-progress".into(), "pipe:2".into(),
            "-nostats".into(),
        ]);
    }
    cmd_args.push(out_str.clone());

    let cmd = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar: {e}"))?;
    let (mut rx, child) = cmd
        .args(cmd_args)
        .spawn()
        .map_err(|e| format!("failed to spawn ffmpeg: {e}"))?;
    app.state::<JobRegistry>().insert(args.job_id.clone(), child);

    let app_for = app.clone();
    let job_for = args.job_id.clone();
    let total_seconds = args.duration_seconds.unwrap_or(0.0);
    let out_for = out_str.clone();

    tokio::spawn(async move {
        let mut last_emit = std::time::Instant::now() - std::time::Duration::from_millis(500);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let line = line.trim_end();
                        if line.is_empty() { continue; }
                        if is_ffmpeg_progress(line) {
                            if total_seconds > 0.0 {
                                if let Some(t) = parse_ffmpeg_time(line) {
                                    let pct = ((t / total_seconds) * 100.0).clamp(0.0, 100.0);
                                    if last_emit.elapsed().as_millis() >= 100 {
                                        last_emit = std::time::Instant::now();
                                        let _ = app_for.emit("playback-prep-progress", ProgressEvent {
                                            job_id: job_for.clone(), percent: pct,
                                        });
                                    }
                                }
                            }
                            // Don't spam logs with progress lines.
                            continue;
                        }
                        // Surface meaningful ffmpeg log lines on the
                        // playback-prep channel — the frontend gates the
                        // clip-log listener on jobIdRef (export job), so
                        // using a dedicated channel keeps the streams
                        // separate and the pipeline panel uncluttered.
                        let _ = app_for.emit("playback-prep-log", LogEvent {
                            job_id: job_for.clone(),
                            stream: "stderr".into(),
                            tag: "info".into(),
                            line: format!("[playback-prep] {}", line),
                        });
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_for.state::<JobRegistry>().take(&job_for);
                    let success = payload.code == Some(0);
                    let _ = app_for.emit("playback-prep-done", PreparePlaybackDone {
                        job_id: job_for.clone(),
                        success,
                        path: if success { Some(out_for.clone()) } else { None },
                        error: if success {
                            None
                        } else if payload.signal.is_some() {
                            Some("Cancelled".into())
                        } else {
                            Some(format!("ffmpeg exited with code {:?}", payload.code))
                        },
                    });
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(args.job_id)
}

// ─── Deep media inspector (r96) ──────────────────────────────────────────────
// Everything the source panel's quick probe doesn't show: exact codec/profile/
// fourcc, pixel format + bit depth, precise (rational) frame rate + VFR flag,
// color space, embedded timecode, audio layout — plus two sampled-packet
// analyses ffprobe won't state directly: VBR-vs-CBR (bitrate variation across
// ~1s buckets) and whether the stream is all-intra (every frame a keyframe,
// e.g. ProRes/DNxHD — the "every frame is a picture" property).

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaInfoVideo {
    pub codec: String,
    /// Container fourcc, e.g. `apch` = ProRes 422 HQ.
    pub codec_tag: Option<String>,
    pub profile: Option<String>,
    pub width: u32,
    pub height: u32,
    pub pix_fmt: Option<String>,
    pub bit_depth: Option<u32>,
    /// ffprobe field_order: "progressive", "tt", "bb", "tb", "bt", or unknown.
    pub field_order: Option<String>,
    pub fps: Option<f64>,
    /// The exact rational, e.g. "30000/1001".
    pub fps_exact: Option<String>,
    /// True when avg_frame_rate ≠ r_frame_rate (variable frame rate).
    pub vfr: bool,
    pub bitrate_bps: Option<f64>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    pub nb_frames: Option<f64>,
    /// Every sampled packet is a keyframe (I-frame-only codec).
    pub all_intra: Option<bool>,
    pub keyframe_ratio: Option<f64>,
    /// Bitrate varies across ~1s windows (sampled) → VBR.
    pub vbr: Option<bool>,
    /// Coefficient of variation of per-window byte totals (0 = perfectly constant).
    pub bitrate_cv: Option<f64>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaInfoAudio {
    pub codec: String,
    pub channels: u32,
    pub channel_layout: Option<String>,
    pub sample_rate: Option<u32>,
    pub sample_fmt: Option<String>,
    pub bitrate_bps: Option<f64>,
    pub vbr: Option<bool>,
    pub bitrate_cv: Option<f64>,
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaInfo {
    pub container: String,
    pub duration_s: Option<f64>,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub overall_bitrate_bps: Option<f64>,
    /// Embedded start timecode (QuickTime tmcd / format tag), if any.
    pub timecode: Option<String>,
    pub video: Option<MediaInfoVideo>,
    pub audio: Option<MediaInfoAudio>,
}

/// "30000/1001" → 29.97…; None for zero/invalid denominators.
fn parse_ratio(s: &str) -> Option<f64> {
    let (n, d) = s.split_once('/')?;
    let n: f64 = n.trim().parse().ok()?;
    let d: f64 = d.trim().parse().ok()?;
    if d == 0.0 || !n.is_finite() || !d.is_finite() { return None; }
    Some(n / d)
}

/// Coefficient of variation (stddev/mean) of packet-size sums over fixed-count
/// buckets — a bitrate-over-time steadiness measure. None when there aren't at
/// least 3 full buckets to compare.
fn bucket_cv(sizes: &[u64], bucket: usize) -> Option<f64> {
    if bucket == 0 { return None; }
    let sums: Vec<f64> = sizes
        .chunks(bucket)
        .filter(|c| c.len() == bucket) // drop the partial tail bucket
        .map(|c| c.iter().map(|&s| s as f64).sum())
        .collect();
    if sums.len() < 3 { return None; }
    let mean = sums.iter().sum::<f64>() / sums.len() as f64;
    if mean <= 0.0 { return None; }
    let var = sums.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / sums.len() as f64;
    Some(var.sqrt() / mean)
}

/// Bitrate steadier than ±10% across windows reads as CBR; above it, VBR.
const VBR_CV_THRESHOLD: f64 = 0.10;

async fn ffprobe_json(app: &AppHandle, args: &[&str]) -> Result<serde_json::Value, crate::AppError> {
    let cmd = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| format!("ffprobe sidecar: {e}"))?;
    let out = cmd
        .args(args)
        .output()
        .await
        .map_err(|e| format!("ffprobe failed to run: {e}"))?;
    serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe returned no JSON: {e}").into())
}

fn jstr(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}
fn jnum_from_str(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|x| x.as_str()).and_then(|s| s.parse().ok())
}

/// Sampled packet sizes + keyframe count for one stream. `None` (not an error)
/// when the sample pass fails — the basic info is still worth returning.
async fn sample_packets(app: &AppHandle, path: &str, stream: &str, count: usize) -> Option<(Vec<u64>, usize)> {
    let interval = format!("%+#{count}");
    let v = ffprobe_json(app, &[
        "-v", "error", "-select_streams", stream,
        "-show_entries", "packet=size,flags",
        "-read_intervals", &interval,
        "-print_format", "json", path,
    ]).await.ok()?;
    let packets = v.get("packets")?.as_array()?;
    let mut sizes = Vec::with_capacity(packets.len());
    let mut keyframes = 0usize;
    for p in packets {
        if let Some(sz) = jnum_from_str(p, "size") { sizes.push(sz as u64); }
        if jstr(p, "flags").is_some_and(|f| f.contains('K')) { keyframes += 1; }
    }
    if sizes.is_empty() { return None; }
    Some((sizes, keyframes))
}

#[tauri::command]
pub async fn probe_media_info(app: AppHandle, path: String) -> Result<MediaInfo, crate::AppError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}").into());
    }
    let size_bytes = p.metadata().map(|m| m.len()).unwrap_or(0);

    let root = ffprobe_json(&app, &[
        "-v", "error", "-print_format", "json", "-show_format", "-show_streams", &path,
    ]).await?;

    let format = root.get("format").cloned().unwrap_or_default();
    let empty = Vec::new();
    let streams = root.get("streams").and_then(|s| s.as_array()).unwrap_or(&empty);

    // Timecode: format tag first, else any stream's (QuickTime puts it on tmcd).
    let timecode = format
        .get("tags").and_then(|t| jstr(t, "timecode"))
        .or_else(|| streams.iter().find_map(|s| s.get("tags").and_then(|t| jstr(t, "timecode"))));

    let vstream = streams.iter().find(|s| jstr(s, "codec_type").as_deref() == Some("video"));
    let astream = streams.iter().find(|s| jstr(s, "codec_type").as_deref() == Some("audio"));

    let mut video = vstream.map(|s| {
        let avg = jstr(s, "avg_frame_rate");
        let real = jstr(s, "r_frame_rate");
        let fps = avg.as_deref().and_then(parse_ratio).filter(|f| *f > 0.0)
            .or_else(|| real.as_deref().and_then(parse_ratio));
        // VFR: the container's nominal tick rate disagrees with the measured
        // average — the classic screen-recording / phone-footage signature.
        let vfr = match (avg.as_deref().and_then(parse_ratio), real.as_deref().and_then(parse_ratio)) {
            (Some(a), Some(r)) if a > 0.0 && r > 0.0 => (a - r).abs() / r > 0.001,
            _ => false,
        };
        MediaInfoVideo {
            codec: jstr(s, "codec_long_name").or_else(|| jstr(s, "codec_name")).unwrap_or_else(|| "unknown".into()),
            codec_tag: jstr(s, "codec_tag_string").filter(|t| t != "[0][0][0][0]"),
            profile: jstr(s, "profile"),
            width: s.get("width").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            height: s.get("height").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            pix_fmt: jstr(s, "pix_fmt"),
            bit_depth: jnum_from_str(s, "bits_per_raw_sample").map(|b| b as u32),
            field_order: jstr(s, "field_order"),
            fps,
            fps_exact: avg.filter(|a| a != "0/0"),
            vfr,
            bitrate_bps: jnum_from_str(s, "bit_rate"),
            color_space: jstr(s, "color_space"),
            color_transfer: jstr(s, "color_transfer"),
            color_primaries: jstr(s, "color_primaries"),
            nb_frames: jnum_from_str(s, "nb_frames"),
            all_intra: None,
            keyframe_ratio: None,
            vbr: None,
            bitrate_cv: None,
        }
    });

    let mut audio = astream.map(|s| MediaInfoAudio {
        codec: jstr(s, "codec_long_name").or_else(|| jstr(s, "codec_name")).unwrap_or_else(|| "unknown".into()),
        channels: s.get("channels").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
        channel_layout: jstr(s, "channel_layout"),
        sample_rate: jnum_from_str(s, "sample_rate").map(|r| r as u32),
        sample_fmt: jstr(s, "sample_fmt"),
        bitrate_bps: jnum_from_str(s, "bit_rate"),
        vbr: None,
        bitrate_cv: None,
    });

    // Sampled-packet analysis — best-effort; the basic info stands without it.
    if let Some(v) = video.as_mut() {
        if let Some((sizes, keyframes)) = sample_packets(&app, &path, "v:0", 240).await {
            let total = sizes.len();
            v.keyframe_ratio = Some(keyframes as f64 / total as f64);
            // Only call it all-intra off a meaningful sample.
            v.all_intra = Some(total >= 24 && keyframes == total);
            let bucket = v.fps.map(|f| f.round() as usize).filter(|b| *b >= 5).unwrap_or(30);
            v.bitrate_cv = bucket_cv(&sizes, bucket);
            v.vbr = v.bitrate_cv.map(|cv| cv > VBR_CV_THRESHOLD);
        }
    }
    if let Some(a) = audio.as_mut() {
        if let Some((sizes, _)) = sample_packets(&app, &path, "a:0", 500).await {
            a.bitrate_cv = bucket_cv(&sizes, 100);
            a.vbr = a.bitrate_cv.map(|cv| cv > VBR_CV_THRESHOLD);
        }
    }

    Ok(MediaInfo {
        container: jstr(&format, "format_long_name").or_else(|| jstr(&format, "format_name")).unwrap_or_else(|| "unknown".into()),
        duration_s: jnum_from_str(&format, "duration"),
        size_bytes,
        overall_bitrate_bps: jnum_from_str(&format, "bit_rate"),
        timecode,
        video,
        audio,
    })
}

#[cfg(test)]
mod playback_color_tests {
    use super::{
        classify_playback_color, playback_bitrate, playback_video_quality_args,
        PlaybackColorClass, PlaybackColorProbe,
    };

    fn probe(
        w: u32, h: u32,
        pix_fmt: Option<&str>, space: Option<&str>, transfer: Option<&str>, primaries: Option<&str>,
    ) -> PlaybackColorProbe {
        PlaybackColorProbe {
            width: w,
            height: h,
            pix_fmt: pix_fmt.map(Into::into),
            color_space: space.map(Into::into),
            color_transfer: transfer.map(Into::into),
            color_primaries: primaries.map(Into::into),
        }
    }

    #[test]
    fn classifies_hdr_by_transfer_regardless_of_depth() {
        for trc in ["smpte2084", "arib-std-b67"] {
            let p = probe(3840, 2160, Some("yuv422p10le"), Some("bt2020nc"), Some(trc), Some("bt2020"));
            assert_eq!(classify_playback_color(&p), PlaybackColorClass::Hdr, "{trc}");
        }
        // 8-bit HLG is still HDR — the tonemap is about transfer, not depth.
        let p = probe(1920, 1080, Some("yuv420p"), None, Some("arib-std-b67"), None);
        assert_eq!(classify_playback_color(&p), PlaybackColorClass::Hdr);
    }

    #[test]
    fn classifies_deep_sdr_by_pix_fmt() {
        for f in ["yuv422p10le", "yuv420p10le", "p010le", "yuv444p12le", "yuv420p16be"] {
            let p = probe(1920, 1080, Some(f), Some("bt709"), Some("bt709"), Some("bt709"));
            assert_eq!(classify_playback_color(&p), PlaybackColorClass::Sdr10, "{f}");
        }
    }

    #[test]
    fn classifies_plain_and_unknown_as_sdr8() {
        let p = probe(1920, 1080, Some("yuv420p"), Some("bt709"), Some("bt709"), Some("bt709"));
        assert_eq!(classify_playback_color(&p), PlaybackColorClass::Sdr8);
        // No color/pix_fmt info at all → don't invent a slow path.
        let p = probe(1920, 1080, None, None, None, None);
        assert_eq!(classify_playback_color(&p), PlaybackColorClass::Sdr8);
    }

    #[test]
    fn bitrate_ladder_by_long_edge() {
        assert_eq!(playback_bitrate(1280, 720), "6M");
        assert_eq!(playback_bitrate(1920, 1080), "10M");
        assert_eq!(playback_bitrate(1080, 1920), "10M"); // portrait 1080p
        assert_eq!(playback_bitrate(2560, 1440), "14M");
        assert_eq!(playback_bitrate(3840, 2160), "20M");
        assert_eq!(playback_bitrate(0, 0), "6M"); // degenerate probe → floor
    }

    #[test]
    fn no_probe_keeps_legacy_args_exactly() {
        let (args, label) = playback_video_quality_args(None);
        assert_eq!(args, vec!["-pix_fmt", "yuv420p", "-b:v", "4M"]);
        assert!(label.contains("legacy"));
    }

    #[test]
    fn sdr8_fast_path_scales_bitrate_only() {
        let p = probe(3840, 2160, Some("yuv420p"), Some("bt709"), Some("bt709"), Some("bt709"));
        let (args, _) = playback_video_quality_args(Some(&p));
        assert_eq!(args, vec!["-pix_fmt", "yuv420p", "-b:v", "20M"]);
    }

    #[test]
    fn hdr_gets_tonemap_chain_and_bt709_tags() {
        let p = probe(3840, 2160, Some("yuv422p10le"), Some("bt2020nc"), Some("smpte2084"), Some("bt2020"));
        let (args, label) = playback_video_quality_args(Some(&p));
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert_eq!(
            vf,
            "zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:t=linear:npl=100,tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=error_diffusion,format=yuv420p"
        );
        for pair in [["-colorspace", "bt709"], ["-color_primaries", "bt709"], ["-color_trc", "bt709"], ["-b:v", "20M"]] {
            let i = args.iter().position(|a| a == pair[0]).unwrap();
            assert_eq!(args[i + 1], pair[1]);
        }
        assert!(label.contains("hdr"));
    }

    #[test]
    fn hdr_with_missing_tags_assumes_bt2020() {
        let p = probe(1920, 1080, Some("yuv420p10le"), None, Some("arib-std-b67"), None);
        let (args, _) = playback_video_quality_args(Some(&p));
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert!(vf.starts_with("zscale=tin=arib-std-b67:pin=bt2020:min=bt2020nc:t=linear"));
    }

    #[test]
    fn sdr10_dithers_and_preserves_probed_colorimetry() {
        let p = probe(1920, 1080, Some("yuv422p10le"), Some("smpte170m"), Some("smpte170m"), Some("smpte170m"));
        let (args, label) = playback_video_quality_args(Some(&p));
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert_eq!(
            vf,
            "zscale=min=smpte170m:m=smpte170m:dither=error_diffusion,format=yuv420p,setparams=colorspace=smpte170m:color_primaries=smpte170m:color_trc=smpte170m"
        );
        assert!(!vf.contains("tonemap"));
        for pair in [["-colorspace", "smpte170m"], ["-b:v", "10M"]] {
            let i = args.iter().position(|a| a == pair[0]).unwrap();
            assert_eq!(args[i + 1], pair[1]);
        }
        assert!(label.contains("sdr-10bit"));
    }

    #[test]
    fn sdr10_untagged_or_exotic_defaults_to_bt709() {
        // Untagged frames abort zimg without an explicit min= assumption.
        let p = probe(1280, 720, Some("yuv422p10le"), None, None, None);
        let (args, _) = playback_video_quality_args(Some(&p));
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert!(vf.starts_with("zscale=min=bt709:m=bt709:dither=error_diffusion"));
        // A matrix zscale doesn't know must not be passed through verbatim.
        let p = probe(1280, 720, Some("yuv422p10le"), Some("ycgco"), None, None);
        let (args, _) = playback_video_quality_args(Some(&p));
        let vf = &args[args.iter().position(|a| a == "-vf").unwrap() + 1];
        assert!(vf.starts_with("zscale=min=bt709:m=bt709:"));
    }
}

#[cfg(test)]
mod file_range_tests {
    use super::read_file_range_bytes;

    #[test]
    fn reads_middle_range_and_clamps_at_eof() {
        // 256-byte file where byte value == index, so slices are easy to assert.
        let data: Vec<u8> = (0..=255u8).collect();
        let path = std::env::temp_dir()
            .join(format!("saucebunny-range-test-{}.bin", std::process::id()));
        std::fs::write(&path, &data).unwrap();
        let p = path.to_string_lossy().to_string();

        // Middle slice [100, 110) → exactly 10 bytes, values 100..110.
        assert_eq!(
            read_file_range_bytes(&p, 100, 10).unwrap(),
            (100..110).collect::<Vec<u8>>()
        );
        // Whole file.
        assert_eq!(read_file_range_bytes(&p, 0, 256).unwrap(), data);
        // Runs past EOF → clamped to the 6 bytes that exist (250..=255).
        assert_eq!(
            read_file_range_bytes(&p, 250, 20).unwrap(),
            (250..=255).collect::<Vec<u8>>()
        );
        // Offset exactly at EOF → empty buffer, not an error.
        assert!(read_file_range_bytes(&p, 256, 10).unwrap().is_empty());

        let _ = std::fs::remove_file(&path);
    }
}

#[cfg(test)]
mod media_info_tests {
    use super::{bucket_cv, parse_ratio};

    #[test]
    fn ratio_parses_ntsc_and_rejects_garbage() {
        assert!((parse_ratio("30000/1001").unwrap() - 29.97).abs() < 0.01);
        assert_eq!(parse_ratio("25/1"), Some(25.0));
        assert_eq!(parse_ratio("0/0"), None);
        assert_eq!(parse_ratio("abc"), None);
        assert_eq!(parse_ratio("30"), None);
    }

    #[test]
    fn constant_bitrate_has_near_zero_cv() {
        let sizes = vec![1000u64; 120];
        let cv = bucket_cv(&sizes, 30).unwrap();
        assert!(cv < 1e-9, "cv={cv}");
    }

    #[test]
    fn variable_bitrate_has_high_cv() {
        // Alternate 1s windows of small and large packets.
        let mut sizes = Vec::new();
        for i in 0..120u64 {
            sizes.push(if (i / 30) % 2 == 0 { 500 } else { 5000 });
        }
        let cv = bucket_cv(&sizes, 30).unwrap();
        assert!(cv > 0.5, "cv={cv}");
    }

    #[test]
    fn cv_needs_at_least_three_full_buckets() {
        assert_eq!(bucket_cv(&[1000u64; 59], 30), None); // only 1 full bucket
        assert_eq!(bucket_cv(&[1000u64; 89], 30), None); // only 2 full
        assert!(bucket_cv(&[1000u64; 90], 30).is_some()); // exactly 3
        assert_eq!(bucket_cv(&[], 30), None);
        assert_eq!(bucket_cv(&[1000], 0), None);
    }
}

