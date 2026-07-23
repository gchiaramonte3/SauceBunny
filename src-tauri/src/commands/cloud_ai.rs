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
    let client = reqwest::Client::new();
    let max_tokens = args.max_tokens.unwrap_or(4096);

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
            let resp = client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await?;
            let status = resp.status();
            let text = resp.text().await?;
            if !status.is_success() {
                return Err(AppError::invalid(format!(
                    "Claude API error {}: {}",
                    status.as_u16(),
                    short(&text)
                )));
            }
            let v: serde_json::Value = serde_json::from_str(&text)?;
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
            // System as the first message; omit max_tokens — some OpenAI models
            // reject it in favour of max_completion_tokens, and the default
            // length is fine for a summary.
            let mut msgs = vec![serde_json::json!({ "role": "system", "content": args.system })];
            for m in &args.messages {
                msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
            }
            let body = serde_json::json!({ "model": args.model, "messages": msgs });
            let resp = client
                .post("https://api.openai.com/v1/chat/completions")
                .header("authorization", format!("Bearer {key}"))
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await?;
            let status = resp.status();
            let text = resp.text().await?;
            if !status.is_success() {
                return Err(AppError::invalid(format!(
                    "OpenAI API error {}: {}",
                    status.as_u16(),
                    short(&text)
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
fn short(s: &str) -> String {
    let t = s.trim();
    let clipped: String = t.chars().take(300).collect();
    if clipped.len() < t.len() { format!("{clipped}…") } else { clipped }
}
