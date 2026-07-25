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
            downloaded: dir.join(m.file).is_file(),
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
    let tmp = dest.with_extension("gguf.partial");

    if dest.exists() {
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

#[tauri::command]
pub async fn stop_llm_server(state: State<'_, LlmServer>) -> Result<(), crate::AppError> {
    state.shutdown();
    Ok(())
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
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);

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
            "--no-webui".into(),                  // no built-in UI surface
            "--jinja".into(),                     // use the GGUF's chat template
        ]);

    let (mut rx, child) = cmd.spawn().map_err(|e| crate::AppError::internal(format!("spawn llama-server: {e}")))?;
    *state.child.lock().unwrap() = Some(child);

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
    *state.info.lock().unwrap() = Some(info.clone());
    Ok(info)
}
