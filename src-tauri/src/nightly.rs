//! Shared support for the NIGHTLY real-sidecar smoke tests.
//!
//! Per-push CI stubs every sidecar binary, so the riskiest code — the whisper
//! invocation flags, the ffmpeg playback-prep/fMP4-remux arg surfaces, the
//! yt-dlp flag surface — has no automated coverage there. The nightly job
//! (`.github/workflows/nightly-sidecars.yml`) assembles the REAL binaries and
//! runs the `#[ignore]`-tagged `nightly_*` tests, which exercise the exact
//! production arg-builders (`whisper_cli_args`, `wav_16k_mono_args`,
//! `playback_prep_args`, `serve_fmp4`) against them.
//!
//! Run locally (needs `npm run setup` first; downloads the tiny.en + Silero
//! VAD models to `~/.cache/sauce-bunny/nightly/` on first run, ~78 MB total):
//!
//! ```sh
//! cd src-tauri && cargo test --lib nightly_ -- --ignored --test-threads=1
//! ```
//!
//! This module is `#[cfg(test)]`-gated at the `mod` declaration in lib.rs —
//! none of it exists in the shipped binary.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Resolve a bundled sidecar and refuse to proceed if it's missing or a
/// zero-byte CI stub — the nightly tests are meaningless without the real
/// binary.
pub(crate) fn sidecar(name: &str) -> PathBuf {
    let p = crate::commands::sidecar_path(name)
        .unwrap_or_else(|e| panic!("sidecar_path({name}): {e:?}"));
    let real = p.metadata().map(|m| m.len() > 0).unwrap_or(false);
    assert!(
        real,
        "{name} sidecar missing or stubbed at {} — run `npm run setup` (or the \
         nightly workflow's sidecar steps) before the nightly tests",
        p.display()
    );
    p
}

/// Run a command and assert it exits 0, dumping stderr into the panic message
/// otherwise.
pub(crate) fn run_ok<I, S>(bin: &Path, args: I, what: &str) -> Output
where
    I: IntoIterator<Item = S>,
    S: AsRef<std::ffi::OsStr>,
{
    let out = Command::new(bin)
        .args(args)
        .output()
        .unwrap_or_else(|e| panic!("{what}: failed to spawn {}: {e}", bin.display()));
    assert!(
        out.status.success(),
        "{what} exited with {:?}\nstderr:\n{}",
        out.status.code(),
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

/// Deterministic fixture directory, reused across tests and runs. Version-
/// tagged so changing a fixture recipe below means bumping the tag (stale
/// files regenerate instead of poisoning the run).
pub(crate) fn scratch_dir() -> PathBuf {
    let dir = std::env::temp_dir().join("sauce-bunny-nightly-v2");
    std::fs::create_dir_all(&dir).expect("create nightly scratch dir");
    dir
}

fn fresh(p: &Path) -> bool {
    p.metadata().map(|m| m.len() > 0).unwrap_or(false)
}

fn utf8(p: &Path) -> &str {
    p.to_str().expect("nightly paths are utf-8")
}

// ─── Fixtures (generated with the real, fetched ffmpeg) ─────────────────────

/// 5-second SDR H.264+AAC MP4: testsrc2 picture + 440 Hz sine, faststart,
/// keyframe every second (`-g 30`) so `?start=` seeks land mid-file.
pub(crate) fn fixture_av() -> PathBuf {
    let out = scratch_dir().join("av-sdr.mp4");
    if fresh(&out) {
        return out;
    }
    run_ok(
        &sidecar("ffmpeg"),
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=5:size=640x360:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
            "-c:v", "libx264", "-preset", "veryfast",
            "-g", "30", "-keyint_min", "30",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k",
            "-shortest",
            "-movflags", "+faststart",
            utf8(&out),
        ],
        "generate SDR AV fixture",
    );
    out
}

/// A LONG H.264+AAC MP4 (600s), small and cheap to encode, with a keyframe
/// every two seconds.
///
/// The 5-second fixture above cannot exercise the thing a seek report is
/// actually about: a scrub across a feature-length source, where every landing
/// is out of buffer and each one costs a pipeline rebuild. This one is long
/// enough to seek minutes into and small enough to generate in seconds.
///
/// Used by the live seek session harness, which drives the REAL player in a
/// REAL browser against the REAL proxy and prints the seek log a user would
/// see. That harness exists because a report of "a major regression in seeking
/// and scrubbing" was answered twice from reading and once from unit tests,
/// and none of those is the same thing as watching it happen.
pub(crate) fn fixture_av_long() -> PathBuf {
    let out = scratch_dir().join("av-long-600s.mp4");
    if fresh(&out) {
        return out;
    }
    run_ok(
        &sidecar("ffmpeg"),
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=600:size=320x180:rate=24",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=600",
            "-c:v", "libx264", "-preset", "ultrafast",
            // A keyframe every 2s: far enough apart to be realistic, close
            // enough that a seek lands within a couple of seconds of the ask.
            "-g", "48", "-keyint_min", "48",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "64k",
            "-shortest",
            "-movflags", "+faststart",
            utf8(&out),
        ],
        "generate long AV fixture",
    );
    out
}

/// 5-second 10-bit ProRes 422 HQ (`apch`) tagged BT.2020/PQ — the exact
/// source class CLAUDE.md's "ProRes / 10-bit caveat" routes through the
/// ffmpeg playback copy because WKWebView can't paint 10-bit VideoFrames.
/// prores_ks is ffmpeg's built-in encoder, so this needs no external lib.
pub(crate) fn fixture_hdr_prores() -> PathBuf {
    let out = scratch_dir().join("hdr-prores-hq.mov");
    if fresh(&out) {
        return out;
    }
    run_ok(
        &sidecar("ffmpeg"),
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=5:size=640x360:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
            // prores_ks writes the colr atom from FRAME-level color props, so
            // the tags must ride on the frames (setparams), not the output
            // options — `-color_trc smpte2084` alone leaves the file untagged.
            "-vf", "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
            "-c:v", "prores_ks", "-profile:v", "3",
            "-pix_fmt", "yuv422p10le",
            "-c:a", "pcm_s16le",
            "-shortest",
            utf8(&out),
        ],
        "generate 10-bit ProRes HDR fixture",
    );
    out
}

/// 5-second UNTAGGED 10-bit ProRes — no color metadata at all, so the
/// playback color routing must classify it SDR-10 by pixel format alone and
/// take the dither (not tonemap) path.
pub(crate) fn fixture_sdr10_prores() -> PathBuf {
    let out = scratch_dir().join("sdr10-prores.mov");
    if fresh(&out) {
        return out;
    }
    run_ok(
        &sidecar("ffmpeg"),
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=5:size=640x360:rate=30",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
            "-c:v", "prores_ks", "-profile:v", "3",
            "-pix_fmt", "yuv422p10le",
            "-c:a", "pcm_s16le",
            "-shortest",
            utf8(&out),
        ],
        "generate untagged 10-bit ProRes fixture",
    );
    out
}

/// Video-only MP4 — stands in for the video track of a DASH-split source
/// (YouTube >360p) in the two-input fMP4 merge test.
pub(crate) fn fixture_video_only() -> PathBuf {
    let out = scratch_dir().join("video-only.mp4");
    if fresh(&out) {
        return out;
    }
    run_ok(
        &sidecar("ffmpeg"),
        [
            "-y",
            "-f", "lavfi", "-i", "testsrc2=duration=5:size=640x360:rate=30",
            "-an",
            "-c:v", "libx264", "-preset", "veryfast",
            "-g", "30", "-keyint_min", "30",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            utf8(&out),
        ],
        "generate video-only fixture",
    );
    out
}

/// Audio-only AAC in M4A — the separate audio track for the DASH merge test,
/// and the input for the audio-only (MP3) playback-prep path.
pub(crate) fn fixture_audio_m4a() -> PathBuf {
    let out = scratch_dir().join("audio-only.m4a");
    if fresh(&out) {
        return out;
    }
    run_ok(
        &sidecar("ffmpeg"),
        [
            "-y",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            utf8(&out),
        ],
        "generate audio-only fixture",
    );
    out
}

/// Real spoken audio via macOS `say` — whisper needs speech, not a sine wave.
///
/// `say` is not deterministic on a headless CI runner: the speech-synthesis
/// daemon intermittently renders SILENCE (a valid AIFF, just empty), which then
/// surfaces two runs downstream as "cut got 0s" and "whisper emitted no cues" —
/// failures that look exactly like a real upstream sidecar break and cry wolf
/// on the one alert that is supposed to mean "an arg surface broke". So we
/// VALIDATE the fixture at the source, retry the flake a few times, and if it
/// still won't render, fail with a message that names the infrastructure — not
/// the pipeline. Empirically the AIFF is ~7 s; anything under 3 s is a bad
/// render (the script is 3 sentences).
pub(crate) fn fixture_speech_aiff() -> Option<PathBuf> {
    // In the CACHED model dir, not the ephemeral scratch dir: the workflow
    // persists `~/.cache/sauce-bunny/nightly` across runs, so a good render is
    // reused every subsequent night and `say` is invoked at most once — the
    // flake window shrinks from "every night" to "the first run after a cache
    // wipe", which the retry below covers.
    let out = models_dir().join("speech.aiff");
    if fresh(&out) && probe_duration(&probe_json(&out)) >= 3.0 {
        return Some(out);
    }
    let mut last = 0.0;
    for attempt in 1..=3 {
        let _ = std::fs::remove_file(&out);
        run_ok(
            Path::new("/usr/bin/say"),
            [
                "-o",
                utf8(&out),
                "Sauce Bunny nightly smoke check. The quick brown fox jumps over the lazy dog. \
                 One two three four five.",
            ],
            "generate speech fixture with `say`",
        );
        last = probe_duration(&probe_json(&out));
        if last >= 3.0 {
            return Some(out);
        }
        eprintln!("[nightly] `say` rendered {last:.2}s of audio on attempt {attempt}/3 (expected ~7s); retrying");
    }
    // SKIP, not fail.
    //
    // This used to panic, and the panic was correct about the diagnosis and
    // wrong about the consequence: it said "INFRASTRUCTURE flake, NOT a
    // regression" and then failed the workflow and filed an issue anyway,
    // every single night. A build that is always red reports nothing — it
    // trains everyone to stop looking, which is how the six genuinely
    // actionable failures underneath it went unread.
    //
    // GitHub's macOS runners have no working speech synthesis service, so
    // these three tests can never pass there. What they uniquely cover is
    // "real speech in, SRT out"; the flag surface most likely to break — a
    // whisper.cpp rename — is still covered by
    // `nightly_whisper_cli_recognizes_every_flag_we_pass`, which does not
    // need audio and does still run.
    //
    // A ::warning:: annotation so the gap is visible on the run page rather
    // than silent. If someone wants this coverage back, the fix is a
    // speech fixture that does not depend on the host OS, not a louder
    // failure here.
    println!(
        "::warning::nightly speech tests skipped: macOS `say` rendered only \
         {last:.2}s of audio after 3 tries, so this runner has no working speech \
         synthesis. The whisper flag-surface test still ran."
    );
    eprintln!(
        "[nightly] SKIP speech-dependent tests: `say` produced {last:.2}s (need >= 3s)."
    );
    None
}

/// The speech fixture normalised through the PRODUCTION phase-2 conversion
/// (`wav_16k_mono_args`) — so the whisper test consumes exactly what the app
/// would feed it.
pub(crate) fn fixture_speech_wav_16k() -> Option<PathBuf> {
    let out = scratch_dir().join("speech-16k.wav");
    if fresh(&out) {
        return Some(out);
    }
    // Propagates the skip: no speech to convert means no test to run.
    let aiff = fixture_speech_aiff()?;
    run_ok(
        &sidecar("ffmpeg"),
        crate::commands::transcript::wav_16k_mono_args(utf8(&aiff), None, utf8(&out)),
        "convert speech fixture to 16 kHz mono WAV",
    );
    Some(out)
}

// ─── Whisper / VAD models ────────────────────────────────────────────────────

fn models_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME not set");
    let dir = PathBuf::from(home).join(".cache/sauce-bunny/nightly");
    std::fs::create_dir_all(&dir).expect("create nightly model cache dir");
    dir
}

/// Download `url` to `dest` via curl if it isn't cached yet. curl ships with
/// macOS (the only target), and the nightly workflow caches this directory.
fn fetch_if_missing(dest: &Path, url: &str) {
    if fresh(dest) {
        return;
    }
    eprintln!("[nightly] fetching {url} → {} (one-time, cached)", dest.display());
    let tmp = dest.with_extension("part");
    run_ok(
        Path::new("/usr/bin/curl"),
        ["-fL", "--retry", "3", "--connect-timeout", "30", "-o", utf8(&tmp), url],
        "download model",
    );
    std::fs::rename(&tmp, dest).expect("move downloaded model into place");
}

/// ggml whisper model. Smallest real model (tiny.en, ~78 MB) from the same
/// HuggingFace repo the app's Settings downloader uses; override with
/// `SB_NIGHTLY_WHISPER_MODEL=/path/to/ggml-*.bin`.
pub(crate) fn whisper_model() -> PathBuf {
    if let Ok(p) = std::env::var("SB_NIGHTLY_WHISPER_MODEL") {
        let p = PathBuf::from(p);
        assert!(fresh(&p), "SB_NIGHTLY_WHISPER_MODEL points at a missing file: {}", p.display());
        return p;
    }
    let dest = models_dir().join("ggml-tiny.en.bin");
    fetch_if_missing(
        &dest,
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    );
    dest
}

/// Silero VAD model — same artifact `ensure_vad_model` downloads in the app,
/// so the nightly exercises the full `--vad -vm` flag surface. Override with
/// `SB_NIGHTLY_VAD_MODEL`.
pub(crate) fn vad_model() -> PathBuf {
    if let Ok(p) = std::env::var("SB_NIGHTLY_VAD_MODEL") {
        let p = PathBuf::from(p);
        assert!(fresh(&p), "SB_NIGHTLY_VAD_MODEL points at a missing file: {}", p.display());
        return p;
    }
    let dest = models_dir().join("ggml-silero-v5.1.2.bin");
    fetch_if_missing(
        &dest,
        "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin",
    );
    dest
}

// ─── ffprobe helpers ─────────────────────────────────────────────────────────

pub(crate) fn probe_json(path: &Path) -> serde_json::Value {
    let out = run_ok(
        &sidecar("ffprobe"),
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", utf8(path)],
        "ffprobe",
    );
    serde_json::from_slice(&out.stdout).expect("ffprobe emitted invalid JSON")
}

/// First stream of the given `codec_type` ("video" / "audio").
pub(crate) fn probe_stream<'a>(probe: &'a serde_json::Value, kind: &str) -> Option<&'a serde_json::Value> {
    probe["streams"]
        .as_array()?
        .iter()
        .find(|s| s["codec_type"] == kind)
}

pub(crate) fn probe_duration(probe: &serde_json::Value) -> f64 {
    probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0)
}

// ─── Playback-prep runner with an explicit CI encoder fallback ──────────────

/// Run the production playback-prep args against the real ffmpeg. GitHub's
/// virtualized macOS runners may not expose the VideoToolbox hardware
/// encoder; when `SB_NIGHTLY_ALLOW_SW_ENCODER=1` (set by the workflow, NOT
/// locally) a VideoToolbox-specific failure retries with libx264 so the rest
/// of the arg surface (mapping, pix_fmt, faststart, audio) is still verified.
/// Returns the encoder that actually ran.
pub(crate) fn run_playback_prep(args: &[String]) -> &'static str {
    let ffmpeg = sidecar("ffmpeg");
    let out = Command::new(&ffmpeg).args(args).output().expect("spawn ffmpeg for playback prep");
    if out.status.success() {
        return "h264_videotoolbox";
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let lower = stderr.to_lowercase();
    let vt_unavailable = lower.contains("videotoolbox") || lower.contains("compression session");
    let allow_sw = std::env::var("SB_NIGHTLY_ALLOW_SW_ENCODER").as_deref() == Ok("1");
    let uses_vt = args.iter().any(|a| a == "h264_videotoolbox");
    if uses_vt && vt_unavailable && allow_sw {
        eprintln!(
            "[nightly] ⚠ h264_videotoolbox unavailable in this environment — retrying \
             playback prep with libx264 (everything but the hw encoder is still verified)"
        );
        let sw: Vec<String> = args
            .iter()
            .map(|a| if a == "h264_videotoolbox" { "libx264".into() } else { a.clone() })
            .collect();
        let out2 = Command::new(&ffmpeg).args(&sw).output().expect("spawn ffmpeg (libx264 retry)");
        assert!(
            out2.status.success(),
            "playback prep failed even with libx264:\n{}",
            String::from_utf8_lossy(&out2.stderr)
        );
        return "libx264";
    }
    panic!("playback prep ffmpeg failed:\n{stderr}");
}

// ─── MP4 box inspection ──────────────────────────────────────────────────────

/// Walk top-level ISO-BMFF boxes: `(fourcc, offset, size)`. Tolerates a
/// truncated final box (streamed fMP4 read to EOF).
pub(crate) fn mp4_boxes(bytes: &[u8]) -> Vec<(String, usize, u64)> {
    let mut out = Vec::new();
    let mut off = 0usize;
    while off + 8 <= bytes.len() {
        let size32 = u32::from_be_bytes(bytes[off..off + 4].try_into().unwrap()) as u64;
        let fourcc = String::from_utf8_lossy(&bytes[off + 4..off + 8]).to_string();
        let (header, size) = if size32 == 1 {
            if off + 16 > bytes.len() {
                break;
            }
            (16u64, u64::from_be_bytes(bytes[off + 8..off + 16].try_into().unwrap()))
        } else if size32 == 0 {
            (8u64, (bytes.len() - off) as u64) // box extends to EOF
        } else {
            (8u64, size32)
        };
        if size < header {
            break; // malformed — stop rather than loop
        }
        out.push((fourcc, off, size));
        match off.checked_add(size as usize) {
            Some(next) if next > off && next <= bytes.len() => off = next,
            _ => break,
        }
    }
    out
}

/// The raw bytes of the first top-level box named `fourcc` (clamped to EOF).
pub(crate) fn mp4_box_bytes<'a>(bytes: &'a [u8], fourcc: &str) -> Option<&'a [u8]> {
    let (_, off, size) = mp4_boxes(bytes).into_iter().find(|(name, _, _)| name == fourcc)?;
    let end = (off as u64 + size).min(bytes.len() as u64) as usize;
    Some(&bytes[off..end])
}

pub(crate) fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}
