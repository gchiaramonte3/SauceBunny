//! Keeping Ask's conversation inside the model's window.
//!
//! Every lookup Ask makes stays in the conversation, so the model can cite
//! it, and a transcript page is up to about 16,000 tokens. A question about a
//! whole transcript that the model answers by paging rather than scanning
//! grew past gpt-4o's 128,000 tokens on a real group and came back as the
//! provider's refusal ("This model's maximum context length is 128000
//! tokens. However, you requested 129232 tokens"), losing the whole run.
//!
//! Each provider says how far over it is. When one does, the oldest lookup
//! results are set aside, replaced by a line telling the model to ask again
//! if it still needs them, until the request fits, and the round is sent
//! again. No table of window sizes is kept: the refusal is the measurement.
use serde_json::Value;

/// What a set-aside result says to the model in its place.
pub(crate) const SET_ASIDE: &str = "(Set aside to make room in the conversation. Look it up again, narrower, if it is still needed; scan finds a topic without reading every line.)";

/// How many times one round may be shrunk and sent again before giving up.
pub(crate) const RETRIES: usize = 3;

/// A refusal for length: the window and what was asked for, in tokens, when the provider says.
#[derive(Debug, PartialEq)]
pub(crate) struct Overflow { pub limit: Option<u64>, pub asked: Option<u64> }

/// Whether a provider's error message is a refusal for length, and its numbers.
/// OpenAI: "maximum context length is 128000 tokens. However, you requested
/// 129232 tokens". Claude: "prompt is too long: 210000 tokens > 200000
/// maximum". The Responses API: "exceeds the context window", no numbers.
pub(crate) fn overflow(message: &str) -> Option<Overflow> {
    let lower = message.to_ascii_lowercase();
    let number_after = |marker: &str| lower.find(marker).and_then(|at| {
        lower[at + marker.len()..].trim_start().split(|c: char| !c.is_ascii_digit()).next().and_then(|digits| digits.parse::<u64>().ok())
    });
    if lower.contains("maximum context length") {
        return Some(Overflow { limit: number_after("maximum context length is"), asked: number_after("you requested") });
    }
    if lower.contains("prompt is too long") {
        let asked = number_after("prompt is too long:");
        let limit = lower.find('>').and_then(|at| lower[at + 1..].trim_start().split(|c: char| !c.is_ascii_digit()).next().and_then(|d| d.parse().ok()));
        return Some(Overflow { limit, asked });
    }
    (lower.contains("context window") || lower.contains("context_length_exceeded") || lower.contains("too many tokens"))
        .then_some(Overflow { limit: None, asked: None })
}

/// The text of every tool result in a conversation, oldest first, in each
/// provider's shape: Claude's `tool_result` blocks, Chat Completions' `tool`
/// messages, and the Responses API's `function_call_output` items.
fn results(conversation: &mut [Value]) -> Vec<&mut Value> {
    let mut found = Vec::new();
    for item in conversation.iter_mut() {
        if item["role"] == "tool" {
            if let Some(content) = item.get_mut("content") { found.push(content); }
        } else if item["type"] == "function_call_output" {
            if let Some(output) = item.get_mut("output") { found.push(output); }
        } else if item["role"] == "user" {
            if let Some(blocks) = item.get_mut("content").and_then(Value::as_array_mut) {
                found.extend(blocks.iter_mut().filter(|block| block["type"] == "tool_result").filter_map(|block| block.get_mut("content")));
            }
        }
    }
    found
}

/// Set aside the oldest tool results until about `chars` characters are
/// freed. With the window unknown, half of what the results hold. Returns
/// whether anything was set aside: nothing left to set aside means the
/// question itself, or the answer room, is what does not fit.
pub(crate) fn make_room(conversation: &mut [Value], found: &Overflow, answer_tokens: u64) -> bool {
    let total: usize = conversation.iter().map(|item| item.to_string().len()).sum();
    let mut held: Vec<&mut Value> = results(conversation).into_iter().filter(|text| text.as_str().is_some_and(|text| text != SET_ASIDE)).collect();
    let in_results: usize = held.iter().map(|text| text.as_str().map_or(0, str::len)).sum();
    let need = match (found.limit, found.asked) {
        (Some(limit), Some(asked)) if asked > 0 => {
            // What is over, plus a twentieth of the window so the next round's lookup has somewhere to go, in characters at this conversation's own rate.
            let over = asked.saturating_sub(limit) + limit / 20 + answer_tokens.min(limit / 10);
            let per_token = total as f64 / asked as f64;
            (over as f64 * per_token).ceil() as usize
        }
        _ => in_results / 2,
    };
    let mut freed = 0;
    for text in held.iter_mut() {
        if freed >= need.max(1) { break; }
        freed += text.as_str().map_or(0, str::len);
        **text = Value::String(SET_ASIDE.into());
    }
    freed > 0
}

/// What the editor reads when even the question will not fit.
pub(crate) fn too_long(name: &str, model: &str, found: &Overflow) -> crate::AppError {
    let window = found.limit.map(|limit| format!(" ({} tokens)", group(limit))).unwrap_or_default();
    crate::AppError::invalid(format!("The conversation is longer than {model}'s window{window}, even with earlier lookups set aside. \
        Ask something narrower, clear the conversation, or choose a model with a larger window in Settings ▸ AI APIs. ({name})"))
}

fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) { out.push(','); }
        out.push(digit);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_each_providers_refusal_for_length() {
        assert_eq!(overflow("This model's maximum context length is 128000 tokens. However, you requested 129232 tokens (125136 in the messages, 4096 in the completion). Please reduce the length of the messages or completion."),
            Some(Overflow { limit: Some(128_000), asked: Some(129_232) }));
        assert_eq!(overflow("prompt is too long: 210417 tokens > 200000 maximum"), Some(Overflow { limit: Some(200_000), asked: Some(210_417) }));
        assert_eq!(overflow("Your input exceeds the context window of this model. Please adjust your input and try again."), Some(Overflow { limit: None, asked: None }));
        assert_eq!(overflow("Incorrect API key provided"), None);
        assert_eq!(overflow("Invalid service_tier argument"), None);
    }

    #[test]
    fn sets_aside_the_oldest_results_first_and_only_as_many_as_it_must() {
        let page = "L1234567 21:10:00:00-21:10:02:00 DONNIE (A1): words words words words\n".repeat(400);
        // Chat Completions: the oldest two pages go, the newest stays.
        let mut chat = vec![json!({ "role": "system", "content": "rules" }), json!({ "role": "user", "content": "the question" })];
        for n in 0..3 { chat.push(json!({ "role": "assistant", "tool_calls": [{ "id": n }] })); chat.push(json!({ "role": "tool", "tool_call_id": n, "content": page })); }
        let total: usize = chat.iter().map(|item| item.to_string().len()).sum();
        let tokens = (total / 4) as u64;
        // Over by about one page.
        let found = Overflow { limit: Some(tokens - (page.len() / 4) as u64 + 200), asked: Some(tokens) };
        assert!(make_room(&mut chat, &found, 100));
        let kept: Vec<bool> = chat.iter().filter(|item| item["role"] == "tool").map(|item| item["content"] != SET_ASIDE).collect();
        assert_eq!(kept, [false, false, true], "the newest page should stay");
        assert_eq!(chat[1]["content"], "the question");
        // Claude's tool_result blocks and the Responses API's outputs are found the same way.
        let mut claude = vec![json!({ "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "a", "content": page }] })];
        assert!(make_room(&mut claude, &Overflow { limit: None, asked: None }, 100));
        assert_eq!(claude[0]["content"][0]["content"], SET_ASIDE);
        let mut responses = vec![json!({ "type": "function_call_output", "call_id": "a", "output": page }), json!({ "type": "function_call_output", "call_id": "b", "output": page })];
        assert!(make_room(&mut responses, &Overflow { limit: None, asked: None }, 100));
        assert_eq!((responses[0]["output"] == SET_ASIDE, responses[1]["output"] == SET_ASIDE), (true, false));
        // Nothing left to set aside: the caller says so instead of looping.
        let mut bare = vec![json!({ "role": "user", "content": "a very long question" })];
        assert!(!make_room(&mut bare, &found, 100));
        assert!(serde_json::to_string(&too_long("ChatGPT", "gpt-4o", &Overflow { limit: Some(128_000), asked: None })).unwrap().contains("gpt-4o's window (128,000 tokens)"));
    }
}
