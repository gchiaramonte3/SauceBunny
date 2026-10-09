//! OpenAI's Responses API, for two things. The Ultrafast tier: OpenAI offers
//! `service_tier: "ultrafast"` there (for gpt-6-astra), up to about six times
//! faster through the API at about six times the price per token, and
//! documents it nowhere else. And the models Chat Completions turns away: it
//! refuses function tools on some reasoning models ("Function tools with
//! reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions.
//! To use function tools, use /v1/responses"), and serves others not at all.
//! Every other OpenAI request keeps the Chat Completions path it always had.
//!
//! `store: false` on every request: the Responses API otherwise keeps the
//! conversation on OpenAI's servers, which a transcript should not be just
//! because of the model the editor chose. A tool loop therefore asks for its
//! reasoning back encrypted and hands it back verbatim on the next round.
//! No `temperature`: the models that need this path are reasoning models,
//! which refuse one.
use crate::AppError;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

pub(crate) const URL: &str = "https://api.openai.com/v1/responses";

/// The tier a request asked for. Only Ultrafast is known; anything else is
/// refused rather than forwarded to a paid API.
pub(crate) fn tier(requested: Option<&str>) -> Result<Option<&'static str>, AppError> {
    match requested.map(str::trim) {
        None | Some("") => Ok(None),
        Some("ultrafast") => Ok(Some("ultrafast")),
        Some(other) => Err(AppError::invalid(format!("Unknown OpenAI speed: {other}"))),
    }
}

/// One request. `tier` is sent only when one was asked for; `reasoning` asks
/// for the model's reasoning back (encrypted), which a tool loop must return
/// with the tool results.
pub(crate) fn body(model: &str, system: &str, input: &[Value], max_output_tokens: u32, tier: Option<&str>, reasoning: bool) -> Value {
    let mut body = json!({ "model": model, "instructions": system, "input": input, "max_output_tokens": max_output_tokens, "store": false });
    if let Some(tier) = tier { body["service_tier"] = json!(tier); }
    if reasoning { body["include"] = json!(["reasoning.encrypted_content"]); }
    body
}

/// OpenAI's refusal of a request, in words the editor can act on. The tier
/// is offered for a few models only (gpt-6-astra, and gpt-5.6-sol in preview,
/// per OpenAI's Ultrafast guide), and with any other model OpenAI refuses the
/// whole request as "Invalid service_tier argument", which read as a broken
/// key or a broken app. The renderer sends the tier only for those models;
/// this covers a list that has gone out of date.
pub(crate) fn refused(model: &str, status: u16, message: &str) -> AppError {
    if status == 400 && message.to_ascii_lowercase().contains("service_tier") {
        return AppError::invalid(format!("OpenAI does not offer Ultrafast for {model}. Choose gpt-6-astra in Settings ▸ AI APIs, or turn Ultrafast off."));
    }
    AppError::invalid(format!("OpenAI API error {status}: {message}"))
}

/// Chat Completions turned the request away and named this API instead.
/// OpenAI words it two ways ("To use function tools, use /v1/responses", and
/// "only supported in v1/responses and not in v1/chat/completions"); both
/// name the endpoint, and nothing else it sends does.
pub(crate) fn sent_here(message: &str) -> bool {
    message.to_ascii_lowercase().contains("v1/responses")
}

/// The models Chat Completions has turned away this session, so a later
/// request goes straight here instead of being refused first.
fn known() -> &'static Mutex<HashSet<String>> {
    static KNOWN: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    KNOWN.get_or_init(Default::default)
}

pub(crate) fn remember(model: &str) {
    if let Ok(mut known) = known().lock() { known.insert(model.trim().to_string()); }
}

pub(crate) fn needed_for(model: &str) -> bool {
    known().lock().is_ok_and(|known| known.contains(model.trim()))
}

/// The answer: every `output_text` part of every message the model produced.
pub(crate) fn text(reply: &Value) -> String {
    reply["output"].as_array().into_iter().flatten()
        .filter(|item| item["type"] == "message")
        .flat_map(|item| item["content"].as_array().cloned().unwrap_or_default())
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str().map(str::to_string))
        .collect()
}

/// The model stopped because it ran out of room, not because it had finished.
pub(crate) fn out_of_room(reply: &Value) -> bool {
    reply["status"] == "incomplete" && reply["incomplete_details"]["reason"] == "max_output_tokens"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ultrafast_is_asked_for() {
        assert_eq!(tier(None).unwrap(), None);
        assert_eq!(tier(Some(" ")).unwrap(), None);
        assert_eq!(tier(Some("ultrafast")).unwrap(), Some("ultrafast"));
        for unknown in ["priority", "flex", "Ultrafast", "default"] {
            assert!(tier(Some(unknown)).is_err(), "{unknown} reached a paid API");
        }
    }

    #[test]
    fn a_refused_tier_says_which_model_and_what_to_do() {
        let words = |error: AppError| serde_json::to_value(error).unwrap().to_string();
        let tier = words(refused("gpt-4o", 400, "Invalid service_tier argument"));
        assert!(tier.contains("does not offer Ultrafast for gpt-4o") && tier.contains("gpt-6-astra"), "{tier}");
        assert!(words(refused("gpt-6-astra", 401, "Incorrect API key provided")).contains("OpenAI API error 401: Incorrect API key provided"));
    }

    #[test]
    fn a_request_keeps_nothing_on_the_server_and_asks_for_the_tier() {
        let sent = body("gpt-6-astra", "rules", &[json!({ "role": "user", "content": "hi" })], 900, Some("ultrafast"), false);
        assert_eq!((sent["service_tier"].as_str(), sent["store"].as_bool(), sent["instructions"].as_str()), (Some("ultrafast"), Some(false), Some("rules")));
        assert_eq!(sent["max_output_tokens"], 900);
        assert!(sent.get("temperature").is_none() && sent.get("include").is_none());
        assert_eq!(body("m", "s", &[], 1, Some("ultrafast"), true)["include"][0], "reasoning.encrypted_content");
        // A model that needs this API is not a request for a faster, dearer tier.
        assert!(body("gpt-6.1-sol", "s", &[], 1, None, true).get("service_tier").is_none());
    }

    #[test]
    fn a_refusal_that_names_this_api_is_recognised_and_remembered_per_model() {
        assert!(sent_here("Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'."));
        assert!(sent_here("This model is only supported in v1/responses and not in v1/chat/completions."));
        assert!(!sent_here("Incorrect API key provided") && !sent_here("This model's maximum context length is 128000 tokens."));
        assert!(!needed_for("test-model-remembered"));
        remember(" test-model-remembered ");
        assert!(needed_for("test-model-remembered") && !needed_for("gpt-4o"));
    }

    #[test]
    fn the_answer_is_the_message_text_and_a_cut_off_answer_says_so() {
        let reply = json!({ "status": "completed", "output": [
            { "type": "reasoning", "id": "rs_1", "summary": [] },
            { "type": "message", "role": "assistant", "content": [{ "type": "output_text", "text": "Rosa " }, { "type": "refusal", "refusal": "x" }, { "type": "output_text", "text": "moved." }] },
        ] });
        assert_eq!(text(&reply), "Rosa moved.");
        assert!(!out_of_room(&reply));
        assert!(out_of_room(&json!({ "status": "incomplete", "incomplete_details": { "reason": "max_output_tokens" }, "output": [] })));
        assert!(!out_of_room(&json!({ "status": "incomplete", "incomplete_details": { "reason": "content_filter" } })));
        assert_eq!(text(&json!({})), "");
    }
}
