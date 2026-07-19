//! P2P co-review ("watch party") — Phase 1 backend (r100).
//!
//! Constitution compliance: this is a peer-to-peer collab PRIMITIVE in the
//! same spirit as `stream_proxy.rs`, NOT an app backend. Nothing here serves
//! app logic over a socket:
//!
//!   - Media NEVER transits peers. Every participant plays their own copy of
//!     the source; only tiny JSON control lines (roster, load-source,
//!     transport truth) cross the wire.
//!   - Connections are iroh QUIC — dialed by endpoint public key, end-to-end
//!     encrypted. n0's public discovery + relays are connect-assist only and
//!     carry nothing but that E2E-encrypted control traffic.
//!   - A relay-URL override setting + LAN-only mode is Phase 3.
//!
//! Topology: star. The host accepts up to `MAX_PEERS` peer connections; each
//! peer opens ONE bi-directional stream and immediately sends `Hello`. The
//! wire format is newline-delimited JSON — one `SessionMsg` per line (the
//! messages are tiny; no binary framing needed in Phase 1).
//!
//! Frontend contract (do not drift — the UI is coded against these):
//!   - event `session:state` → `SessionState`, on every membership / role /
//!     error change, both roles.
//!   - event `session:msg`   → `SessionMsg`, PEER side only, for
//!     `LoadSource` + `Transport` received from the host.

use super::*;
use iroh::endpoint::{presets, Connection, SendStream};
use iroh::Endpoint;
use iroh_tickets::endpoint::EndpointTicket;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

/// Protocol identifier, exchanged in the QUIC handshake. Bump the trailing
/// version if the wire format ever changes incompatibly.
const ALPN: &[u8] = b"saucebunny/coreview/1";

/// Star topology cap: host + 3 peers = 4 people per session (Phase 1).
const MAX_PEERS: usize = 3;

/// Hard cap on a single relayed control line. Peer→host traffic is tiny (one
/// review op or a presence tick), so anything past this is abuse — drop it
/// before it can be fanned out to every other peer (×N memory amplification).
const MAX_MSG_BYTES: usize = 2 * 1024 * 1024;

/// Fallback roster display name for a host who hasn't set one.
/// `session_start` takes a display name like `session_join` does (r104);
/// this is also the reserved word guests can't claim (see `clean_name`).
const HOST_NAME: &str = "Host";

/// How long a freshly-accepted connection gets to open its stream and send
/// `Hello` before we drop it.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// End-to-end budget for a peer joining (connect + open_bi + Hello).
const JOIN_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the host waits to become relay-reachable before minting the
/// ticket anyway (LAN-only sessions still work off direct addresses).
const ONLINE_TIMEOUT: Duration = Duration::from_secs(8);

// ============================================================
// CROSS-BOUNDARY TYPES — the frontend is coded against these
// exact field names / tags. `cargo test --lib` regenerates
// src/bindings/SessionMsg.ts + SessionState.ts.
// ============================================================

#[derive(Clone, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SessionMsg {
    /// peer → host right after connect
    Hello { name: String },
    /// host → the just-registered peer: your session-scoped member id and
    /// the session's display title. (PeerList alone can't tell you which
    /// entry is you - names collide.)
    Welcome { you: String, title: Option<String> },
    /// host → everyone whenever membership changes (host is always m0, first)
    PeerList { peers: Vec<PeerInfo> },
    /// WebRTC signaling (SDP/ICE), OPAQUE JSON relayed to the addressed
    /// member only. `from` is rewritten by the host to the sender's real id
    /// so a member can't spoof another's signaling.
    Rtc { from: String, to: String, payload: String },
    /// host → everyone: load this source (web URL Phase 1)
    LoadSource { url: String },
    /// host → everyone: transport truth. at_ms = host wall clock (ms since epoch).
    Transport {
        playing: bool,
        position: f64,
        rate: f64,
        at_ms: f64,
        seq: u32,
    },
    /// A shared review mutation. `op` is a frontend-serialized JSON string
    /// (a ReviewOp) — OPAQUE to Rust, which only relays it. Flows
    /// peer→host→(other peers + host frontend), and host→all peers.
    ReviewOp { op: String },
    /// Full review-doc snapshot (opaque JSON string) — host→peers, sent when a
    /// peer joins so the newcomer converges on the shared doc.
    ReviewDoc { doc: String },
    /// Live playhead for a ghost cursor. position = seconds. Relayed like ReviewOp.
    Presence { name: String, position: f64 },
    /// Screen-share flag for the tile badge. Dumb relay; `from` is rewritten
    /// by the host to the true sender (like Rtc) so it can't be spoofed.
    Sharing { from: String, on: bool },
    /// Ephemeral live reaction (applause/confetti/thumbsup/question) or the
    /// persistent raise-hand flag (emote "hand", on=false lowers). Fire and
    /// forget: never persisted, never replayed to late joiners. `from` is
    /// rewritten by the host like Rtc/Sharing so it can't be spoofed.
    Reaction { from: String, emote: String, on: bool },
}

/// One session member: a session-scoped id (m0 = host, m1, m2, ... minted
/// at Hello, never reused) + display name. Ids are the roster key - names
/// are display-only and can collide.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
}

#[derive(Clone, serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct SessionState {
    pub role: String,          // "off" | "host" | "peer"
    pub code: Option<String>,  // host: the join ticket to share
    pub peers: Vec<PeerInfo>,  // host: connected peers / peer: full roster via PeerList
    pub self_id: Option<String>, // your member id: host "m0"; peer via Welcome
    pub title: Option<String>, // session display name (host-chosen, optional)
    pub error: Option<String>, // last error, cleared on state change
}

// ============================================================
// SESSION MANAGER — managed state (`.manage()` in lib.rs).
//
// Lock order (deadlock-free by construction): manager mutex FIRST,
// then the host `peers` mutex. Connection tasks that only touch the
// peers list must RELEASE it before calling `emit_state_now` (which
// re-acquires manager → peers).
// ============================================================

pub struct SessionManager {
    inner: AsyncMutex<Inner>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self {
            inner: AsyncMutex::new(Inner {
                session: Session::Off,
                generation: 0,
                last_error: None,
            }),
        }
    }
}

struct Inner {
    session: Session,
    /// Bumped on every role transition. Failure-teardown tasks capture the
    /// generation they belong to and no-op if the world moved on — so a
    /// stale read-loop can never tear down a session it wasn't part of.
    generation: u64,
    last_error: Option<String>,
}

enum Session {
    Off,
    Host {
        endpoint: Endpoint,
        ticket: String,
        title: Option<String>,
        shared: Arc<HostShared>,
        accept_task: JoinHandle<()>,
    },
    Peer {
        endpoint: Endpoint,
        roster: Arc<Mutex<Vec<PeerInfo>>>,
        self_id: Arc<Mutex<Option<String>>>,
        title: Arc<Mutex<Option<String>>>,
        read_task: JoinHandle<()>,
        // Held so the QUIC stream/connection stay open for the session's
        // lifetime (dropping the send half would RESET the stream and the
        // host would drop us). `send` is also written to by `session_send`
        // (peer→host review ops / presence).
        _conn: Connection,
        send: SendStream,
    },
}

/// Host-side state shared between the accept loop, per-peer connection
/// tasks, and `session_broadcast`.
#[derive(Default)]
struct HostShared {
    /// The host's own roster display name (heads every `PeerList` as m0).
    host_name: String,
    /// Session-scoped member-id mint (m1, m2, ...; the host is m0). Never
    /// reused within a session, so ids stay stable across disconnects.
    next_member: AtomicU64,
    /// Session display title, carried to each newcomer in Welcome.
    title: Option<String>,
    /// Send halves + names. tokio Mutex: broadcast writes are async.
    peers: AsyncMutex<Vec<PeerConn>>,
    /// Per-connection task handles, so `session_leave` can abort them.
    /// std Mutex — never held across an await. Finished handles are pruned
    /// as new connections arrive; aborting a finished task is a no-op.
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

struct PeerConn {
    id: u64,
    /// Session-scoped member id ("m1", "m2", ...) - the roster/signaling key.
    member: String,
    name: String,
    send: SendStream,
}

static NEXT_PEER_ID: AtomicU64 = AtomicU64::new(1);

// ============================================================
// INVOKE COMMANDS
// ============================================================

/// Host a co-review session. Binds an iroh endpoint, spawns the accept
/// loop, and returns the join ticket to share. Errors if any session
/// (host or peer) is already active.
#[tauri::command]
pub async fn session_start(
    app: AppHandle,
    state: State<'_, SessionManager>,
    name: Option<String>,
    title: Option<String>,
) -> Result<String, crate::AppError> {
    let mut inner = state.inner.lock().await;
    if !matches!(inner.session, Session::Off) {
        return Err(crate::AppError::invalid("A co-review session is already active"));
    }

    let endpoint = Endpoint::builder(presets::N0)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| crate::AppError::internal(format!("co-review endpoint bind: {e}")))?;

    // Wait (bounded) until we're relay-reachable so the ticket works across
    // NATs. On timeout we mint the ticket anyway — direct addresses still
    // cover the LAN case, and n0 discovery can fill in the rest later.
    let _ = tokio::time::timeout(ONLINE_TIMEOUT, endpoint.online()).await;

    let ticket = EndpointTicket::new(endpoint.addr()).to_string();
    let title = title
        .map(|t| t.trim().chars().take(80).collect::<String>())
        .filter(|t| !t.is_empty());
    let shared = Arc::new(HostShared {
        host_name: clean_host_name(name.as_deref().unwrap_or("")),
        next_member: AtomicU64::new(1), // m0 is the host
        title: title.clone(),
        ..HostShared::default()
    });
    let accept_task = tokio::spawn(accept_loop(app.clone(), endpoint.clone(), shared.clone()));

    inner.generation += 1;
    inner.last_error = None;
    inner.session = Session::Host {
        endpoint,
        ticket: ticket.clone(),
        title,
        shared,
        accept_task,
    };

    let snap = snapshot_state(&inner).await;
    let _ = app.emit("session:state", &snap);
    Ok(ticket)
}

/// Join a hosted session as a peer: parse the ticket, connect, open the
/// bi-stream, send `Hello`, and spawn the read loop that relays host
/// messages to the frontend.
#[tauri::command]
pub async fn session_join(
    app: AppHandle,
    state: State<'_, SessionManager>,
    ticket: String,
    name: String,
) -> Result<(), crate::AppError> {
    let display_name = clean_name(&name);

    let mut inner = state.inner.lock().await;
    if !matches!(inner.session, Session::Off) {
        return Err(crate::AppError::invalid("A co-review session is already active"));
    }

    let parsed: EndpointTicket = parse_invite(&ticket)
        .parse()
        .map_err(|_| crate::AppError::invalid("That join code doesn't look valid"))?;

    let endpoint = Endpoint::builder(presets::N0)
        .bind()
        .await
        .map_err(|e| crate::AppError::internal(format!("co-review endpoint bind: {e}")))?;

    let attempt = tokio::time::timeout(JOIN_TIMEOUT, async {
        let conn = endpoint
            .connect(parsed, ALPN)
            .await
            .map_err(|e| format!("connect: {e}"))?;
        let (mut send, recv) = conn.open_bi().await.map_err(|e| format!("open stream: {e}"))?;
        write_msg_line(
            &mut send,
            &SessionMsg::Hello { name: display_name.clone() },
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok::<_, String>((conn, send, recv))
    })
    .await;

    let (conn, send, recv) = match attempt {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            endpoint.close().await;
            return Err(crate::AppError::Network(format!("Couldn't join session: {e}")));
        }
        Err(_) => {
            endpoint.close().await;
            return Err(crate::AppError::Network(
                "Couldn't reach the host (timed out)".into(),
            ));
        }
    };

    inner.generation += 1;
    inner.last_error = None;
    let generation = inner.generation;
    let roster: Arc<Mutex<Vec<PeerInfo>>> = Arc::new(Mutex::new(Vec::new()));
    let self_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let peer_title: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let read_task = tokio::spawn(peer_read_loop(
        app.clone(), recv, roster.clone(), self_id.clone(), peer_title.clone(), generation,
    ));
    inner.session = Session::Peer {
        endpoint,
        roster,
        self_id,
        title: peer_title,
        read_task,
        _conn: conn,
        send,
    };

    let snap = snapshot_state(&inner).await;
    let _ = app.emit("session:state", &snap);
    Ok(())
}

/// Leave / end the session (both roles). Idempotent: calling while "off"
/// just clears any stale error and re-emits state.
#[tauri::command]
pub async fn session_leave(
    app: AppHandle,
    state: State<'_, SessionManager>,
) -> Result<(), crate::AppError> {
    let mut inner = state.inner.lock().await;
    inner.generation += 1;
    inner.last_error = None;
    let old = std::mem::replace(&mut inner.session, Session::Off);
    let snap = snapshot_state(&inner).await;
    let _ = app.emit("session:state", &snap);
    drop(inner);
    shutdown_session(old).await;
    Ok(())
}

/// HOST only: write `msg` as a JSON line to every connected peer. Peers
/// whose stream write fails are dropped (removed + updated `PeerList` to
/// survivors + `session:state` re-emitted).
#[tauri::command]
pub async fn session_broadcast(
    app: AppHandle,
    state: State<'_, SessionManager>,
    msg: SessionMsg,
) -> Result<(), crate::AppError> {
    let inner = state.inner.lock().await;
    let Session::Host { shared, .. } = &inner.session else {
        return Err(crate::AppError::invalid("Not hosting a co-review session"));
    };

    // Host-originated signaling goes to the addressed member ONLY (and the
    // host is always the true sender - stamp m0 regardless of what the
    // frontend filled in).
    let msg = match msg {
        SessionMsg::Sharing { on, .. } => SessionMsg::Sharing { from: "m0".into(), on },
        SessionMsg::Reaction { emote, on, .. } => SessionMsg::Reaction { from: "m0".into(), emote, on },
        other => other,
    };
    if let SessionMsg::Rtc { to, payload, .. } = msg {
        let stamped = SessionMsg::Rtc { from: "m0".into(), to: to.clone(), payload };
        relay_to_member(shared, &to, &stamped).await;
        return Ok(());
    }

    let mut line = serde_json::to_string(&msg)?;
    line.push('\n');
    if line.len() > MAX_MSG_BYTES {
        return Err(crate::AppError::invalid("Session message too large"));
    }

    let mut dropped_any = false;
    {
        let mut peers = shared.peers.lock().await;
        let mut dead: Vec<u64> = Vec::new();
        for p in peers.iter_mut() {
            if p.send.write_all(line.as_bytes()).await.is_err() {
                dead.push(p.id);
            }
        }
        if !dead.is_empty() {
            peers.retain(|p| !dead.contains(&p.id));
            dropped_any = true;
        }
    }

    if dropped_any {
        broadcast_peer_list(shared).await;
        let snap = snapshot_state(&inner).await;
        let _ = app.emit("session:state", &snap);
    }
    Ok(())
}

/// PEER only: send `msg` up to the host (which relays review ops / presence to
/// everyone else). Errors if not a peer.
#[tauri::command]
pub async fn session_send(
    state: State<'_, SessionManager>,
    msg: SessionMsg,
) -> Result<(), crate::AppError> {
    let mut inner = state.inner.lock().await;
    let Session::Peer { send, .. } = &mut inner.session else {
        return Err(crate::AppError::invalid("Not in a co-review session"));
    };
    // Tiny line; the brief write under the manager lock mirrors how
    // session_broadcast already writes under `inner`.
    write_msg_line(send, &msg).await
}

// ============================================================
// HOST SIDE — accept loop + per-peer connection tasks
// ============================================================

async fn accept_loop(app: AppHandle, endpoint: Endpoint, shared: Arc<HostShared>) {
    // Ends when the endpoint closes (accept() yields None) or the task is
    // aborted by `session_leave` — no teardown of its own needed.
    while let Some(incoming) = endpoint.accept().await {
        let conn = match incoming.await {
            Ok(c) => c,
            Err(_) => continue, // handshake failure — never became a peer
        };
        let handle = tokio::spawn(handle_peer_conn(app.clone(), conn, shared.clone()));
        if let Ok(mut tasks) = shared.tasks.lock() {
            tasks.retain(|t| !t.is_finished());
            tasks.push(handle);
        }
    }
}

/// Owns one peer connection end-to-end: Hello handshake → roster
/// registration → read loop → removal on EOF/error.
async fn handle_peer_conn(app: AppHandle, conn: Connection, shared: Arc<HostShared>) {
    // 1. Handshake: the peer must open the bi-stream and send Hello promptly.
    let handshake = tokio::time::timeout(HELLO_TIMEOUT, async {
        let (send, recv) = conn.accept_bi().await.map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(recv);
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("stream closed before hello".to_string());
        }
        match serde_json::from_str::<SessionMsg>(line.trim()) {
            Ok(SessionMsg::Hello { name }) => Ok((send, reader, name)),
            Ok(_) => Err("expected hello".to_string()),
            Err(e) => Err(format!("bad hello: {e}")),
        }
    })
    .await;

    let (send, mut reader, raw_name) = match handshake {
        Ok(Ok(v)) => v,
        _ => {
            conn.close(1u32.into(), b"expected hello");
            return;
        }
    };
    let name = clean_name(&raw_name);

    // 2. Register, enforcing the cap. Extras get a polite close instead of
    //    a hang — the QUIC close reason is surfaced by the peer's read loop.
    let id = NEXT_PEER_ID.fetch_add(1, Ordering::Relaxed);
    let member = format!("m{}", shared.next_member.fetch_add(1, Ordering::Relaxed));
    let mut send = send;
    // Cap check BEFORE Welcome - a rejected extra must never briefly appear
    // fully joined. (The insert below re-checks under the same lock; this
    // early peek just orders the refusal ahead of the greeting.)
    {
        let peers = shared.peers.lock().await;
        if peers.len() >= MAX_PEERS {
            drop(peers);
            conn.close(1u32.into(), b"session is full");
            return;
        }
    }
    // Tell the newcomer who THEY are before the roster lands (PeerList can't
    // disambiguate same-name members; the mesh keys everything on this id).
    if write_msg_line(&mut send, &SessionMsg::Welcome { you: member.clone(), title: shared.title.clone() }).await.is_err() {
        conn.close(1u32.into(), b"welcome write failed");
        return;
    }
    {
        let mut peers = shared.peers.lock().await;
        if peers.len() >= MAX_PEERS {
            drop(peers);
            conn.close(1u32.into(), b"session is full");
            return;
        }
        peers.push(PeerConn { id, member: member.clone(), name, send });
    }
    broadcast_peer_list(&shared).await;
    emit_state_now(&app).await;

    // 3. Keep reading this peer's lines. A peer sends review ops + presence
    //    (Phase 2): apply them on the HOST frontend (session:msg) AND relay to
    //    every OTHER peer so the whole star converges. EOF/error = disconnect.
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => break, // clean EOF — peer left
            Ok(_) => {
                // Drop an abusively large control line before it can be fanned
                // out to every other peer (×N memory amplification).
                if line.len() > MAX_MSG_BYTES {
                    continue;
                }
                if let Ok(msg) = serde_json::from_str::<SessionMsg>(line.trim()) {
                    match msg {
                        SessionMsg::ReviewOp { .. } => {
                            let _ = app.emit("session:msg", &msg);
                            relay_to_others(&shared, id, &msg).await;
                        }
                        SessionMsg::Presence { name, position } => {
                            // Presence names skip the Hello clean_name path, so
                            // clamp here — otherwise a peer can flood an
                            // unbounded ghost-cursor label to everyone.
                            let msg = SessionMsg::Presence { name: clean_name(&name), position };
                            let _ = app.emit("session:msg", &msg);
                            relay_to_others(&shared, id, &msg).await;
                        }
                        SessionMsg::Sharing { on, .. } => {
                            let msg = SessionMsg::Sharing { from: member.clone(), on };
                            let _ = app.emit("session:msg", &msg);
                            relay_to_others(&shared, id, &msg).await;
                        }
                        SessionMsg::Reaction { emote, on, .. } => {
                            let msg = SessionMsg::Reaction { from: member.clone(), emote, on };
                            let _ = app.emit("session:msg", &msg);
                            relay_to_others(&shared, id, &msg).await;
                        }
                        SessionMsg::Rtc { to, payload, .. } => {
                            // Host rewrites `from` to the SENDER's real id -
                            // a member can't sign SDP as somebody else.
                            let msg = SessionMsg::Rtc { from: member.clone(), to: to.clone(), payload };
                            if to == "m0" {
                                let _ = app.emit("session:msg", &msg);
                            } else {
                                relay_to_member(&shared, &to, &msg).await;
                            }
                        }
                        // A peer shouldn't originate the host-only kinds; ignore.
                        _ => {}
                    }
                }
            }
            Err(_) => break, // reset / connection lost
        }
    }

    // 4. Disconnect: remove from the roster (release the lock BEFORE
    //    emit_state_now — see lock-order note on SessionManager), then
    //    tell the survivors and the UI.
    {
        let mut peers = shared.peers.lock().await;
        peers.retain(|p| p.id != id);
    }
    broadcast_peer_list(&shared).await;
    emit_state_now(&app).await;
}

/// Relay one message to every peer EXCEPT the sender (host-side fan-out of a
/// peer's review op / presence). Drops peers whose stream write fails.
async fn relay_to_others(shared: &HostShared, sender_id: u64, msg: &SessionMsg) {
    let Ok(mut line) = serde_json::to_string(msg) else { return };
    line.push('\n');
    let mut peers = shared.peers.lock().await;
    let mut dead: Vec<u64> = Vec::new();
    for p in peers.iter_mut() {
        if p.id == sender_id {
            continue;
        }
        if p.send.write_all(line.as_bytes()).await.is_err() {
            dead.push(p.id);
        }
    }
    if !dead.is_empty() {
        peers.retain(|p| !dead.contains(&p.id));
    }
}

/// Write one message to a single member's stream (targeted signaling).
/// A dead target is dropped from the roster like any failed write.
async fn relay_to_member(shared: &HostShared, member: &str, msg: &SessionMsg) {
    let Ok(mut line) = serde_json::to_string(msg) else { return };
    line.push('\n');
    if line.len() > MAX_MSG_BYTES {
        return;
    }
    let mut peers = shared.peers.lock().await;
    let mut dead = false;
    if let Some(p) = peers.iter_mut().find(|p| p.member == member) {
        dead = p.send.write_all(line.as_bytes()).await.is_err();
        if dead {
            let gone = p.id;
            peers.retain(|q| q.id != gone);
        }
    }
    let _ = dead; // roster fix-up rides the next broadcast_peer_list pass
}

/// Send the current roster (host name first) to every connected peer,
/// dropping any whose stream is dead. Loops until a pass completes with
/// no drops so survivors always end up with an accurate list.
async fn broadcast_peer_list(shared: &HostShared) {
    let mut peers = shared.peers.lock().await;
    loop {
        let roster = build_roster(
            &shared.host_name,
            peers.iter().map(|p| (p.member.clone(), p.name.clone())),
        );
        let Ok(mut line) = serde_json::to_string(&SessionMsg::PeerList { peers: roster }) else {
            return;
        };
        line.push('\n');

        let mut dead: Vec<u64> = Vec::new();
        for p in peers.iter_mut() {
            if p.send.write_all(line.as_bytes()).await.is_err() {
                dead.push(p.id);
            }
        }
        if dead.is_empty() {
            return;
        }
        peers.retain(|p| !dead.contains(&p.id));
    }
}

// ============================================================
// PEER SIDE — read loop
// ============================================================

async fn peer_read_loop(
    app: AppHandle,
    recv: iroh::endpoint::RecvStream,
    roster: Arc<Mutex<Vec<PeerInfo>>>,
    self_id: Arc<Mutex<Option<String>>>,
    peer_title: Arc<Mutex<Option<String>>>,
    generation: u64,
) {
    let mut reader = BufReader::new(recv);
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                // Host closed the stream / ended the session.
                tokio::spawn(fail_peer_to_off(
                    app,
                    generation,
                    "The host ended the session".to_string(),
                ));
                return;
            }
            Ok(_) => {
                if line.len() > MAX_MSG_BYTES {
                    continue; // drop an abusively large line from the host
                }
                let Ok(msg) = serde_json::from_str::<SessionMsg>(line.trim()) else {
                    continue; // future-proof: skip lines we don't understand
                };
                match msg {
                    SessionMsg::PeerList { peers } => {
                        if let Ok(mut r) = roster.lock() {
                            *r = peers;
                        }
                        emit_state_now(&app).await;
                    }
                    SessionMsg::Welcome { you, title } => {
                        if let Ok(mut me) = self_id.lock() {
                            *me = Some(you);
                        }
                        if let Ok(mut t) = peer_title.lock() {
                            *t = title;
                        }
                        emit_state_now(&app).await;
                    }
                    msg @ SessionMsg::Rtc { .. } => {
                        // Addressed to this member by construction (the host
                        // relays targeted) - straight to the frontend mesh.
                        let _ = app.emit("session:msg", &msg);
                    }
                    msg @ (SessionMsg::LoadSource { .. }
                    | SessionMsg::Transport { .. }
                    | SessionMsg::ReviewOp { .. }
                    | SessionMsg::ReviewDoc { .. }
                    | SessionMsg::Presence { .. }
                    | SessionMsg::Sharing { .. }
                    | SessionMsg::Reaction { .. }) => {
                        let _ = app.emit("session:msg", &msg);
                    }
                    SessionMsg::Hello { .. } => {} // host never sends Hello
                }
            }
            Err(e) => {
                tokio::spawn(fail_peer_to_off(
                    app,
                    generation,
                    format!("Connection to host lost: {e}"),
                ));
                return;
            }
        }
    }
}

/// Peer-side failure teardown, spawned DETACHED from the read loop so the
/// loop can return immediately (a task must never await its own abort —
/// `shutdown_session` aborts `read_task`). The generation check makes a
/// stale teardown a no-op if the user already left / started a new session.
async fn fail_peer_to_off(app: AppHandle, generation: u64, error: String) {
    let mgr = app.state::<SessionManager>();
    let mut inner = mgr.inner.lock().await;
    if inner.generation != generation {
        return;
    }
    inner.generation += 1;
    inner.last_error = Some(error);
    let old = std::mem::replace(&mut inner.session, Session::Off);
    let snap = snapshot_state(&inner).await;
    let _ = app.emit("session:state", &snap);
    drop(inner);
    shutdown_session(old).await;
}

// ============================================================
// SHARED HELPERS
// ============================================================

/// Abort a session's tasks and close its endpoint. Call with the manager
/// lock RELEASED — `Endpoint::close` waits on the network.
async fn shutdown_session(old: Session) {
    match old {
        Session::Off => {}
        Session::Host {
            endpoint,
            shared,
            accept_task,
            ..
        } => {
            accept_task.abort();
            if let Ok(mut tasks) = shared.tasks.lock() {
                for t in tasks.drain(..) {
                    t.abort();
                }
            }
            endpoint.close().await;
        }
        Session::Peer {
            endpoint,
            read_task,
            ..
        } => {
            read_task.abort();
            endpoint.close().await;
        }
    }
}

/// Build the frontend-facing state from the manager's current truth.
async fn snapshot_state(inner: &Inner) -> SessionState {
    match &inner.session {
        Session::Off => SessionState {
            role: "off".into(),
            code: None,
            peers: Vec::new(),
            self_id: None,
            title: None,
            error: inner.last_error.clone(),
        },
        Session::Host { ticket, title, shared, .. } => SessionState {
            role: "host".into(),
            // The SHAREABLE form (13a): SAUC- prefix + dash groups. The raw
            // ticket never renders as a paragraph blob again.
            code: Some(format_invite(ticket)),
            peers: shared
                .peers
                .lock()
                .await
                .iter()
                .map(|p| PeerInfo { id: p.member.clone(), name: p.name.clone() })
                .collect(),
            self_id: Some("m0".into()),
            title: title.clone(),
            error: inner.last_error.clone(),
        },
        Session::Peer { roster, self_id, title, .. } => SessionState {
            role: "peer".into(),
            code: None,
            peers: roster.lock().map(|r| r.clone()).unwrap_or_default(),
            self_id: self_id.lock().map(|s| s.clone()).unwrap_or(None),
            title: title.lock().map(|t| t.clone()).unwrap_or(None),
            error: inner.last_error.clone(),
        },
    }
}

/// Emit `session:state` built from the manager's CURRENT state. Tasks call
/// this instead of assembling state themselves so an emit that races
/// `session_leave` serializes behind the manager lock and reports the
/// post-leave truth (a duplicate "off" emit is harmless; a stale "host"
/// emit would wedge the UI).
async fn emit_state_now(app: &AppHandle) {
    let mgr = app.state::<SessionManager>();
    let inner = mgr.inner.lock().await;
    let snap = snapshot_state(&inner).await;
    let _ = app.emit("session:state", &snap);
}

/// Serialize one `SessionMsg` as a JSON line and write it to a stream.
async fn write_msg_line(send: &mut SendStream, msg: &SessionMsg) -> Result<(), crate::AppError> {
    let mut line = serde_json::to_string(msg)
        .map_err(|e| crate::AppError::internal(e.to_string()))?;
    line.push('\n');
    send.write_all(line.as_bytes())
        .await
        .map_err(|e| crate::AppError::Network(e.to_string()))
}

/// Display names come from the other side of the wire — trim, strip
/// control characters, cap the length, and never let one be empty.
fn clean_name(raw: &str) -> String {
    let trimmed = sanitize_name(raw);
    if trimmed.is_empty() {
        "Guest".to_string()
    } else if trimmed.eq_ignore_ascii_case(HOST_NAME) {
        // "Host" is reserved for the actual host — a guest can't grab the crown
        // / roster-head slot (or spoof a ghost label) by choosing that name.
        format!("{trimmed} (guest)")
    } else {
        trimmed
    }
}

/// The host's own name: same sanitation, but "Host" is legitimately theirs
/// (it's the default), so no reserved-name suffix.
fn clean_host_name(raw: &str) -> String {
    let trimmed = sanitize_name(raw);
    if trimmed.is_empty() { HOST_NAME.to_string() } else { trimmed }
}

/// Shared wire-input sanitation: trim, strip control chars, cap the length.
fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    cleaned.trim().to_string()
}

// ============================================================
// TESTS — lock the wire contract the frontend is coded against.
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_wire_shape_matches_contract() {
        let msg = SessionMsg::Transport {
            playing: true,
            position: 12.5,
            rate: 1.0,
            at_ms: 1_750_000_000_000.0,
            seq: 7,
        };
        let json = serde_json::to_string(&msg).unwrap();
        // Tag + camelCase fields — the frontend switches on exactly these.
        assert!(json.contains(r#""kind":"transport""#), "json: {json}");
        assert!(json.contains(r#""atMs":"#), "json: {json}");
        assert!(json.contains(r#""playing":true"#), "json: {json}");
        assert!(json.contains(r#""position":12.5"#), "json: {json}");
        assert!(json.contains(r#""rate":1.0"#), "json: {json}");
        assert!(json.contains(r#""seq":7"#), "json: {json}");
    }

    #[test]
    fn variant_tags_are_camel_case() {
        let hello = serde_json::to_string(&SessionMsg::Hello { name: "Ada".into() }).unwrap();
        assert!(hello.contains(r#""kind":"hello""#), "json: {hello}");
        let list = serde_json::to_string(&SessionMsg::PeerList { peers: vec![PeerInfo { id: "m0".into(), name: "Host".into() }] }).unwrap();
        assert!(list.contains(r#""kind":"peerList""#), "json: {list}");
        let load = serde_json::to_string(&SessionMsg::LoadSource { url: "https://x".into() }).unwrap();
        assert!(load.contains(r#""kind":"loadSource""#), "json: {load}");
    }

    #[test]
    fn session_msg_round_trips_line_protocol() {
        let msg = SessionMsg::LoadSource { url: "https://example.com/v".into() };
        let line = serde_json::to_string(&msg).unwrap();
        let back: SessionMsg = serde_json::from_str(line.trim()).unwrap();
        match back {
            SessionMsg::LoadSource { url } => assert_eq!(url, "https://example.com/v"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn phase2_variant_tags_and_round_trip() {
        let op = serde_json::to_string(&SessionMsg::ReviewOp { op: "{}".into() }).unwrap();
        assert!(op.contains(r#""kind":"reviewOp""#), "json: {op}");
        let doc = serde_json::to_string(&SessionMsg::ReviewDoc { doc: "{}".into() }).unwrap();
        assert!(doc.contains(r#""kind":"reviewDoc""#), "json: {doc}");
        let pres = serde_json::to_string(&SessionMsg::Presence { name: "Ada".into(), position: 3.5 }).unwrap();
        assert!(pres.contains(r#""kind":"presence""#), "json: {pres}");
        assert!(pres.contains(r#""position":3.5"#), "json: {pres}");
        // Round-trip a relayed op line.
        let back: SessionMsg = serde_json::from_str(op.trim()).unwrap();
        match back {
            SessionMsg::ReviewOp { op } => assert_eq!(op, "{}"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn clean_name_guards_wire_input() {
        assert_eq!(clean_name("  Ada \n"), "Ada");
        assert_eq!(clean_name("\u{0007}\u{0000}"), "Guest");
        assert_eq!(clean_name(""), "Guest");
        assert_eq!(clean_name(&"x".repeat(100)).len(), 40);
        // "Host" is reserved for the actual host — a guest picking it (any
        // case) is suffixed so it can't claim the crown / roster head.
        assert_eq!(clean_name("Host"), "Host (guest)");
        assert_eq!(clean_name("  host "), "host (guest)");
        assert_eq!(clean_name("Hostess"), "Hostess"); // only exact match is reserved
    }

    #[test]
    fn clean_host_name_defaults_and_allows_host() {
        assert_eq!(clean_host_name(""), "Host");       // unset → default
        assert_eq!(clean_host_name("  "), "Host");
        assert_eq!(clean_host_name("Host"), "Host");   // no (guest) suffix for the host
        assert_eq!(clean_host_name(" Gasper \n"), "Gasper");
        assert_eq!(clean_host_name(&"x".repeat(100)).len(), 40);
    }
}

/// Pure roster builder: host is always m0 and first; member order follows
/// connection order. Extracted so id stability is unit-testable without a
/// network.
fn build_roster(
    host_name: &str,
    members: impl Iterator<Item = (String, String)>,
) -> Vec<PeerInfo> {
    std::iter::once(PeerInfo { id: "m0".into(), name: host_name.to_string() })
        .chain(members.map(|(id, name)| PeerInfo { id, name }))
        .collect()
}

#[cfg(test)]
mod member_id_tests {
    use super::*;

    fn members(v: &[(&str, &str)]) -> Vec<(String, String)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
    }

    #[test]
    fn host_is_always_m0_and_first() {
        let r = build_roster("Nika", members(&[("m1", "Ada"), ("m2", "Lin")]).into_iter());
        assert_eq!(r[0], PeerInfo { id: "m0".into(), name: "Nika".into() });
        assert_eq!(r.len(), 3);
    }

    #[test]
    fn ids_stay_stable_when_a_member_disconnects() {
        // m1 drops; m2/m3 keep their minted ids - nothing renumbers.
        let before = build_roster(
            "Host",
            members(&[("m1", "Ada"), ("m2", "Lin"), ("m3", "Sam")]).into_iter(),
        );
        let after = build_roster("Host", members(&[("m2", "Lin"), ("m3", "Sam")]).into_iter());
        assert_eq!(after[1], before[2]);
        assert_eq!(after[2], before[3]);
    }

    #[test]
    fn same_display_names_stay_distinct_by_id() {
        let r = build_roster("Ada", members(&[("m1", "Ada"), ("m4", "Ada")]).into_iter());
        let ids: Vec<_> = r.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["m0", "m1", "m4"]);
    }
}

// ============================================================
// INVITE FORMAT (13a) - the wire payload stays the full iroh ticket
// (NodeId-only dialing is not verifiable on our setup without live
// discovery, so the pack's option B applies), but it travels dressed:
// "SAUC-" + dash-separated groups. Parsing accepts EVERY pasted form -
// prefixed or raw, dashed or not, wrapped across chat-app line breaks.
// ============================================================

/// Shareable invite: "SAUC-" + the ticket in dash groups of 5.
pub(crate) fn format_invite(ticket: &str) -> String {
    let mut out = String::with_capacity(ticket.len() + ticket.len() / 5 + 5);
    out.push_str("SAUC-");
    for (i, c) in ticket.chars().enumerate() {
        if i > 0 && i % 5 == 0 {
            out.push('-');
        }
        out.push(c);
    }
    out
}

/// Recover the raw ticket from any pasted form. Whitespace (incl. the
/// newlines chat apps wrap long pastes with) and group dashes are display
/// sugar; the SAUC prefix is optional and case-insensitive. A legacy raw
/// ticket passes through untouched (base32 - it contains neither).
pub(crate) fn parse_invite(input: &str) -> String {
    let stripped: String = input.chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    // is_char_boundary guards the slice - a paste with multibyte chars at the
    // seam (emoji, smart quotes) must not panic the command.
    if stripped.len() > 4 && stripped.is_char_boundary(4) && stripped[..4].eq_ignore_ascii_case("sauc") {
        stripped[4..].to_string()
    } else {
        stripped
    }
}

#[cfg(test)]
mod invite_tests {
    use super::*;

    const TICKET: &str = "endpointadkp7j4e4l3knzhmk4ze6iyke4ejiuv4otpugpg3ku5aenz5tikrgc";

    #[test]
    fn invite_round_trips() {
        let invite = format_invite(TICKET);
        assert!(invite.starts_with("SAUC-"));
        assert_eq!(parse_invite(&invite), TICKET);
    }

    #[test]
    fn parse_survives_chat_wrapping_and_case() {
        let invite = format_invite(TICKET);
        let wrapped = invite
            .chars()
            .enumerate()
            .flat_map(|(i, c)| if i > 0 && i % 20 == 0 { vec!['\n', c] } else { vec![c] })
            .collect::<String>();
        assert_eq!(parse_invite(&format!("  {wrapped}  \n")), TICKET);
        assert_eq!(parse_invite(&invite.to_lowercase()), TICKET);
    }

    #[test]
    fn legacy_raw_ticket_passes_through() {
        assert_eq!(parse_invite(TICKET), TICKET);
        assert_eq!(parse_invite(&format!("{TICKET}\n")), TICKET);
    }
}
