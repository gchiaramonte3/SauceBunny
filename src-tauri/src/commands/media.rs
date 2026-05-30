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
) -> Result<(), String> {
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
    cmd_args.extend(cookies_args(args.cookies_browser.as_deref()));
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
    cmd_args.push(args.url);

    let cmd = ytdlp(&app)?;
    let (mut rx, child) = cmd
        .args(cmd_args)
        .spawn()
        .map_err(|e| format!("failed to spawn yt-dlp: {e}"))?;
    app.state::<JobRegistry>().insert(job_id.clone(), child);

    let app_for = app.clone();
    let job_for = job_id.clone();
    let output_for = output_str.clone();
    let total_seconds = section_secs.map(|(s, e)| (e - s).max(0.0)).unwrap_or(0.0);

    tokio::spawn(async move {
        run_clip_loop(&app_for, &job_for, &mut rx, total_seconds, &output_for).await;
    });
    Ok(())
}

async fn spawn_audio_clip(
    app: AppHandle,
    job_id: String,
    url: String,
    section_secs: Option<(f64, f64)>,
    output_str: String,
    ffmpeg_str: String,
    cookies_browser: Option<String>,
) -> Result<(), String> {
    // Phase 1: yt-dlp downloads raw bestaudio to cache.
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;
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

/// The streaming receiver loop used by the video clip path. Parses progress
/// (% and ffmpeg time=) and throttles chatty log lines.
async fn run_clip_loop(
    app: &AppHandle,
    job_id: &str,
    rx: &mut tokio::sync::mpsc::Receiver<CommandEvent>,
    total_seconds: f64,
    output_path: &str,
) {
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
                let success = payload.code == Some(0);
                let path = if success { Some(output_path.to_string()) } else { None };
                let cancelled = matches!(payload.code, Some(c) if c != 0)
                    && std::path::Path::new(output_path).metadata().is_err();
                let error = if success {
                    None
                } else if cancelled {
                    Some("Cancelled".into())
                } else if saw_auth_error {
                    Some(YT_AUTH_HINT.into())
                } else {
                    Some(format!("yt-dlp exited with code {:?}", payload.code))
                };
                emit_clip_done(app, job_id, success, payload.code, path, error);
                break;
            }
            _ => {}
        }
    }
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
    } else if l.starts_with("[download]") {
        "info".into()
    } else if l.starts_with("[") {
        "info".into()
    } else {
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
            .and_then(|s| s.split(|c: char| c == ' ' || c == ',' || c == '(').next())
            .map(|s| s.to_string());
        // WxH
        let mut w: Option<u32> = None;
        let mut h: Option<u32> = None;
        // Scan tokens for "WxH" where W,H are digits
        for tok in line.split(|c: char| c == ' ' || c == ',' || c == '[' || c == ']') {
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
            .and_then(|s| s.split(|c: char| c == ' ' || c == ',' || c == '(').next())
            .map(|s| s.to_string());
    }
    None
}

#[tauri::command]
pub async fn probe_local_file(app: AppHandle, path: String) -> Result<LocalFileMeta, crate::AppError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("File not found: {path}").into());
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
        Some(d) if d > 0.0 => (d * 0.10).min(5.0).max(0.0),
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
    //     WKWebView reliably renders. +faststart moves the moov atom to the
    //     head of the file so progressive playback works without a full
    //     download.
    //   • Audio: libmp3lame is universal in WebKit; we keep 320 kbps so
    //     audio quality is preserved.
    let mut cmd_args: Vec<String> = vec![
        "-hide_banner".into(),
        "-y".into(), // overwrite any leftover from a prior aborted run
        "-i".into(),
        args.input_path.clone(),
    ];
    if args.has_video {
        cmd_args.extend([
            "-map".into(), "0:v:0".into(),
            "-map".into(), "0:a:0?".into(), // optional audio track
            "-c:v".into(), "h264_videotoolbox".into(),
            "-pix_fmt".into(), "yuv420p".into(),
            "-b:v".into(), "4M".into(),
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

