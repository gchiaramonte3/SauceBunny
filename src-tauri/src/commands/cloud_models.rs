//! The models an editor's own key can reach, from the provider itself, for
//! the menus in Settings ▸ AI APIs (docs/ASK-RANGE-SPEC-2026-10-06.md,
//! decision 1: "we have the api so I want all of them"). The model id used to
//! be typed by hand; the provider's `/v1/models` lists every one the key may
//! call, including models newer than this build.
//!
//! The key is read on the blocking pool, as every Keychain read is
//! (`cloud_ai::keychain`), and never leaves Rust.
use super::cloud_ai::{entry, keychain, provider_error};
use crate::AppError;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CloudModel {
    pub id: String,
    /// The provider's display name, when it gives one (Anthropic does).
    pub name: Option<String>,
    /// When the provider released it, in seconds since 1970, for newest first.
    #[ts(type = "number | null")]
    pub created: Option<i64>,
    /// Whether it answers in text: OpenAI lists embedding, speech, image and
    /// moderation models beside the chat ones, which a menu of chat models
    /// should not offer first.
    pub chat: bool,
}

/// OpenAI model families that do not answer a chat: kept in the list, offered last.
const NOT_CHAT: &[&str] = &["embedding", "tts", "whisper", "dall-e", "davinci", "babbage", "moderation", "transcribe", "image", "audio", "realtime", "sora", "search-api"];

pub(crate) fn parse_openai(body: &Value) -> Vec<CloudModel> {
    let mut models: Vec<CloudModel> = body["data"].as_array().into_iter().flatten().filter_map(|item| {
        let id = item["id"].as_str()?.to_string();
        let chat = !NOT_CHAT.iter().any(|family| id.contains(family));
        Some(CloudModel { name: None, created: item["created"].as_i64(), chat, id })
    }).collect();
    order(&mut models);
    models
}

pub(crate) fn parse_anthropic(body: &Value) -> Vec<CloudModel> {
    body["data"].as_array().into_iter().flatten().filter_map(|item| Some(CloudModel {
        id: item["id"].as_str()?.to_string(), name: item["display_name"].as_str().map(str::to_string),
        created: item["created_at"].as_str().and_then(seconds_of), chat: true,
    })).collect()
}

/// Chat models first, newest first, then by id.
fn order(models: &mut [CloudModel]) {
    models.sort_by(|a, b| b.chat.cmp(&a.chat).then(b.created.cmp(&a.created)).then(a.id.cmp(&b.id)));
}

/// "2025-10-01T00:00:00Z" as seconds since 1970, for ordering only (a day's precision is plenty).
fn seconds_of(text: &str) -> Option<i64> {
    let date = text.get(..10)?;
    let mut parts = date.split('-').map(|part| part.parse::<i64>().ok());
    let (year, month, day) = (parts.next()??, parts.next()??, parts.next()??);
    // Days since 1970 by the civil-calendar formula.
    let (y, m) = if month <= 2 { (year - 1, month + 9) } else { (year, month - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * 86_400)
}

/// Every model the saved key for `provider` can call, chat models first and newest first.
#[tauri::command]
pub async fn cloud_models(provider: String) -> Result<Vec<CloudModel>, AppError> {
    let which = provider.clone();
    let key = keychain(move || entry(&which)?.get_password()
        .map_err(|_| AppError::invalid(format!("No API key saved for {which}. Add one in Settings ▸ AI APIs.")))).await?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build()
        .map_err(|e| AppError::internal(format!("http client: {e}")))?;
    match provider.as_str() {
        "openai" => {
            let response = client.get("https://api.openai.com/v1/models").bearer_auth(&key).send().await?;
            let (status, text) = (response.status(), response.text().await?);
            if !status.is_success() { return Err(AppError::invalid(format!("OpenAI error {}: {}", status.as_u16(), provider_error(&text)))); }
            Ok(parse_openai(&serde_json::from_str(&text)?))
        }
        "anthropic" => {
            // Anthropic pages its list; follow it to the end.
            let mut models = Vec::new();
            let mut after: Option<String> = None;
            for _ in 0..20 {
                let mut request = client.get("https://api.anthropic.com/v1/models").header("x-api-key", &key).header("anthropic-version", "2023-06-01")
                    .query(&[("limit", "1000")]);
                if let Some(id) = &after { request = request.query(&[("after_id", id.as_str())]); }
                let response = request.send().await?;
                let (status, text) = (response.status(), response.text().await?);
                if !status.is_success() { return Err(AppError::invalid(format!("Claude API error {}: {}", status.as_u16(), provider_error(&text)))); }
                let body: Value = serde_json::from_str(&text)?;
                models.extend(parse_anthropic(&body));
                if body["has_more"].as_bool() != Some(true) { break; }
                after = body["last_id"].as_str().map(str::to_string);
                if after.is_none() { break; }
            }
            order(&mut models);
            Ok(models)
        }
        other => Err(AppError::invalid(format!("Unknown AI provider: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn openai_lists_chat_models_first_and_newest_first_and_keeps_the_rest_last() {
        let models = parse_openai(&json!({ "data": [
            { "id": "text-embedding-3-small", "created": 300 }, { "id": "gpt-old", "created": 100 },
            { "id": "gpt-new", "created": 200 }, { "id": "whisper-1", "created": 400 },
        ] }));
        assert_eq!(models.iter().map(|model| (model.id.as_str(), model.chat)).collect::<Vec<_>>(),
            [("gpt-new", true), ("gpt-old", true), ("whisper-1", false), ("text-embedding-3-small", false)]);
    }

    #[test]
    fn anthropic_gives_names_and_release_dates() {
        let models = parse_anthropic(&json!({ "data": [
            { "id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5", "created_at": "2025-10-01T00:00:00Z" },
        ], "has_more": false }));
        assert_eq!(models, [CloudModel { id: "claude-haiku-4-5-20251001".into(), name: Some("Claude Haiku 4.5".into()), created: Some(1_759_276_800), chat: true }]);
        assert_eq!(seconds_of("1970-01-02T00:00:00Z"), Some(86_400));
        assert_eq!(seconds_of("not a date"), None);
    }
}
