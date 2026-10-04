//! The real executable started as an MCP server, the way Claude Code and
//! Claude Desktop start it: `sauce-bunny --mcp`, JSON-RPC over stdio, with
//! HOME pointing at a fixture library. It must answer the handshake, list its
//! tools and resources, run a tool, and never print anything but protocol to
//! stdout (an MCP client treats any other line as a broken server).
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

const ID: &str = "3333333333333333333333333333333333333333333333333333333333333333";

fn library() -> std::path::PathBuf {
    let home = std::env::temp_dir().join(format!("sb-mcp-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let multitrack = home.join("Documents").join("Sauce Bunny").join("Transcripts").join("Multitrack");
    std::fs::create_dir_all(&multitrack).unwrap();
    let document = json!({
        "schema_version": 4, "id": ID, "source_path": "/fixtures/Kitchen.aaf", "source_size": 1, "source_modified_ms": 1,
        "manifest": { "schema_version": 3, "graph": null, "name": "Kitchen", "source_fingerprint": ID, "edit_rate": { "numerator": 24, "denominator": 1 },
            "start_frame": 86400, "duration_frames": 2400, "timecode_fps": 24, "drop_frame": false, "warnings": [],
            "tracks": [{ "id": "t1", "name": "Mic 1", "physical_track_number": 1, "clips": [], "warnings": [] }] },
        "labels": [{ "track_id": "t1", "owner_name": "ROSA" }],
        "transcripts": [{ "track_id": "t1", "start_frame": 0, "duration_frames": 2400, "engine": "parakeet", "model_id": "m", "status": "completed",
            "sample_rate": 16000, "timing_issues": [], "warnings": [],
            "cues": [{ "id": "c1", "start_sample": 16000, "end_sample": 40000, "text": "I knew it would be chaos.", "boundary_review": false }] }],
    });
    std::fs::write(multitrack.join(format!("{ID}.json")), serde_json::to_vec(&document).unwrap()).unwrap();
    home
}

#[test]
fn the_app_executable_serves_mcp_over_stdio() {
    let home = library();
    let mut child = Command::new(env!("CARGO_BIN_EXE_sauce-bunny")).arg("--mcp").env("HOME", &home)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("the app starts in MCP mode");
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut ask = |id: Option<u64>, method: &str, params: Value| -> Value {
        let mut message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        if let Some(id) = id { message["id"] = json!(id); }
        writeln!(input, "{message}").unwrap();
        input.flush().unwrap();
        // A notification gets no reply.
        let Some(id) = id else { return Value::Null };
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let reply: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("stdout carried something that is not JSON-RPC: {line}"));
        assert_eq!(reply["id"], id);
        reply
    };
    let hello = ask(Some(1), "initialize", json!({ "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "test", "version": "1" } }));
    assert_eq!(hello["result"]["protocolVersion"], "2025-06-18");
    ask(None, "notifications/initialized", json!({}));
    let tools = ask(Some(2), "tools/list", json!({}));
    assert!(tools["result"]["tools"].as_array().unwrap().iter().any(|tool| tool["name"] == "read_transcript"));
    assert_eq!(ask(Some(3), "resources/list", json!({}))["result"]["resources"].as_array().unwrap().len(), 3);
    let read = ask(Some(4), "tools/call", json!({ "name": "read_transcript", "arguments": { "sequence": "Kitchen", "person": "rosa" } }));
    assert_eq!(read["result"]["structuredContent"]["lines"][0]["text"], "I knew it would be chaos.");
    assert_eq!(read["result"]["structuredContent"]["lines"][0]["tc_in"], "01:00:01:00");
    // No string outs yet is an empty list, not an error.
    assert_eq!(ask(Some(5), "tools/call", json!({ "name": "list_string_outs", "arguments": {} }))["result"]["structuredContent"]["string_outs"], json!([]));
    // Closing stdin is how a client ends the session; the server then exits cleanly.
    drop(input);
    assert!(child.wait().unwrap().success());
    let _ = std::fs::remove_dir_all(home);
}
