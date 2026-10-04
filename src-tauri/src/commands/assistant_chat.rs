//! The in-app assistant's tool loop: Claude, ChatGPT or the local model
//! answers a question by calling the context layer's read tools (the same
//! registry `sauce-bunny --mcp` serves) as many times as it needs, instead of
//! having whole transcripts pasted in. The loop runs here, so a cloud key
//! never leaves Rust and a tool reads the stores with the app's own code.
//!
//! Read-only, by the owner's decision (docs/AI-ACCESS-SPEC-2026-10-03.md):
//! the model can look things up and propose; the editor applies. One extra
//! tool, `get_app_state`, returns what is on screen, which the app sends with
//! the question (the outside MCP server has no such tool: it cannot see the
//! app, and the owner chose not to give it a channel in).
//!
//! Stop: the caller's request id is registered in `cloud_ai`'s cancel map
//! before any network I/O, so `cloud_chat_cancel` stops this loop too, mid
//! request or between rounds.
use super::cloud_ai::{chat_cancels, entry, post_and_read, provider_error, CancelGuard};
use super::llm::LlmServer;
use crate::context::{tools, Context, Roots};
use crate::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tokio::sync::Notify;

/// Rounds of tool calls before the model must answer with what it has.
const MAX_ROUNDS: u32 = 10;
/// One tool result, at most, in characters: a page is built to fit under this already.
const MAX_RESULT_CHARS: usize = 80_000;
const ANSWER_TOKENS: u32 = 4_096;

#[derive(Deserialize)]
pub struct AssistantMessage { pub role: String, pub content: String }

#[derive(Deserialize)]
pub struct AssistantChatArgs {
    /// "anthropic", "openai" or "local".
    pub provider: String,
    /// The provider's model id (ignored by the local server, which runs one model).
    pub model: String,
    pub system: String,
    pub messages: Vec<AssistantMessage>,
    /// What is on screen (open string out, playhead, selection, marks), returned by `get_app_state`.
    pub app_state: Option<Value>,
    /// The Transcripts library when the user moved it; else the default.
    pub library: Option<String>,
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AssistantReply {
    /// The model's final answer.
    pub text: String,
    /// The tools it called, in order, for the status line and diagnostics.
    pub tools_used: Vec<String>,
}

/// The context, kept between questions so a large sequence is parsed once.
#[derive(Default)]
pub struct AssistantContext(Mutex<Option<(String, Arc<Context>)>>);

fn context(app: &AppHandle, held: &AssistantContext, library: Option<&str>) -> Result<Arc<Context>, AppError> {
    let documents = app.path().document_dir().map_err(|e| AppError::internal(e.to_string()))?.join("Sauce Bunny");
    let roots = Roots {
        multitrack: documents.join("Transcripts").join("Multitrack"),
        timelines: app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?.join("timelines.sqlite"),
        transcripts: library.filter(|path| !path.trim().is_empty()).map(std::path::PathBuf::from).unwrap_or_else(|| documents.join("Transcripts")),
    };
    let key = format!("{roots:?}");
    let mut guard = held.0.lock().map_err(|_| AppError::internal("assistant context lock"))?;
    if let Some((kept, ctx)) = guard.as_ref() { if *kept == key { return Ok(ctx.clone()); } }
    let ctx = Arc::new(Context::new(roots));
    *guard = Some((key, ctx.clone()));
    Ok(ctx)
}

const APP_STATE: &str = "get_app_state";

/// The tools as each provider spells them: the registry plus `get_app_state`.
fn definitions() -> Vec<(String, String, Value)> {
    let mut out: Vec<(String, String, Value)> = tools::TOOLS.iter().map(|tool| (tool.name.to_string(), tool.description.to_string(), (tool.input)())).collect();
    out.push((APP_STATE.into(), "What the editor has on screen in Sauce Bunny now: the open string out, the record playhead, the selection (as line addresses and text) and the In and Out marks. Use it when they say \"this\", \"here\", \"the selection\" or \"this string out\".".into(),
        json!({ "type": "object", "properties": {}, "additionalProperties": false })));
    out
}

/// Run one tool call, as text for the model: a result, or what went wrong so it can ask again.
async fn run(ctx: Arc<Context>, app_state: Option<Value>, name: String, input: Value) -> (String, bool) {
    if name == APP_STATE {
        return (app_state.map(|state| state.to_string()).unwrap_or_else(|| "{\"note\":\"Nothing is open on screen.\"}".into()), false);
    }
    let result = tokio::task::spawn_blocking(move || tools::call(&ctx, &name, &input)).await;
    match result {
        Ok(Ok(value)) => {
            let mut text = value.to_string();
            if text.len() > MAX_RESULT_CHARS {
                let cut = (0..=MAX_RESULT_CHARS).rev().find(|index| text.is_char_boundary(*index)).unwrap_or(0);
                text.truncate(cut);
                text.push_str("…(cut; ask for less, or use the cursor to page)");
            }
            (text, false)
        }
        Ok(Err(error)) => (error.to_string(), true),
        Err(error) => (format!("The tool failed: {error}"), true),
    }
}

#[tauri::command]
pub async fn assistant_chat(app: AppHandle, held: State<'_, AssistantContext>, llm: State<'_, LlmServer>, args: AssistantChatArgs) -> Result<AssistantReply, AppError> {
    let ctx = context(&app, &held, args.library.as_deref())?;
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(120)).build().map_err(|e| AppError::internal(format!("http client: {e}")))?;
    // Registered before any network I/O, so Stop the instant after Send still wins.
    let cancel = args.request_id.clone().map(|id| {
        let notify = Arc::new(Notify::new());
        if let Ok(mut map) = chat_cancels().lock() { map.insert(id.clone(), notify.clone()); }
        (id, notify)
    });
    let _guard = CancelGuard(cancel.as_ref().map(|(id, _)| id.clone()));
    let cancel = cancel.map(|(_, notify)| notify);
    let tools_used = Vec::new();
    match args.provider.as_str() {
        "anthropic" => anthropic(&client, "https://api.anthropic.com/v1/messages", &key_for("anthropic")?, &args, ctx, cancel, tools_used).await,
        "openai" | "local" => {
            let (url, key) = if args.provider == "local" {
                let server = llm.current().ok_or_else(|| AppError::invalid("The local model is not running. Ask again to start it."))?;
                (format!("{}/v1/chat/completions", server.base_url), server.api_key)
            } else {
                ("https://api.openai.com/v1/chat/completions".to_string(), key_for("openai")?)
            };
            openai(&client, &url, &key, &args, ctx, cancel, tools_used).await
        }
        other => Err(AppError::invalid(format!("Unknown AI provider: {other}"))),
    }
}

fn key_for(provider: &str) -> Result<String, AppError> {
    entry(provider)?.get_password().map_err(|_| AppError::invalid(format!("No API key saved for {provider}. Add one in Settings ▸ AI APIs.")))
}

fn stopped(cancel: &Option<Arc<Notify>>) -> bool {
    // A cancel that landed between rounds left a permit; take it without waiting.
    cancel.as_ref().is_some_and(|notify| futures_util::FutureExt::now_or_never(notify.notified()).is_some())
}

async fn anthropic(client: &reqwest::Client, url: &str, key: &str, args: &AssistantChatArgs, ctx: Arc<Context>, cancel: Option<Arc<Notify>>, mut tools_used: Vec<String>) -> Result<AssistantReply, AppError> {
    let tools: Vec<Value> = definitions().into_iter().map(|(name, description, schema)| json!({ "name": name, "description": description, "input_schema": schema })).collect();
    let mut messages: Vec<Value> = args.messages.iter().map(|message| json!({ "role": message.role, "content": message.content })).collect();
    for round in 0..=MAX_ROUNDS {
        if stopped(&cancel) { return Err(AppError::invalid("Stopped.")); }
        let mut body = json!({ "model": args.model, "max_tokens": ANSWER_TOKENS, "system": args.system, "messages": messages });
        // The last round has no tools, so the model answers with what it read.
        if round < MAX_ROUNDS { body["tools"] = json!(tools); }
        let request = client.post(url).header("x-api-key", key).header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json").json(&body);
        let (status, text) = post_and_read(request, cancel.clone()).await?;
        if !status.is_success() { return Err(AppError::invalid(format!("Claude API error {}: {}", status.as_u16(), provider_error(&text)))); }
        let reply: Value = serde_json::from_str(&text)?;
        let blocks = reply["content"].as_array().cloned().unwrap_or_default();
        let calls: Vec<&Value> = blocks.iter().filter(|block| block["type"] == "tool_use").collect();
        if calls.is_empty() || reply["stop_reason"] != "tool_use" {
            if reply["stop_reason"] == "max_tokens" { return Err(AppError::invalid("Claude ran out of room before finishing. Ask something narrower.")); }
            let answer: String = blocks.iter().filter_map(|block| block["text"].as_str()).collect::<Vec<_>>().join("");
            if answer.trim().is_empty() { return Err(AppError::invalid("Claude returned an empty answer.")); }
            return Ok(AssistantReply { text: answer, tools_used });
        }
        let mut results = Vec::new();
        for call in calls {
            let name = call["name"].as_str().unwrap_or_default().to_string();
            tools_used.push(name.clone());
            let (content, is_error) = run(ctx.clone(), args.app_state.clone(), name, call["input"].clone()).await;
            results.push(json!({ "type": "tool_result", "tool_use_id": call["id"], "content": content, "is_error": is_error }));
        }
        messages.push(json!({ "role": "assistant", "content": blocks }));
        messages.push(json!({ "role": "user", "content": results }));
    }
    Err(AppError::invalid("Claude kept looking without answering. Ask something narrower."))
}

async fn openai(client: &reqwest::Client, url: &str, key: &str, args: &AssistantChatArgs, ctx: Arc<Context>, cancel: Option<Arc<Notify>>, mut tools_used: Vec<String>) -> Result<AssistantReply, AppError> {
    let local = args.provider == "local";
    let name = if local { "The local model" } else { "ChatGPT" };
    let tools: Vec<Value> = definitions().into_iter().map(|(name, description, schema)| json!({ "type": "function", "function": { "name": name, "description": description, "parameters": schema } })).collect();
    let mut messages: Vec<Value> = std::iter::once(json!({ "role": "system", "content": args.system }))
        .chain(args.messages.iter().map(|message| json!({ "role": message.role, "content": message.content }))).collect();
    for round in 0..=MAX_ROUNDS {
        if stopped(&cancel) { return Err(AppError::invalid("Stopped.")); }
        let mut body = json!({ "model": args.model, "messages": messages });
        if local {
            body["max_tokens"] = json!(ANSWER_TOKENS);
            body["temperature"] = json!(0);
            body["chat_template_kwargs"] = json!({ "enable_thinking": false });
        } else {
            body["max_completion_tokens"] = json!(ANSWER_TOKENS);
        }
        if round < MAX_ROUNDS { body["tools"] = json!(tools); }
        let request = client.post(url).header("authorization", format!("Bearer {key}")).header("content-type", "application/json").json(&body);
        let (status, text) = post_and_read(request, cancel.clone()).await?;
        if !status.is_success() { return Err(AppError::invalid(format!("{name} error {}: {}", status.as_u16(), provider_error(&text)))); }
        let reply: Value = serde_json::from_str(&text)?;
        let message = reply["choices"][0]["message"].clone();
        let calls = message["tool_calls"].as_array().cloned().unwrap_or_default();
        if calls.is_empty() {
            let answer = message["content"].as_str().unwrap_or_default().to_string();
            if answer.trim().is_empty() { return Err(AppError::invalid(format!("{name} returned an empty answer."))); }
            return Ok(AssistantReply { text: answer, tools_used });
        }
        messages.push(json!({ "role": "assistant", "content": message["content"], "tool_calls": calls }));
        for call in &calls {
            let tool = call["function"]["name"].as_str().unwrap_or_default().to_string();
            tools_used.push(tool.clone());
            // Arguments arrive as a JSON string; a malformed one is the model's to fix.
            let input: Value = call["function"]["arguments"].as_str().and_then(|raw| serde_json::from_str(raw).ok()).unwrap_or_else(|| json!({}));
            let (content, _) = run(ctx.clone(), args.app_state.clone(), tool, input).await;
            messages.push(json!({ "role": "tool", "tool_call_id": call["id"], "content": content }));
        }
    }
    Err(AppError::invalid(format!("{name} kept looking without answering. Ask something narrower.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::tests::fixture;

    #[test]
    fn every_registry_tool_is_offered_plus_what_is_on_screen() {
        let names: Vec<String> = definitions().into_iter().map(|(name, _, _)| name).collect();
        assert_eq!(names.len(), tools::TOOLS.len() + 1);
        assert!(names.contains(&APP_STATE.to_string()));
        assert!(definitions().iter().all(|(_, description, schema)| !description.is_empty() && schema["type"] == "object"));
    }

    #[tokio::test]
    async fn a_tool_call_returns_its_result_or_why_it_failed() {
        let f = fixture();
        let ctx = Arc::new(Context::new(f.ctx.roots.clone()));
        let (found, failed) = run(ctx.clone(), None, "search_transcripts".into(), json!({ "query": "tired", "people": ["P2"] })).await;
        assert!(!failed && found.contains("I am so tired"), "{found}");
        let (missing, failed) = run(ctx.clone(), None, "get_sequence".into(), json!({ "sequence": "nowhere" })).await;
        assert!(failed && missing.contains("No sequence called"), "{missing}");
        let (screen, _) = run(ctx, Some(json!({ "string_out": "saucebunny://string-out/x" })), APP_STATE.into(), json!({})).await;
        assert!(screen.contains("saucebunny://string-out/x"));
    }

    /// A stand-in model server: answers each request with the next reply, and
    /// records what it was sent.
    fn server(replies: Vec<Value>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1/chat/completions", server.server_addr().to_ip().unwrap());
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for reply in replies {
                let Ok(mut request) = server.recv() else { break };
                let mut body = String::new();
                std::io::Read::read_to_string(request.as_reader(), &mut body).unwrap();
                seen.push(serde_json::from_str(&body).unwrap());
                request.respond(tiny_http::Response::from_string(reply.to_string())).unwrap();
            }
            seen
        });
        (url, handle)
    }

    fn ask(provider: &str) -> AssistantChatArgs {
        AssistantChatArgs { provider: provider.into(), model: "m".into(), system: "s".into(), messages: vec![AssistantMessage { role: "user".into(), content: "Who is tired?".into() }],
            app_state: None, library: None, request_id: None }
    }

    #[tokio::test]
    async fn an_openai_style_model_calls_a_tool_reads_the_result_and_answers() {
        let f = fixture();
        let call = json!({ "choices": [{ "message": { "role": "assistant", "content": null, "tool_calls": [{ "id": "c1", "type": "function",
            "function": { "name": "search_transcripts", "arguments": "{\"query\":\"tired\",\"people\":[\"P2\"]}" } }] } }] });
        let done = json!({ "choices": [{ "message": { "role": "assistant", "content": "{\"answer\":\"P2 is.\",\"lines\":[],\"action\":null}" } }] });
        let (url, handle) = server(vec![call, done]);
        let reply = openai(&reqwest::Client::new(), &url, "k", &ask("local"), Arc::new(Context::new(f.ctx.roots.clone())), None, Vec::new()).await.unwrap();
        assert_eq!(reply.tools_used, ["search_transcripts"]);
        assert!(reply.text.contains("P2 is."));
        let seen = handle.join().unwrap();
        assert!(seen[0]["tools"].as_array().unwrap().len() > 5);
        // The second request carries the tool's result back to the model.
        assert!(seen[1]["messages"].as_array().unwrap().iter().any(|message| message["role"] == "tool" && message["content"].as_str().unwrap().contains("I am so tired")));
    }

    #[tokio::test]
    async fn a_claude_style_model_runs_tools_and_a_model_that_never_answers_stops_at_the_round_limit() {
        let f = fixture();
        let ctx = Arc::new(Context::new(f.ctx.roots.clone()));
        let call = json!({ "stop_reason": "tool_use", "content": [{ "type": "tool_use", "id": "t1", "name": "list_sequences", "input": {} }] });
        let done = json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": "Two sequences." }] });
        let (url, handle) = server(vec![call.clone(), done]);
        let reply = anthropic(&reqwest::Client::new(), &url, "k", &ask("anthropic"), ctx.clone(), None, Vec::new()).await.unwrap();
        assert_eq!((reply.text.as_str(), reply.tools_used.len()), ("Two sequences.", 1));
        let seen = handle.join().unwrap();
        let results = &seen[1]["messages"][2]["content"][0];
        assert_eq!((results["type"].as_str(), results["tool_use_id"].as_str()), (Some("tool_result"), Some("t1")));
        // Always asking for another tool: the last round offers none, then it gives up.
        let (url, handle) = server(vec![call; MAX_ROUNDS as usize + 1]);
        let error = anthropic(&reqwest::Client::new(), &url, "k", &ask("anthropic"), ctx, None, Vec::new()).await.unwrap_err();
        assert!(error.to_string().contains("kept looking"), "{error}");
        let seen = handle.join().unwrap();
        assert!(seen.last().unwrap().get("tools").is_none());
        assert!(seen[0].get("tools").is_some());
    }

    #[test]
    fn a_cancel_between_rounds_is_seen_without_waiting() {
        let notify = Some(Arc::new(Notify::new()));
        assert!(!stopped(&notify));
        notify.as_ref().unwrap().notify_one();
        assert!(stopped(&notify));
    }
}
