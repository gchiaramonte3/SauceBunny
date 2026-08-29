//! Local LLM (llama.cpp) — model registry + download + the resident chat
//! server that powers the AI Summary tab.
//!
//! Mirrors the Whisper model pattern (transcript.rs): a curated registry of
//! GGUF models, downloaded on demand to `app_data_dir/models/llm/` with
//! progress events, listed/deleted from Settings.
//!
//! The chat itself runs through `llama-server` — a sidecar bound to
//! `127.0.0.1:<port>` serving an OpenAI-compatible `/v1/chat/completions`.
//! The webview streams tokens directly from it (same loopback-server pattern
//! as the media proxy + audio twin). The server is gated by a per-session
//! API key (matching the media proxy's token philosophy): without it a
//! port-scanning local process / webpage couldn't drive the user's model.
//!
//! Why a resident server (not one-shot llama-cli): a chat reloads context per
//! turn; keeping the model + KV cache warm is the whole point.

use super::*;
use std::sync::Mutex;

// ─── Model registry ─────────────────────────────────────────────────
// Curated, ungated GGUF builds. Q4_K_M is the sweet spot (≈75% smaller than
// fp16, <1% quality loss). All run on Apple Silicon via Metal.
//   (id, name, file, url, size_bytes, ctx_tokens, recommended, blurb)
struct LlmSpec {
    id: &'static str,
    name: &'static str,
    file: &'static str,
    url: &'static str,
    size: u64,
    ctx: u32,
    recommended: bool,
    blurb: &'static str,
}

const LLM_MODELS: &[LlmSpec] = &[
    LlmSpec {
        id: "qwen3-4b-instruct",
        name: "Qwen3 4B Instruct",
        file: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        size: 2_497_281_120,
        ctx: 32_768,
        recommended: true,
        blurb: "Best quality for summarizing and quote-pulling. ~2.5 GB, needs ~6 GB free RAM. Recommended.",
    },
    LlmSpec {
        id: "llama-3.2-3b-instruct",
        name: "Llama 3.2 3B Instruct",
        file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/5ab33fa94d1d04e903623ae72c95d1696f09f9e8/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        size: 2_019_377_696,
        ctx: 16_384,
        recommended: false,
        blurb: "Lighter + faster, fine for 8 GB Macs. ~2 GB. Slightly weaker on long transcripts.",
    },
    // Newer (2026) options for higher-quality summaries of long transcripts.
    // Both carry a large native context window; we cap -c at 40k (set in
    // start_llm_server) — plenty for a feature-length transcript + summary
    // without an outsized KV-cache footprint.
    LlmSpec {
        id: "qwen3.5-9b",
        name: "Qwen3.5 9B",
        file: "Qwen3.5-9B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/3885219b6810b007914f3a7950a8d1b469d598a5/Qwen3.5-9B-Q4_K_M.gguf",
        size: 5_680_522_464,
        ctx: 40_960,
        recommended: false,
        blurb: "Balanced upgrade — sharper, more faithful summaries. ~5.7 GB, needs ~10 GB free RAM. Best on 16 GB+ Macs.",
    },
    LlmSpec {
        id: "gemma-4-12b",
        name: "Gemma 4 12B",
        file: "gemma-4-12b-it-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/fc034cfff751157913579611efad8462ac1be606/gemma-4-12b-it-Q4_K_M.gguf",
        size: 7_121_860_000,
        ctx: 40_960,
        recommended: false,
        blurb: "Highest quality + cleanest prose (least markdown clutter). ~7.1 GB. Best on 24 GB+ Macs.",
    },
    // The heavy option. Deliberately NOT recommended: it is a 27B dense model,
    // so the download and the resident footprint are both a different order of
    // magnitude from everything above, and on a 16 GB Mac it will swap rather
    // than run. Offered because a 27B genuinely reads a long transcript better,
    // for people whose machine has the headroom.
    //
    // The URL is pinned to a commit SHA like its siblings, not to `main` - the
    // whole point is that the bytes cannot change under a user mid-download.
    // `size` was read from the pinned URL itself (HTTP 200, content-length
    // 17106775008), not from the model card, because it is passed to the
    // downloader as `expected_bytes` and a wrong value fails verification.
    //
    // `ctx` stays at the same 40,960 as the other 2026 models even though this
    // one's native window is far larger. The cap is a KV-cache decision, not a
    // model limit: see the note above qwen3.5-9b.
    LlmSpec {
        id: "qwen3.8-27b",
        name: "Qwen3.8 27B",
        file: "Qwen3.8-27B-Q4_K_M.gguf",
        url: "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/f1bfb127c64f7072bdd2cad55f258b9c8b2910fe/Qwen3.8-27B-Q4_K_M.gguf",
        size: 17_106_775_008,
        ctx: 40_960,
        recommended: false,
        blurb: "Strongest summaries of long transcripts, and the slowest. ~17 GB download, needs ~24 GB free RAM. Only worth it on a 32 GB+ Mac.",
    },
];

fn spec(id: &str) -> Option<&'static LlmSpec> {
    LLM_MODELS.iter().find(|m| m.id == id)
}

fn llm_models_dir(app: &AppHandle) -> Result<PathBuf, crate::AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::AppError::internal(format!("app_data_dir: {e}")))?;
    let dir = base.join("models").join("llm");
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::AppError::internal(format!("create models dir: {e}")))?;
    Ok(dir)
}

fn llm_model_path(app: &AppHandle, id: &str) -> Result<PathBuf, crate::AppError> {
    let s = spec(id).ok_or_else(|| crate::AppError::invalid(format!("Unknown model: {id}")))?;
    Ok(llm_models_dir(app)?.join(s.file))
}

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LlmModel {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub ctx: u32,
    pub recommended: bool,
    pub blurb: String,
    pub downloaded: bool,
}

/// Performance-core count, which is the right thread count on Apple Silicon.
///
/// `available_parallelism()` counts every logical CPU, so on an M4 Max it
/// returns 14 and llama.cpp spreads work across 10 performance and 4 efficiency
/// cores. The batch synchronises at each step, so every fast thread then waits
/// on the slow ones and the whole run drops to E-core pace. Measured on a 4B at
/// 4.6k tokens of prompt: 37.7 tok/s of generation at 14 threads, 83.8 tok/s at
/// 10. Same machine, same model, one flag.
///
/// `hw.perflevel0` is the performance cluster. A Mac with no such split reports
/// nothing, and falls back to the old behaviour.
pub(crate) fn performance_cores() -> usize {
    let total = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let out = std::process::Command::new("/usr/sbin/sysctl")
        .args(["-n", "hw.perflevel0.logicalcpu"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse::<usize>()
            .ok()
            .filter(|n| *n > 0 && *n <= total)
            .unwrap_or(total),
        Err(_) => total,
    }
}

#[tauri::command]
pub fn list_llm_models(app: AppHandle) -> Result<Vec<LlmModel>, crate::AppError> {
    let dir = llm_models_dir(&app)?;
    Ok(LLM_MODELS
        .iter()
        .map(|m| LlmModel {
            id: m.id.into(),
            name: m.name.into(),
            size_bytes: m.size,
            ctx: m.ctx,
            recommended: m.recommended,
            blurb: m.blurb.into(),
            // Size-checked, not is_file(): a truncated GGUF renamed into
            // place would be offered as usable and then fail inside
            // llama-server forever (see model_file_complete).
            downloaded: super::transcript::model_file_complete(&dir.join(m.file), m.size),
        })
        .collect())
}

#[tauri::command]
pub async fn download_llm_model(
    app: AppHandle,
    args: DownloadModelArgs,
) -> Result<String, crate::AppError> {
    let s = spec(&args.model_id).ok_or_else(|| format!("Unknown model: {}", args.model_id))?;
    let dest = llm_model_path(&app, &args.model_id)?;
    let url = s.url.to_string();
    // Per-JOB temp so two downloads of the same model cannot interleave into
    // one corrupt file (job ids are UUIDs).
    let tmp = dest.with_extension(format!("{}.partial", args.job_id));

    if super::transcript::model_file_complete(&dest, s.size) {
        // Already present — the frontend re-lists and clears its busy state.
        return Ok(args.job_id);
    }

    let job_id = args.job_id.clone();
    let model_id = args.model_id.clone();
    let expected_bytes = s.size;
    let app_for = app.clone();
    tokio::spawn(async move {
        let result = download_with_progress(&app_for, &url, &tmp, &job_id, &model_id, Some(expected_bytes)).await;
        let done = match &result {
            Ok(()) => match std::fs::rename(&tmp, &dest) {
                Ok(()) => DoneEvent { job_id: job_id.clone(), success: true, code: Some(0), path: dest.to_str().map(String::from), error: None },
                Err(e) => { let _ = std::fs::remove_file(&tmp); DoneEvent { job_id: job_id.clone(), success: false, code: None, path: None, error: Some(format!("Rename failed: {e}")) } }
            },
            Err(e) => { let _ = std::fs::remove_file(&tmp); DoneEvent { job_id: job_id.clone(), success: false, code: None, path: None, error: Some(e.to_string()) } }
        };
        let _ = app_for.emit("model-download-done", done);
    });
    Ok(args.job_id)
}

#[tauri::command]
pub fn delete_llm_model(app: AppHandle, model_id: String) -> Result<(), crate::AppError> {
    let p = llm_model_path(&app, &model_id)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| crate::AppError::internal(format!("delete model: {e}")))?;
    }
    Ok(())
}

// ─── Resident chat server (llama-server) ────────────────────────────

/// Holds the single running llama-server child + its connection info. A new
/// `start_llm_server` kills the previous one (only one model resident at a
/// time — they're GBs each).
#[derive(Default)]
pub struct LlmServer {
    child: Mutex<Option<CommandChild>>,
    info: Mutex<Option<LlmServerInfo>>,
}

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LlmServerInfo {
    /// e.g. http://127.0.0.1:51234 — the frontend POSTs /v1/chat/completions here.
    pub base_url: String,
    /// Per-session bearer token; required on every request (Authorization header).
    pub api_key: String,
    pub model_id: String,
    pub ctx: u32,
}

impl LlmServer {
    /// Kill the running server, if any. Called by stop + on app exit.
    pub fn shutdown(&self) {
        if let Ok(mut g) = self.child.lock() {
            if let Some(c) = g.take() {
                let _ = c.kill();
            }
        }
        if let Ok(mut i) = self.info.lock() {
            *i = None;
        }
    }
    fn current(&self) -> Option<LlmServerInfo> {
        self.info.lock().ok().and_then(|g| g.clone())
    }
}

/// 32 bytes of /dev/urandom → base64url. Same approach as the media proxy's
/// token (no extra RNG dependency). FAILS CLOSED: the old version swallowed
/// a failed open/read and encoded the untouched buffer — an ALL-ZERO, publicly
/// known bearer token guarding the LLM server. No key, no server.
fn mint_api_key() -> Result<String, crate::AppError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
    let mut buf = [0u8; 32];
    let mut f = std::fs::File::open("/dev/urandom")
        .map_err(|e| crate::AppError::internal(format!("CSPRNG unavailable: {e}")))?;
    use std::io::Read;
    f.read_exact(&mut buf)
        .map_err(|e| crate::AppError::internal(format!("CSPRNG read failed: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

fn free_loopback_port() -> Result<u16, crate::AppError> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| crate::AppError::internal(format!("bind: {e}")))?;
    let port = l
        .local_addr()
        .map_err(|e| crate::AppError::internal(format!("addr: {e}")))?
        .port();
    Ok(port) // dropped here; tiny TOCTOU window, fine for single-user local
}

#[tauri::command]
pub fn llm_server_status(state: State<'_, LlmServer>) -> Option<LlmServerInfo> {
    state.current()
}

/// Start (or reuse) llama-server for `model_id`. Returns once the server's
/// `/health` reports ready (model loaded), so the frontend can chat immediately.
#[tauri::command]
pub async fn start_llm_server(
    app: AppHandle,
    state: State<'_, LlmServer>,
    model_id: String,
) -> Result<LlmServerInfo, crate::AppError> {
    // Already running with this model → reuse.
    if let Some(info) = state.current() {
        if info.model_id == model_id {
            return Ok(info);
        }
        state.shutdown(); // different model → swap
    }

    let s = spec(&model_id).ok_or_else(|| format!("Unknown model: {model_id}"))?;
    let model_path = llm_model_path(&app, &model_id)?;
    if !model_path.is_file() {
        return Err(crate::AppError::not_found(format!("Model {model_id} not downloaded")));
    }

    let port = free_loopback_port()?;
    let api_key = mint_api_key()?;
    let threads = performance_cores();

    let cmd = app
        .shell()
        .sidecar("llama-server")
        .map_err(|e| crate::AppError::internal(format!("sidecar: {e}")))?
        .args([
            "-m".into(), model_path.to_string_lossy().to_string(),
            "--host".into(), "127.0.0.1".into(),
            "--port".into(), port.to_string(),
            "--api-key".into(), api_key.clone(),
            "-c".into(), s.ctx.to_string(),       // context window
            "-ngl".into(), "999".into(),          // offload all layers to Metal
            "-t".into(), threads.to_string(),
            // Flash attention ON rather than left at `auto`. Prompt
            // processing is where the wait is: an AI Summary of a 77-minute
            // transcript sends ~17k tokens and took 55.7s before the first
            // word, at a throughput that fell from 592 to 320 tok/s across
            // the prompt as attention cost grew with context. `auto` may
            // already resolve to on for this model, but leaving it to be
            // decided means it can silently resolve the other way.
            "-fa".into(), "on".into(),
            // Physical batch 512 -> 1024. Prompt processing on Metal is
            // launch-bound at 512: bigger ubatches keep the GPU busy for
            // longer per dispatch. Costs activation memory proportional to
            // the ubatch, which at 1024 is small next to the model itself.
            "-ub".into(), "1024".into(),
            "--no-webui".into(),                  // no built-in UI surface
            "--jinja".into(),                     // use the GGUF's chat template
            // ONE slot. The app serialises model calls by design (AiSummary and
            // AiChapters lock each other out through chatBusy), so the server's
            // auto-chosen 4 slots each reserved a full n_ctx of KV cache for
            // work that can never arrive. On a 27B at 40k context that is GBs
            // held to no purpose, on the same unified memory the model and the
            // video decode are competing for.
            "-np".into(), "1".into(),
            // NO CHAIN-OF-THOUGHT. Qwen3's template turns thinking on, and its
            // default effort on a "summarise this into a few bullets" request
            // spent 3,254 tokens reasoning without reaching an answer - roughly
            // four minutes at this model's generation rate, all of it invisible
            // because the thinking is stripped before display. Measured on the
            // same request with a budget of 0: 119 tokens, 7.3 seconds.
            // Summarising a transcript and cutting chapter marks are extraction
            // tasks; the reasoning was buying nothing and costing everything.
            "--reasoning-budget".into(), "0".into(),
        ]);

    let (mut rx, child) = cmd.spawn().map_err(|e| crate::AppError::internal(format!("spawn llama-server: {e}")))?;
    // `.lock()` returns Err only when the mutex is POISONED, i.e. some thread
    // panicked while holding it. `.unwrap()` there turns a one-off panic into a
    // permanent one: every later call to this command panics too, and the AI
    // features stay dead for the rest of the session. Every other lock in this
    // file (205, 210, 215, 326) and the whole of JobRegistry already guard with
    // `if let Ok` / `.ok()` for exactly that reason; these two were the
    // outliers. A poisoned lock now costs one failed start, not the feature.
    match state.child.lock() {
        Ok(mut g) => *g = Some(child),
        // The child is already spawned. Kill it rather than leaking an
        // untracked llama-server that nothing can ever stop.
        Err(_) => {
            let _ = child.kill();
            return Err(crate::AppError::internal(
                "the local model state was left inconsistent by an earlier failure. Restart the app and try again.",
            ));
        }
    }

    // Drain the server's stderr to the Pipeline log (load progress, errors).
    let app_log = app.clone();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if let CommandEvent::Stderr(b) | CommandEvent::Stdout(b) = ev {
                let line = String::from_utf8_lossy(&b);
                for l in line.lines() {
                    if l.trim().is_empty() { continue; }
                    let _ = app_log.emit("llm-log", LogEvent {
                        job_id: "llm-server".into(),
                        stream: "stderr".into(),
                        tag: "info".into(),
                        line: l.to_string(),
                    });
                }
            }
        }
    });

    // Poll /health until the model is loaded (or give up after ~90s — first
    // load of a 2.5 GB model + Metal warm-up can take a while).
    let base_url = format!("http://127.0.0.1:{port}");
    let health = format!("{base_url}/health");
    let client = reqwest::Client::new();
    let mut ready = false;
    for _ in 0..180 {
        if state.current().is_none() && state.child.lock().map(|g| g.is_none()).unwrap_or(true) {
            // Shut down out from under us (user switched away).
            return Err(crate::AppError::internal("server start cancelled"));
        }
        if let Ok(resp) = client.get(&health).bearer_auth(&api_key).send().await {
            if resp.status().is_success() {
                ready = true;
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    if !ready {
        state.shutdown();
        return Err(crate::AppError::internal("llama-server did not become ready in time"));
    }

    let info = LlmServerInfo { base_url, api_key, model_id, ctx: s.ctx };
    // Same reasoning as the child lock above. The server IS up at this point,
    // so a poisoned lock here loses the handle rather than the process - report
    // it instead of panicking and leaving the caller with neither.
    match state.info.lock() {
        Ok(mut g) => *g = Some(info.clone()),
        Err(_) => return Err(crate::AppError::internal(
            "the local model started but its state could not be recorded. Restart the app and try again.",
        )),
    }
    Ok(info)
}

/// Put the resident model down.
///
/// This is ALSO the cancel path for a start that is still in flight, and that
/// is the reason it exists. `start_llm_server` polls `/health` for up to
/// ninety seconds while llama-server maps a multi-GB model, and between polls
/// it checks for exactly this state and returns "server start cancelled". That
/// check was written, was correct, and had no caller: nothing in the app could
/// reach it, so a Stop pressed during "Loading the model into memory" aborted
/// a token stream that had not started while the load ran to completion.
///
/// Idempotent. Stopping a server that is not running is not an error, which
/// matters because the frontend fires this from an abort handler that cannot
/// know whether the start had already finished.
#[tauri::command]
pub fn stop_llm_server(state: State<'_, LlmServer>) -> Result<(), crate::AppError> {
    state.shutdown();
    Ok(())
}

#[cfg(test)]
mod llm_tests {
    use super::{free_loopback_port, mint_api_key, spec, LLM_MODELS};
    use std::collections::HashSet;

    #[test]
    fn every_key_is_different_and_random() {
        // Guards a bug that was already here once: the earlier version
        // swallowed a failed /dev/urandom read and encoded the untouched
        // buffer, producing an ALL-ZERO bearer token — a publicly known
        // password on the local model server. Any constant-returning
        // regression makes these collide.
        let keys: HashSet<String> = (0..32).map(|_| mint_api_key().unwrap()).collect();
        assert_eq!(keys.len(), 32, "mint_api_key repeated itself");
        assert!(!keys.contains(&"A".repeat(43)), "an all-zero buffer would encode as a constant");
    }

    #[test]
    fn the_key_is_url_safe_and_full_length() {
        // It rides in a header and a URL; base64url with no padding keeps it
        // safe in both. 32 bytes → 43 chars unpadded.
        let k = mint_api_key().unwrap();
        assert_eq!(k.len(), 43, "expected 32 bytes of base64url, got {k:?}");
        assert!(
            k.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "not URL-safe: {k:?}"
        );
    }

    #[test]
    fn only_models_in_the_table_resolve() {
        // spec() is the whitelist that keeps a model id out of the filesystem
        // path: llm_model_path joins s.file from this static table, never the
        // caller's string, so traversal is impossible by construction.
        for m in LLM_MODELS {
            assert!(spec(m.id).is_some(), "{} should resolve", m.id);
        }
        for bad in ["", "unknown", "../../etc/passwd", "qwen/../..", "QWEN"] {
            assert!(spec(bad).is_none(), "{bad:?} must not resolve to a model");
        }
    }

    #[test]
    fn the_model_table_is_self_consistent() {
        // Duplicate ids would make spec() return whichever came first, and a
        // shared filename would have two models overwrite each other on disk.
        let ids: HashSet<&str> = LLM_MODELS.iter().map(|m| m.id).collect();
        assert_eq!(ids.len(), LLM_MODELS.len(), "duplicate model id");
        let files: HashSet<&str> = LLM_MODELS.iter().map(|m| m.file).collect();
        assert_eq!(files.len(), LLM_MODELS.len(), "two models share a filename");
        for m in LLM_MODELS {
            assert!(!m.file.contains('/'), "{} carries a path, not a filename", m.id);
        }
    }

    #[test]
    fn the_port_is_loopback_assigned() {
        // Asked of the OS rather than hardcoded, so two runs cannot collide.
        let a = free_loopback_port().unwrap();
        assert!(a > 0);
        let b = free_loopback_port().unwrap();
        assert!(b > 0);
        // Not asserting a != b: the OS may legitimately hand back the same
        // freed port twice. The property that matters is that it answers.
    }
}
