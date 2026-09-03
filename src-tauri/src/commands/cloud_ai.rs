//! Cloud AI providers (Claude / ChatGPT) — an OPT-IN alternative to the local
//! Qwen model for the AI Summary + reader Analysis features.
//!
//! Two deliberate choices keep this from eroding the app's local-first stance:
//!   1. The user's API key lives in the macOS **Keychain** (via `keyring`),
//!      never plaintext localStorage and never inside the webview. The frontend
//!      can set / clear / check-existence, but can't read the key back.
//!   2. The chat call is made HERE (reqwest), not from the webview — the cloud
//!      APIs block direct browser calls (CORS), and keeping the key server-side
//!      means it never crosses the IPC boundary at request time.
//!
//! Non-streaming: a summary/analysis is a one-shot, and the UI shows a spinner
//! meanwhile. Streaming can come later without changing the key/CORS design.

use crate::AppError;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Notify;

/// Keychain service; the account is the provider ("anthropic" / "openai").
const KEYCHAIN_SERVICE: &str = "com.saucebunny.desktop.ai";

fn entry(provider: &str) -> Result<keyring::Entry, AppError> {
    if provider != "anthropic" && provider != "openai" {
        return Err(AppError::invalid(format!("Unknown AI provider: {provider}")));
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, provider)
        .map_err(|e| AppError::internal(format!("Keychain unavailable: {e}")))
}

/// Store (or replace) a provider's API key in the Keychain.
#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), AppError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(AppError::invalid("The API key is empty."));
    }
    entry(&provider)?
        .set_password(key)
        .map_err(|e| AppError::internal(format!("Couldn't save the key to the Keychain: {e}")))
}

// ── TURN relay credential (co-review) ───────────────────────────────
// Same Keychain home as the AI keys, one deliberate difference: the frontend
// CAN read this back. The RTCPeerConnection is built in the webview, so the
// credential has to reach JS at session time — the point of moving it here is
// that it no longer PERSISTS webview-side (it used to live in localStorage
// defaults, which also leaked it into settings-export files).
const TURN_ACCOUNT: &str = "turn-password";

fn turn_entry() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, TURN_ACCOUNT)
        .map_err(|e| AppError::internal(format!("Keychain unavailable: {e}")))
}

/// Store the TURN password; an empty/whitespace value clears it (idempotent).
#[tauri::command]
pub fn set_turn_password(password: String) -> Result<(), AppError> {
    let p = password.trim();
    if p.is_empty() {
        return match turn_entry()?.delete_password() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::internal(format!("Couldn't clear the TURN password: {e}"))),
        };
    }
    turn_entry()?
        .set_password(p)
        .map_err(|e| AppError::internal(format!("Couldn't save the TURN password to the Keychain: {e}")))
}

/// Read the TURN password back for the session's RTC config. Empty = none set.
#[tauri::command]
pub fn get_turn_password() -> Result<String, AppError> {
    match turn_entry()?.get_password() {
        Ok(p) => Ok(p),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(AppError::internal(format!("Couldn't read the TURN password: {e}"))),
    }
}

/// Forget a provider's key. Absent is success (idempotent).
#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), AppError> {
    match entry(&provider)?.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::internal(format!("Couldn't remove the key: {e}"))),
    }
}

/// Whether a key is stored for a provider (drives the Settings "key set" state).
/// Never returns the key itself.
#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, AppError> {
    match entry(&provider)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(AppError::internal(format!("Keychain read failed: {e}"))),
    }
}

#[derive(Deserialize)]
pub struct CloudChatMsg {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct CloudChatArgs {
    /// "anthropic" | "openai".
    pub provider: String,
    /// Provider model id (e.g. "claude-sonnet-5", "gpt-4o").
    pub model: String,
    /// System instruction (the transcript + rules live here).
    pub system: String,
    /// User/assistant turns.
    pub messages: Vec<CloudChatMsg>,
    pub max_tokens: Option<u32>,
    /// Sampling temperature, 0..2. OPENAI ONLY, deliberately.
    ///
    /// The Anthropic Messages API REMOVED sampling controls on its current
    /// models: `temperature`, `top_p` and `top_k` return a 400 on Sonnet 5,
    /// Opus 5, Opus 4.7/4.8 and the Fable family. Sonnet 5 is this app's
    /// default Claude model, so sending one would break the feature on the
    /// stock configuration - the depth control there is
    /// `output_config.effort`, which is a different thing and not a
    /// substitute for near-greedy decoding.
    ///
    /// So the local path's deliberate 0.2 (comment tidy-up, chapter
    /// detection) reaches OpenAI and not Claude. What keeps Claude honest
    /// instead is the prompt and the verifier those features already run.
    pub temperature: Option<f32>,
    /// Optional caller-minted id enabling `cloud_chat_cancel`. Without it the
    /// request simply isn't cancellable (the pre-r142 behaviour).
    pub request_id: Option<String>,
}

/// In-flight chat requests by caller-minted id. `cloud_chat_cancel` looks the
/// id up and fires its Notify; the select! below drops the reqwest future,
/// closing the connection so a stopped request stops BILLING too (streaming
/// APIs meter on delivery; a one-shot body abandoned mid-generation is closed
/// at the socket and the provider halts generation server-side).
fn chat_cancels() -> &'static Mutex<HashMap<String, Arc<Notify>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<Notify>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes the registry entry when `cloud_chat` returns by ANY path (success,
/// API error, cancellation) so ids can't accumulate.
struct CancelGuard(Option<String>);
impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Some(id) = self.0.take() {
            if let Ok(mut m) = chat_cancels().lock() {
                m.remove(&id);
            }
        }
    }
}

/// Abort an in-flight `cloud_chat` by its caller-minted request id. Unknown
/// ids are a no-op (the request already finished).
#[tauri::command]
pub fn cloud_chat_cancel(request_id: String) -> Result<(), AppError> {
    if let Ok(m) = chat_cancels().lock() {
        if let Some(n) = m.get(&request_id) {
            // notify_one stores a permit, so a cancel that lands before the
            // request future is first polled still wins (no lost wakeup).
            n.notify_one();
        }
    }
    Ok(())
}

/// Send + read-body under the caller's cancel Notify. Dropping the reqwest
/// future on cancel is what actually tears the connection down.
async fn post_and_read(
    req: reqwest::RequestBuilder,
    cancel: Option<Arc<Notify>>,
) -> Result<(reqwest::StatusCode, String), AppError> {
    let fut = async {
        let resp = req.send().await?;
        let status = resp.status();
        let text = resp.text().await?;
        Ok::<_, AppError>((status, text))
    };
    match cancel {
        Some(n) => tokio::select! {
            _ = n.notified() => Err(AppError::invalid("Stopped.")),
            r = fut => r,
        },
        None => fut.await,
    }
}

/// One-shot chat completion against the user's chosen cloud provider, using the
/// Keychain-stored key. Returns the assistant's full text.
#[tauri::command]
pub async fn cloud_chat(args: CloudChatArgs) -> Result<String, AppError> {
    let key = entry(&args.provider)?.get_password().map_err(|_| {
        AppError::invalid(format!(
            "No API key saved for {}. Add one in Settings ▸ AI APIs.",
            args.provider
        ))
    })?;
    // A TIMEOUT, because there was none. Settings' "Test" button calls this
    // with no AbortSignal, so a connection that stalls open was unkillable
    // from the UI - the spinner simply never stopped.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| AppError::internal(format!("http client: {e}")))?;
    // 4096 was low enough to truncate an ordinary summary of a long
    // transcript, and nothing checked whether it had.
    let max_tokens = args.max_tokens.unwrap_or(16000);

    // Register for cancellation before any network I/O so a Stop clicked the
    // instant after send can't miss. The guard unregisters on every exit.
    let cancel = args.request_id.clone().map(|id| {
        let n = Arc::new(Notify::new());
        if let Ok(mut m) = chat_cancels().lock() {
            m.insert(id.clone(), n.clone());
        }
        (id, n)
    });
    let _guard = CancelGuard(cancel.as_ref().map(|(id, _)| id.clone()));
    let cancel = cancel.map(|(_, n)| n);

    match args.provider.as_str() {
        "anthropic" => {
            let body = serde_json::json!({
                "model": args.model,
                "max_tokens": max_tokens,
                "system": args.system,
                "messages": args.messages.iter()
                    .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                    .collect::<Vec<_>>(),
            });
            let req = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body);
            let (status, text) = post_and_read(req, cancel).await?;
            if !status.is_success() {
                return Err(AppError::invalid(format!(
                    "Claude API error {}: {}",
                    status.as_u16(),
                    provider_error(&text)
                )));
            }
            let v: serde_json::Value = serde_json::from_str(&text)?;
            // A truncated answer used to be indistinguishable from a finished
            // one: the text just stopped mid-sentence and nothing said why.
            if v["stop_reason"].as_str() == Some("max_tokens") {
                return Err(AppError::invalid(
                    "Claude ran out of room before finishing. Try a shorter transcript or a smaller question.",
                ));
            }
            let out = v["content"]
                .as_array()
                .map(|blocks| {
                    blocks.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("")
                })
                .unwrap_or_default();
            if out.trim().is_empty() {
                return Err(AppError::invalid("Claude returned an empty response."));
            }
            Ok(out)
        }
        "openai" => {
            // System as the first message. `max_completion_tokens`, not
            // `max_tokens`: current OpenAI models reject the old name.
            let mut msgs = vec![serde_json::json!({ "role": "system", "content": args.system })];
            for m in &args.messages {
                msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
            }
            let mut body = serde_json::json!({
                "model": args.model,
                "messages": msgs,
                "max_completion_tokens": max_tokens,
            });
            // The one provider that still takes it. See CloudChatArgs.
            if let Some(t) = args.temperature {
                body["temperature"] = serde_json::json!(t);
            }
            let req = client
                .post("https://api.openai.com/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .json(&body);
            let (status, text) = post_and_read(req, cancel).await?;
            if !status.is_success() {
                return Err(AppError::invalid(format!(
                    "OpenAI API error {}: {}",
                    status.as_u16(),
                    provider_error(&text)
                )));
            }
            let v: serde_json::Value = serde_json::from_str(&text)?;
            let out = v["choices"][0]["message"]["content"].as_str().unwrap_or_default().to_string();
            if out.trim().is_empty() {
                return Err(AppError::invalid("OpenAI returned an empty response."));
            }
            Ok(out)
        }
        other => Err(AppError::invalid(format!("Unknown AI provider: {other}"))),
    }
}

/// UTF-8-safe truncation for embedding an API error body in a message.
/// The provider's own `error.message`, which is the sentence a user can act
/// on. Both Anthropic and OpenAI use that shape; the raw body is a JSON blob
/// with the useful line buried in it.
fn provider_error(text: &str) -> String {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| short(text))
}

fn short(s: &str) -> String {
    let t = s.trim();
    let clipped: String = t.chars().take(300).collect();
    if clipped.len() < t.len() { format!("{clipped}…") } else { clipped }
}

#[cfg(test)]
mod cloud_ai_tests {
    use super::{entry, short};

    /// The provider guard runs BEFORE the Keychain is touched, which is what
    /// makes it testable here: a CI runner has no Keychain, and these cases
    /// return without asking for one.
    #[test]
    fn only_the_two_known_providers_reach_the_keychain() {
        // Whitelist, not blacklist — the same shape the frontend's
        // loadAiProvider uses, and for the same reason: an unrecognised value
        // must not select a cloud path. A typo here would mean a key stored
        // under an account nothing reads back.
        for bad in ["", "Anthropic", "openai ", "gemini", "local", "../../etc", "anthropic\0"] {
            let err = entry(bad).unwrap_err();
            let msg = format!("{err:?}");
            assert!(
                msg.contains("Unknown AI provider"),
                "{bad:?} was not rejected by the provider guard: {msg}"
            );
        }
    }

    #[test]
    fn short_leaves_a_brief_body_alone() {
        assert_eq!(short("  rate limited  "), "rate limited");
        assert_eq!(short(""), "");
    }

    #[test]
    fn short_marks_a_clipped_body() {
        let long = "x".repeat(400);
        let out = short(&long);
        assert!(out.ends_with('…'), "a clipped body must say so");
        assert_eq!(out.chars().count(), 301, "300 chars plus the ellipsis");
    }

    #[test]
    fn short_never_splits_a_character() {
        // This embeds a PROVIDER's error body in a message shown to the user.
        // Bodies are UTF-8 from a third party, and byte-slicing one mid
        // codepoint panics — turning "the API said no" into a crash while
        // reporting it. `chars().take` is what prevents that; this pins it.
        for filler in ["é", "日", "🎬", "👍🏽"] {
            let body = filler.repeat(400);
            let out = short(&body);
            assert!(out.chars().count() <= 301, "{filler} produced {}", out.chars().count());
            assert!(out.ends_with('…'), "{filler} should have been clipped");
            // Round-tripping proves no partial codepoint survived.
            assert_eq!(String::from_utf8(out.clone().into_bytes()).unwrap(), out);
        }
    }

    #[test]
    fn short_is_exact_at_the_boundary() {
        let exact: String = "🎬".repeat(300);
        assert_eq!(short(&exact), exact, "300 chars is not 'too long'");
        let over: String = "🎬".repeat(301);
        assert!(short(&over).ends_with('…'));
    }
}
