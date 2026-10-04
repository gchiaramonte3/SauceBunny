//! OpenAI's Responses API, used for one thing: the Ultrafast tier. OpenAI
//! offers `service_tier: "ultrafast"` there (for gpt-6-astra), up to about six
//! times faster through the API at about six times the price per token, and
//! documents it nowhere else. Every other OpenAI request keeps the Chat
//! Completions path it always had, so turning the switch off puts the app back
//! exactly where it was.
//!
//! `store: false` on every request: the Responses API otherwise keeps the
//! conversation on OpenAI's servers, which a transcript should not be just
//! because the user asked for speed. A tool loop therefore asks for its
//! reasoning back encrypted and hands it back verbatim on the next round.
//! No `temperature`: the models that offer the tier are reasoning models,
//! which refuse one.
use crate::AppError;
use serde_json::{json, Value};

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

/// One request. `reasoning` asks for the model's reasoning back (encrypted),
/// which a tool loop must return with the tool results.
pub(crate) fn body(model: &str, system: &str, input: &[Value], max_output_tokens: u32, tier: &str, reasoning: bool) -> Value {
    let mut body = json!({ "model": model, "instructions": system, "input": input, "max_output_tokens": max_output_tokens, "service_tier": tier, "store": false });
    if reasoning { body["include"] = json!(["reasoning.encrypted_content"]); }
    body
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
    fn a_request_keeps_nothing_on_the_server_and_asks_for_the_tier() {
        let sent = body("gpt-6-astra", "rules", &[json!({ "role": "user", "content": "hi" })], 900, "ultrafast", false);
        assert_eq!((sent["service_tier"].as_str(), sent["store"].as_bool(), sent["instructions"].as_str()), (Some("ultrafast"), Some(false), Some("rules")));
        assert_eq!(sent["max_output_tokens"], 900);
        assert!(sent.get("temperature").is_none() && sent.get("include").is_none());
        assert_eq!(body("m", "s", &[], 1, "ultrafast", true)["include"][0], "reasoning.encrypted_content");
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
