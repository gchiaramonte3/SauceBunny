use super::*;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{accept_hdr_async_with_config, tungstenite::{handshake::server::{Request, Response}, protocol::WebSocketConfig, Message}};

const MAX_INPUT_BYTES: usize = 128 * 1024;
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
struct ClientEnvelope {
    v: u8,
    id: String,
    #[serde(flatten)]
    command: ClientCommand,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum ClientCommand {
    Hello { token: String },
    Bind { binding: PremiereBinding },
    SetSync { enabled: bool },
    Poll { #[serde(default)] offset: usize },
    Ping { #[serde(default)] offset: usize },
    Confirm { note_id: String, binding: PremiereBinding, sequence_ticks: String, #[serde(default)] retry_confirmed: bool },
    Ack { note_id: String, binding: PremiereBinding, marker_guid: String },
    Reconcile { note_id: String, binding: PremiereBinding, outcome: String, marker_guid: Option<String> },
}

fn valid_origin(origin: Option<&str>) -> bool {
    // UXP's native WebSocket client uses the opaque `file://` Origin, not
    // the plugin's uxp:// URL. Accept that exact value, never file paths or
    // arbitrary HTTP origins. Origin is not authentication: every client
    // still needs the current 256-bit secret in its first message.
    origin.is_none_or(|s| s == "null" || s == "file://" || s.starts_with("uxp://"))
}

fn token_matches(expected: &str, supplied: &str) -> bool {
    if expected.len() != 64 || supplied.len() != 64 { return false; }
    expected.bytes().zip(supplied.bytes()).fold(0u8, |different, (a, b)| different | (a ^ b)) == 0
}

fn authenticate(state: &mut Bridge, token: &str, generation: u64, now: u64) -> Result<(), AppError> {
    if generation != state.generation || state.stop.is_none() || state.connected
        || now >= state.expires_at || !token_matches(&state.token, token) {
        return Err(AppError::invalid("Pairing unavailable, expired, or invalid. Create a new pairing in Sauce Bunny."));
    }
    state.connected = true; state.phase = "connected".into(); state.error = None;
    // A reconnected companion must explicitly restore its exact binding and
    // turn sync back on. A heartbeat cannot re-enable write authority.
    state.sync_enabled = false; Ok(())
}

fn response_snapshot(state: &Bridge, id: &str) -> Value {
    response_page(state, id, 0)
}

fn response_page(state: &Bridge, id: &str, offset: usize) -> Value {
    let mut pending: Vec<&PremiereMarkerRecord> = state.ledger.notes.iter().filter(|n|
        !matches!(n.status, PremiereMarkerState::Added | PremiereMarkerState::RemovedInPremiere)).collect();
    // Stable order inside a binding. A backlog for a different project must
    // not starve the editor's currently bound sequence. Explicit pagination
    // still exposes every retained note and its original binding to restore.
    pending.sort_by_key(|n| !state.binding.as_ref().is_some_and(|b| b.same_target(&n.request.anchor.binding)));
    let total = pending.len();
    let offset = offset.min(total.saturating_sub(1) / 100 * 100);
    let mut notes: Vec<_> = pending.into_iter().skip(offset).take(100).collect();
    if offset == 0 {
        notes.extend(state.ledger.notes.iter().rev().filter(|n|
            matches!(n.status, PremiereMarkerState::Added | PremiereMarkerState::RemovedInPremiere)).take(20));
    }
    json!({ "v": 1, "id": id, "type": "snapshot", "status": state.snapshot(), "notes": notes,
        "page": { "offset": offset, "total": total, "hasMore": offset + 100 < total } })
}

fn handle(state: &mut Bridge, message: ClientEnvelope) -> Result<Value, AppError> {
    match message.command {
        ClientCommand::Hello { .. } => return Err(AppError::invalid("This connection is already paired")),
        ClientCommand::Bind { binding } => {
            binding.validate()?;
            if !state.binding.as_ref().is_some_and(|b| b.same_target(&binding)) { state.sync_enabled = false; }
            state.binding = Some(binding);
        },
        ClientCommand::SetSync { enabled } => {
            if enabled && state.binding.is_none() { return Err(AppError::invalid("Bind a project and sequence before enabling marker sync")); }
            state.sync_enabled = enabled;
        },
        ClientCommand::Poll { offset } | ClientCommand::Ping { offset } => return Ok(response_page(state, &message.id, offset)),
        ClientCommand::Confirm { note_id, binding, sequence_ticks, retry_confirmed } => {
            let note = state.confirm(&note_id, &binding, &sequence_ticks, retry_confirmed)?;
            return Ok(json!({ "v": 1, "id": message.id, "type": "insert", "note": note }));
        },
        ClientCommand::Ack { note_id, binding, marker_guid } => state.acknowledge(&note_id, &binding, &marker_guid)?,
        ClientCommand::Reconcile { note_id, binding, outcome, marker_guid } => {
            if outcome == "found" {
                state.acknowledge(&note_id, &binding, marker_guid.as_deref().ok_or_else(|| AppError::invalid("Native marker GUID required"))?)?;
            } else {
                if !matches!(outcome.as_str(), "absent" | "undone") { return Err(AppError::invalid("Unknown marker reconciliation outcome")); }
                let mut ledger = state.ledger.clone();
                let note = ledger.notes.iter_mut().find(|n| n.id == note_id).ok_or_else(|| AppError::invalid("Unknown Premiere note"))?;
                state.require_binding(&binding, &note.request.anchor.binding)?;
                if note.status == PremiereMarkerState::NeedsConfirmation {
                    return Err(AppError::invalid("This note has not been dispatched"));
                }
                if outcome == "undone" || matches!(note.status, PremiereMarkerState::Added | PremiereMarkerState::RemovedInPremiere) {
                    note.status = PremiereMarkerState::RemovedInPremiere;
                    note.error = Some("Removed or undone in Premiere. Sauce Bunny will not recreate this marker.".into());
                } else {
                    note.status = PremiereMarkerState::Uncertain;
                    note.error = Some("No matching marker was found. Explicitly confirm a retry only if a new marker is wanted.".into());
                }
                state.commit(ledger)?;
            }
        },
    }
    Ok(response_snapshot(state, &message.id))
}

fn decode(text: &str) -> Result<ClientEnvelope, AppError> {
    if text.len() > MAX_INPUT_BYTES { return Err(AppError::invalid("Premiere command exceeds the message limit")); }
    let message: ClientEnvelope = serde_json::from_str(text).map_err(|_| AppError::invalid("Invalid Premiere command"))?;
    if message.v != 1 || !bounded(&message.id, 128) { return Err(AppError::invalid("Unsupported Premiere bridge protocol or request identity")); }
    Ok(message)
}

pub async fn start(app: AppHandle) -> Result<PremierePairing, AppError> {
    let bridge = instance(&app)?;
    let (ipv4, ipv6) = bind_loopback().await?;
    let port = ipv4.local_addr()?.port();
    let mut secret = [0u8; 32]; getrandom::getrandom(&mut secret).map_err(|_| AppError::internal("Cannot create Premiere pairing"))?;
    let token = hex::encode(secret);
    let expires_at = now_ms() + PAIR_LIFETIME_MS;
    let (stop, receiver) = watch::channel(false);
    let generation = {
        let mut state = lock(&bridge)?;
        if let Some(old) = state.stop.take() { let _ = old.send(true); }
        state.disconnected()?;
        state.generation += 1;
        state.stop = Some(stop); state.phase = "pairing".into(); state.binding = None;
        state.token = token.clone(); state.expires_at = expires_at; state.error = None;
        state.generation
    };
    publish(&app, &bridge);
    tokio::spawn(serve(ipv4, ipv6, app, bridge, generation, receiver));
    Ok(PremierePairing { url: format!("ws://127.0.0.1:{port}/premiere"), token, expires_at })
}

// The manifest-approved localhost name can resolve to either address family.
// Bind the same port on both loopback addresses; never bind an unspecified
// address or rely on the native client retrying IPv4 after an IPv6 refusal.
async fn bind_loopback() -> std::io::Result<(TcpListener, TcpListener)> {
    let ipv4 = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let ipv6 = TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, ipv4.local_addr()?.port())).await?;
    Ok((ipv4, ipv6))
}

async fn serve(ipv4: TcpListener, ipv6: TcpListener, app: AppHandle, bridge: Arc<PremiereBridge>, generation: u64, mut stop: watch::Receiver<bool>) {
    let slots = Arc::new(tokio::sync::Semaphore::new(4));
    loop {
        let accepted = tokio::select! {
            _ = stop.changed() => break,
            accepted = ipv4.accept() => accepted,
            accepted = ipv6.accept() => accepted,
        };
        let Ok((stream, address)) = accepted else { break; };
        if !address.ip().is_loopback() { continue; }
        let Ok(permit) = slots.clone().try_acquire_owned() else { continue; };
        let app = app.clone(); let bridge = bridge.clone(); let stop = stop.clone();
        tokio::spawn(async move { let _permit = permit; connection(stream, app, bridge, generation, stop).await; });
    }
}

// Shared with the real-socket tests so the packaged companion's Host header
// is checked at the same boundary as production, not against a second parser.
#[allow(clippy::result_large_err)]
fn handshake_response(request: &Request, response: Response, port: u16) -> Result<Response, tokio_tungstenite::tungstenite::handshake::server::ErrorResponse> {
    if let Some(reason) = handshake_rejection(request, port) {
        let mut rejected = tokio_tungstenite::tungstenite::http::Response::new(Some(reason.into()));
        *rejected.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
        return Err(rejected);
    }
    Ok(response)
}

fn handshake_rejection(request: &Request, port: u16) -> Option<&'static str> {
    // UXP uses the manifest-approved localhost alias. Accept only these two
    // exact authorities on the listener's port; never an arbitrary hostname,
    // wildcard, or DNS-derived address. Both listeners remain loopback-only.
    let ipv4_host = format!("127.0.0.1:{port}");
    let localhost = format!("localhost:{port}");
    let host = request.headers().get("host").and_then(|s| s.to_str().ok());
    let allowed_host = host == Some(ipv4_host.as_str()) || host == Some(localhost.as_str());
    let origin = request.headers().get("origin").map(|s| s.to_str().unwrap_or("invalid"));
    if request.uri().path_and_query().map(|p| p.as_str()) != Some("/premiere") {
        return Some("Companion connection rejected: unexpected pairing path.");
    }
    if !allowed_host || request.headers().get_all("host").iter().count() != 1 {
        return Some("Companion connection rejected: the address does not match this pairing port.");
    }
    if request.headers().get_all("origin").iter().count() > 1 || !valid_origin(origin) {
        return Some("Companion connection rejected: the client supplied an unsupported Origin header.");
    }
    None
}

// Report stages, not raw requests: headers, tokens, URLs and Adobe project
// data never belong in a connection error. A stale or unauthenticated socket
// must not overwrite the status of a successfully paired companion.
fn connection_failed(app: &AppHandle, bridge: &Arc<PremiereBridge>, generation: u64, reason: &str) {
    if let Ok(mut state) = lock(bridge) {
        if state.generation != generation || state.connected { return; }
        state.error = Some(reason.into());
    }
    publish(app, bridge);
}

// tungstenite's required handshake callback returns an unboxed HTTP response.
#[allow(clippy::result_large_err)]
async fn connection(stream: TcpStream, app: AppHandle, bridge: Arc<PremiereBridge>, generation: u64, mut stop: watch::Receiver<bool>) {
    let port = match stream.local_addr() { Ok(addr) => addr.port(), Err(_) => return };
    let config = WebSocketConfig::default().max_message_size(Some(MAX_INPUT_BYTES)).max_frame_size(Some(MAX_INPUT_BYTES))
        .max_write_buffer_size(MAX_OUTPUT_BYTES).write_buffer_size(0);
    let handshake_app = app.clone(); let handshake_bridge = bridge.clone();
    let handshake = accept_hdr_async_with_config(stream, move |request: &Request, response: Response| {
        if let Some(reason) = handshake_rejection(request, port) {
            connection_failed(&handshake_app, &handshake_bridge, generation, reason);
        }
        handshake_response(request, response, port)
    }, Some(config));
    let mut ws = tokio::select! {
        _ = stop.changed() => return,
        result = tokio::time::timeout(Duration::from_secs(3), handshake) => match result { Ok(Ok(ws)) => ws, _ => return }
    };
    let first = tokio::select! {
        _ = stop.changed() => return,
        result = tokio::time::timeout(Duration::from_secs(3), ws.next()) => match result { Ok(Some(Ok(Message::Text(text)))) => text, _ => {
            connection_failed(&app, &bridge, generation, "The companion opened a connection but did not send its pairing acknowledgement in time.");
            return;
        } }
    };
    let Ok(message) = decode(&first) else { return; };
    let ClientCommand::Hello { token } = message.command else { return; };
    let response = match lock(&bridge).and_then(|mut state| {
        authenticate(&mut state, &token, generation, now_ms())?; Ok(response_snapshot(&state, &message.id))
    }) { Ok(response) => response, Err(_) => {
        connection_failed(&app, &bridge, generation, "Pairing expired or was superseded. Copy a new pairing code from this app.");
        return;
    } };
    publish(&app, &bridge);
    let first_sent = tokio::time::timeout(Duration::from_secs(3), ws.send(Message::Text(response.to_string().into()))).await;
    if matches!(first_sent, Ok(Ok(()))) {
        loop {
            let input = tokio::select! {
                _ = stop.changed() => break,
                input = tokio::time::timeout(Duration::from_secs(30), ws.next()) => match input { Ok(Some(Ok(input))) => input, _ => break }
            };
            let text = match input { Message::Text(text) => text, Message::Ping(_) | Message::Pong(_) => continue, _ => break };
            let Ok(message) = decode(&text) else { break; };
            let id = message.id.clone();
            let result = lock(&bridge).and_then(|mut state| {
                if state.generation != generation || !state.connected { return Err(AppError::invalid("Premiere pairing has been revoked")); }
                let before = state.snapshot();
                let response = handle(&mut state, message)?;
                Ok((response, before != state.snapshot()))
            });
            let (response, changed) = match result { Ok(result) => result, Err(error) => (json!({ "v": 1, "id": id, "type": "error", "error": error.to_string() }), false) };
            if changed { publish(&app, &bridge); }
            let payload = response.to_string();
            if payload.len() > MAX_OUTPUT_BYTES { break; }
            if !matches!(tokio::time::timeout(Duration::from_secs(3), ws.send(Message::Text(payload.into()))).await, Ok(Ok(()))) { break; }
        }
    }
    if let Ok(mut state) = lock(&bridge) {
        if state.generation == generation {
            if let Err(error) = state.disconnected() { state.error = Some(error.to_string()); }
        }
    }
    publish(&app, &bridge);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn localhost_pairing_reaches_both_loopback_families_on_one_port() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let (ipv4, ipv6) = bind_loopback().await.unwrap();
        let v4 = ipv4.local_addr().unwrap();
        let v6 = ipv6.local_addr().unwrap();
        assert_eq!(v4.ip(), std::net::Ipv4Addr::LOCALHOST);
        assert_eq!(v6.ip(), std::net::Ipv6Addr::LOCALHOST);
        assert_eq!(v4.port(), v6.port());
        for listener in [ipv4, ipv6] {
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, remote) = listener.accept().await.unwrap();
                assert!(remote.ip().is_loopback());
                #[allow(clippy::result_large_err)]
                let check = move |request: &Request, response: Response| handshake_response(request, response, address.port());
                accept_hdr_async_with_config(stream, check, None).await.is_ok()
            });
            let request = format!("ws://localhost:{}/premiere", address.port()).into_client_request().unwrap();
            let stream = TcpStream::connect(address).await.unwrap();
            let result = tokio::time::timeout(Duration::from_secs(3), tokio_tungstenite::client_async(request, stream)).await.unwrap();
            assert!(result.is_ok(), "{address}: {result:?}");
            assert!(server.await.unwrap());
        }
    }

    #[test]
    fn handshake_rejects_missing_duplicate_and_wrong_port_hosts() {
        for host in [None, Some("localhost"), Some("localhost:51701"), Some("127.0.0.1:51701"),
            Some("localhost.:51700"), Some("127.0.0.1.evil.test:51700"), Some("[::1]:51700")] {
            let mut request = Request::builder().uri("/premiere");
            if let Some(host) = host { request = request.header("host", host); }
            assert!(handshake_response(&request.body(()).unwrap(), Response::new(()), 51700).is_err());
        }
        let request = Request::builder().uri("/premiere").header("host", "localhost:51700")
            .header("host", "evil.test:51700").body(()).unwrap();
        assert!(handshake_response(&request, Response::new(()), 51700).is_err());
    }

    #[tokio::test]
    async fn real_websocket_accepts_companion_localhost_and_rejects_other_authorities() {
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Error};
        for (host, path, origin, accepted) in [
            ("localhost", "/premiere", None, true),
            ("127.0.0.1", "/premiere", Some("uxp://plugin"), true),
            ("localhost", "/premiere", Some("file://"), true),
            ("localhost.evil.test", "/premiere", None, false),
            ("evil.test", "/premiere", None, false),
            ("localhost", "/premiere?token=not-allowed", None, false),
            ("localhost", "/other", None, false),
            ("localhost", "/premiere", Some("http://localhost"), false),
            ("localhost", "/premiere", Some("file:///plugin/index.html"), false),
            ("localhost", "/premiere", Some("file://evil.test"), false),
        ] {
            let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                #[allow(clippy::result_large_err)]
                let check = move |request: &Request, response: Response| handshake_response(request, response, address.port());
                accept_hdr_async_with_config(stream, check, None).await.is_ok()
            });
            let mut request = format!("ws://{host}:{}{path}", address.port()).into_client_request().unwrap();
            if let Some(origin) = origin { request.headers_mut().insert("origin", origin.parse().unwrap()); }
            // Connect to the actual IPv4 listener while preserving the Host
            // authority sent by UXP. No credential or marker command is sent.
            let stream = TcpStream::connect(address).await.unwrap();
            let result = tokio::time::timeout(Duration::from_secs(3), tokio_tungstenite::client_async(request, stream)).await.unwrap();
            if accepted {
                assert!(result.is_ok(), "{host}{path}: {result:?}");
            } else {
                assert!(matches!(result, Err(Error::Http(ref response)) if response.status().as_u16() == 403));
            }
            assert_eq!(server.await.unwrap(), accepted);
        }
    }

    fn state() -> Bridge {
        Bridge::open(std::env::temp_dir().join(format!("sauce-premiere-socket-{}.json", uuid::Uuid::new_v4()))).unwrap()
    }

    #[test]
    fn browser_origins_and_bad_tokens_are_refused() {
        assert!(valid_origin(None)); assert!(valid_origin(Some("null"))); assert!(valid_origin(Some("uxp://plugin")));
        assert!(valid_origin(Some("file://")));
        for origin in ["https://evil.test", "http://127.0.0.1:5173", "file:///index.html", "file://evil.test", "https://uxp://evil"] { assert!(!valid_origin(Some(origin))); }
        let secret = "a".repeat(64); assert!(token_matches(&secret, &secret));
        assert!(!token_matches(&secret, &"b".repeat(64))); assert!(!token_matches("", ""));
        assert!(!token_matches(&secret, &(secret.clone() + "a")));
    }

    #[test]
    fn handshake_diagnostics_are_stage_specific_without_echoing_headers() {
        for (path, host, origin, expected) in [
            ("/premiere?token=private", "localhost:51700", "file://", "unexpected pairing path"),
            ("/premiere", "private.example:51700", "file://", "address does not match"),
            ("/premiere", "localhost:51700", "https://private.example", "unsupported Origin"),
        ] {
            let request = Request::builder().uri(path).header("host", host).header("origin", origin).body(()).unwrap();
            let reason = handshake_rejection(&request, 51700).unwrap();
            assert!(reason.contains(expected));
            assert!(!reason.contains("private"));
        }
        let request = Request::builder().uri("/premiere").header("host", "localhost:51700")
            .header("origin", "file://").header("origin", "https://evil.test").body(()).unwrap();
        assert!(handshake_rejection(&request, 51700).unwrap().contains("unsupported Origin"));
    }

    #[test]
    fn command_limits_and_version_are_checked() {
        assert!(decode(r#"{"v":1,"id":"1","type":"poll"}"#).is_ok());
        assert!(decode(r#"{"v":2,"id":"1","type":"poll"}"#).is_err());
        assert!(decode(r#"{"v":1,"id":"","type":"poll"}"#).is_err());
        assert!(decode(&" ".repeat(MAX_INPUT_BYTES + 1)).is_err());
    }

    #[test]
    fn auth_is_expiring_generation_scoped_and_single_client() {
        let mut bridge = state(); let (stop, _) = watch::channel(false);
        bridge.stop = Some(stop); bridge.generation = 5; bridge.token = "a".repeat(64); bridge.expires_at = 100;
        assert!(authenticate(&mut bridge, &"a".repeat(64), 4, 10).is_err());
        assert!(authenticate(&mut bridge, &"a".repeat(64), 5, 100).is_err());
        assert!(authenticate(&mut bridge, &"b".repeat(64), 5, 10).is_err());
        authenticate(&mut bridge, &"a".repeat(64), 5, 10).unwrap();
        assert!(!bridge.sync_enabled); assert!(bridge.connected);
        assert!(authenticate(&mut bridge, &"a".repeat(64), 5, 11).is_err());
        bridge.connected = false; bridge.stop = None;
        assert!(authenticate(&mut bridge, &"a".repeat(64), 5, 11).is_err());
    }

    #[test]
    fn serialized_snapshot_never_contains_pairing_secret() {
        let mut bridge = state(); bridge.token = "never-send-this-secret".into();
        let snapshot = response_snapshot(&bridge, "snapshot-1").to_string();
        assert!(!snapshot.contains("never-send-this-secret")); assert!(!snapshot.contains("token"));
        assert!(snapshot.contains("\"automaticPlacement\":false"));
    }

    #[test]
    fn explicit_confirm_echoes_command_identity_and_undo_stays_removed() {
        use super::super::tests::{binding, ready, request, TempQueue};
        let temp = TempQueue::new(); let mut state = temp.bridge(); ready(&mut state);
        let note = state.enqueue(request()).unwrap();
        let confirm = decode(&json!({"v":1,"id":"user-gesture-7","type":"confirm","noteId":note.id,
            "binding":binding(),"sequenceTicks":"10584000000"}).to_string()).unwrap();
        let inserted = handle(&mut state, confirm).unwrap();
        assert_eq!(inserted["type"], "insert"); assert_eq!(inserted["id"], "user-gesture-7");
        assert_eq!(temp.bridge().ledger.notes[0].status, PremiereMarkerState::Uncertain);
        handle(&mut state, decode(&json!({"v":1,"id":"ack-7","type":"ack","noteId":note.id,
            "binding":binding(),"markerGuid":"marker-7"}).to_string()).unwrap()).unwrap();
        handle(&mut state, decode(&json!({"v":1,"id":"undo-7","type":"reconcile","noteId":note.id,
            "binding":binding(),"outcome":"undone"}).to_string()).unwrap()).unwrap();
        assert_eq!(temp.bridge().ledger.notes[0].status, PremiereMarkerState::RemovedInPremiere);
        assert!(state.confirm(&note.id, &binding(), "10584000000", true).is_err());
        assert_eq!(state.enqueue(request()).unwrap().status, PremiereMarkerState::RemovedInPremiere);
    }

    #[test]
    fn heartbeat_never_dispatches_and_rebind_revokes_sync() {
        use super::super::tests::{binding, ready, request, TempQueue};
        let temp = TempQueue::new(); let mut state = temp.bridge(); ready(&mut state);
        state.enqueue(request()).unwrap();
        let before_heartbeat = state.snapshot();
        for _ in 0..5 {
            let result = handle(&mut state, decode(r#"{"v":1,"id":"heartbeat","type":"ping"}"#).unwrap()).unwrap();
            assert_eq!(result["type"], "snapshot");
            assert_eq!(state.ledger.notes[0].status, PremiereMarkerState::NeedsConfirmation);
            assert_eq!(state.snapshot(), before_heartbeat);
        }
        let mut changed = binding(); changed.binding_id = "different-explicit-binding".into();
        handle(&mut state, decode(&json!({"v":1,"id":"bind","type":"bind","binding":changed}).to_string()).unwrap()).unwrap();
        assert!(!state.sync_enabled); assert_eq!(state.ledger.notes[0].request.anchor.binding, binding());
    }

    #[test]
    fn lost_ack_can_reconcile_existing_marker_without_reinsertion() {
        use super::super::tests::{binding, ready, request, TempQueue};
        let temp = TempQueue::new(); let mut state = temp.bridge(); ready(&mut state);
        let note = state.enqueue(request()).unwrap(); state.confirm(&note.id, &binding(), "10584000000", false).unwrap();
        state.disconnected().unwrap(); ready(&mut state);
        let result = handle(&mut state, decode(&json!({"v":1,"id":"reconcile","type":"reconcile","noteId":note.id,
            "binding":binding(),"outcome":"found","markerGuid":"existing-guid"}).to_string()).unwrap()).unwrap();
        assert_eq!(result["type"], "snapshot"); assert_eq!(state.ledger.notes[0].status, PremiereMarkerState::Added);
        assert_eq!(temp.bridge().ledger.notes[0].marker_guid.as_deref(), Some("existing-guid"));
    }

    #[test]
    fn other_bindings_cannot_starve_current_notes_and_every_page_is_reachable() {
        use super::super::tests::{binding, ready, request, TempQueue};
        let temp = TempQueue::new(); let mut state = temp.bridge(); ready(&mut state);
        let template = state.enqueue(request()).unwrap(); state.ledger.notes.clear();
        for index in 0..150 {
            let mut old = template.clone(); old.request.comment_id = format!("old-{index}");
            old.request.anchor.binding.binding_id = "old-project-binding".into(); old.id = old.request.identity();
            state.ledger.notes.push(old);
        }
        state.ledger.notes.push(template.clone());
        let page = response_page(&state, "page", 0);
        assert_eq!(page["notes"][0]["id"], template.id);
        assert_eq!(page["status"]["otherBindingPendingCount"], 150);
        assert_eq!(page["page"]["total"], 151); assert_eq!(page["page"]["hasMore"], true);
        let next = handle(&mut state, decode(r#"{"v":1,"id":"next","type":"poll","offset":100}"#).unwrap()).unwrap();
        assert_eq!(next["notes"].as_array().unwrap().len(), 51);
        assert_eq!(next["page"]["offset"], 100); assert_eq!(next["page"]["hasMore"], false);
        assert_eq!(state.binding, Some(binding()));
        let mut identities = std::collections::HashSet::new();
        for note in page["notes"].as_array().unwrap().iter().chain(next["notes"].as_array().unwrap()) {
            assert!(identities.insert(note["id"].as_str().unwrap()));
        }
        assert_eq!(identities.len(), 151);
    }
}
