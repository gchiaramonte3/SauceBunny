//! P2P co-review ("watch party") — Phase 1 backend (r100).
//!
//! Constitution compliance: this is a peer-to-peer collab PRIMITIVE in the
//! same spirit as `stream_proxy.rs`, NOT an app backend. Nothing here serves
//! app logic over a socket:
//!
//!   - Media transits peers ONLY when a human asks for it. The default is
//!     still that every participant plays their own copy and nothing but
//!     tiny JSON control lines (roster, load-source, transport truth) cross
//!     the wire — the fingerprint ladder resolves a local copy first. Two
//!     opt-in paths carry bytes, and BOTH need a click on each side: the
//!     host offers a file (`session_offer_file`), and a guest chooses to
//!     receive it (`serve_file_substream`) or to watch it live
//!     (`serve_media_substream`). Each serves only the one explicitly
//!     offered file, matched by BLAKE3, and no filesystem path is ever on
//!     the wire.
//!   - PLAYBACK IS ALWAYS FROM A LOCAL COPY OR A FIXED-QUALITY STREAM, never
//!     a real-time encode that degrades to fit the link. The rung ladder
//!     picks ONE known height and tells the guest which it got; it does not
//!     collapse the bitrate under a grade review. And "watch it now" now also
//!     KEEPS it: a Tier C transfer runs underneath the live stream, so the
//!     stream converges to a local copy rather than evaporating with the
//!     session (`src/lib/stream-keep.ts` owns the policy). That copy is a
//!     multi-GB write, so it is named in the button the guest clicks — not
//!     buried in a tooltip — and it is skipped entirely on a relayed path,
//!     where the bytes would cross n0's public infrastructure.
//!   - Connections are iroh QUIC — dialed by endpoint public key, end-to-end
//!     encrypted. n0's public discovery + relays are connect-assist only.
//!     NOTE: with the media paths above, a relay-only connection can now
//!     carry GIGABYTES of E2E-encrypted media rather than kilobytes of
//!     control traffic (see the R6 decision still open in the peer-media
//!     plan: refuse Tier B on a relay path, or force the lowest rung).
//!   - A relay-URL override setting + LAN-only mode is Phase 3. NOTE: LAN-only
//!     got FURTHER away, not closer. The join code now carries only the
//!     endpoint key, so dialing depends on n0's DNS resolving it; the code no
//!     longer carries the direct addresses a LAN dial would use.
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
use iroh::{Endpoint, EndpointAddr};
use iroh_tickets::endpoint::EndpointTicket;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::BufReader;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

/// Protocol identifier, exchanged in the QUIC handshake. Bump the trailing
/// version if the wire format ever changes incompatibly.
const ALPN: &[u8] = b"saucebunny/coreview/2";

/// Star topology cap: host + 3 peers = 4 people per session (Phase 1).
const MAX_PEERS: usize = 3;

/// Hard cap on a single relayed control line. Peer→host traffic is tiny (one
/// review op or a presence tick), so anything past this is abuse — drop it
/// before it can be fanned out to every other peer (×N memory amplification).
const MAX_MSG_BYTES: usize = 2 * 1024 * 1024;

/// Hard cap on the Hello line specifically — a name plus an install id is a
/// few hundred bytes, so anything bigger is not a client. (Hello used to be
/// read with NO size check at all.)
const MAX_HELLO_BYTES: usize = 4 * 1024;

/// How many connections may sit in the Hello handshake simultaneously. Each
/// pending handshake holds a task + buffers for up to HELLO_TIMEOUT, and the
/// accept loop used to spawn one per connection unconditionally — an invite
/// holder could open hundreds and hold them all at the 10s window.
const MAX_PENDING_HANDSHAKES: usize = 8;

/// Longest install id accepted verbatim. Ids are UUIDs (36 chars); anything
/// longer or non-token-shaped is treated as ABSENT so a hostile client can't
/// grow the install→member map with unbounded garbage keys.
const MAX_INSTALL_LEN: usize = 64;

/// One line into the frontend's pipeline log, on the `session` channel.
///
/// The session protocol used to fail in complete silence: a line the peer
/// couldn't parse, or one over the size cap, was dropped with a bare
/// `continue`, so a version-skewed pair connected happily and then quietly
/// lost a whole message class. The connection looks healthy the entire time.
/// A dropped message is now the most valuable line in the log, not the least.
fn session_log(app: &AppHandle, tag: &str, line: impl Into<String>) {
    let _ = app.emit(
        "session:log",
        serde_json::json!({ "tag": tag, "line": line.into() }),
    );
}

/// Fallback roster display name for a host who hasn't set one.
/// `session_start` takes a display name like `session_join` does (r104);
/// this is also the reserved word guests can't claim (see `clean_name`).
const HOST_NAME: &str = "Host";

/// How long a freshly-accepted connection gets to open its stream and send
/// `Hello` before we drop it.
const HELLO_TIMEOUT: Duration = Duration::from_secs(10);

// ── Tier C file transfer (see _design/p2p-media-plan.md §Phase 2) ──────
/// Concurrent file substreams the host will serve at once.
const MAX_TRANSFERS: usize = 4;

/// Concurrent live ENCODES the host will run. Passthrough does not count.
///
/// MAX_TRANSFERS already bounds substreams, but it counts a cheap `-c copy`
/// pipe and a VideoToolbox encode the same, and only an encode costs the host
/// real silicon. Measured aggregate throughput is fine at this number (four
/// parallel 720p encodes ran at roughly 30x realtime combined), so this is not
/// a throughput limit — it is a backstop against a guest whose seek teardowns
/// race its rebuilds and fans out encoders on somebody else's Mac, where that
/// person cannot see them.
const MAX_MEDIA_ENCODES: usize = 3;
/// Read/write chunk for the transfer loops.
const TRANSFER_CHUNK: usize = 256 * 1024;
/// Pace the file substream (risk R4): it shares one physical link with the
/// live camera/mic mesh and the 2 Hz transport heartbeat, and an unpaced
/// QUIC bulk stream would take the whole uplink. ~24 MB/s (~190 Mbit/s) is
/// far above any home uplink (where the link itself throttles first) while
/// still bounding the damage on a LAN.
const TRANSFER_BYTES_PER_SEC: u64 = 24 * 1024 * 1024;
/// A substream must state its business promptly or it is dropped.
const SUBSTREAM_REQ_TIMEOUT: Duration = Duration::from_secs(10);
/// Guest-side stall cutoff: no bytes for this long ends the fetch (the
/// partial is kept and the next fetch resumes by offset).
const FETCH_READ_TIMEOUT: Duration = Duration::from_secs(30);

/// End-to-end budget for a peer joining (connect + open_bi + Hello).
const JOIN_TIMEOUT: Duration = Duration::from_secs(20);

/// How long the host waits to become relay-reachable before minting the code.
///
/// This used to add "(LAN-only sessions still work off direct addresses)",
/// and the id-only code made that FALSE. `presets::N0` is a pkarr publisher,
/// a DNS lookup and relays - there is no mDNS - so a code carrying only a key
/// has nothing to dial until n0's DNS answers. Two Macs on a LAN with no
/// internet can no longer join each other; they get the join timeout.
///
/// That is a real trade this app has not decided deliberately. Restoring it
/// means either local discovery in the preset, or a code that carries direct
/// addresses ALONGSIDE the key. The second is the smaller change and keeps
/// the durability, since the key resolves when the addresses go stale.
///
/// The wait itself proves less than it looks: iroh's own docs say `online()`
/// "does not interact with AddressLookup services", so it says nothing about
/// whether the pkarr record was written. It is kept because it costs a
/// bounded 8s and a relay-attached host is likelier to have published.
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
    /// peer → host right after connect. `install` is a stable per-install
    /// UUID (localStorage saucebunny.installId) so a member who drops and
    /// rejoins RECLAIMS its roster slot instead of minting a duplicate.
    /// `grant` is the secret half of a review link, absent for the lobby's
    /// join code. `#[serde(default)]` so a peer on an older build, whose
    /// Hello has no such field, still parses rather than being refused.
    Hello {
        name: String,
        install: String,
        #[serde(default)]
        grant: Option<String>,
    },
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
    /// presenter → everyone: what the room is watching. ONE variant covers
    /// all three cases; `kind` discriminates:
    ///   "web"  → `url` is Some; the guest re-resolves it with its OWN yt-dlp
    ///   "file" → `url` is None; the guest resolves `fingerprint` on its disk
    ///   "none" → the source was cleared; guests unload
    /// (named `source_kind`, not `kind`: serde's internal tag owns `kind`.)
    /// `review_key` is the SHARED review-doc identity (fingerprint for files,
    /// webpage_url for web) - never a host-local filesystem path.
    LoadSource {
        from: String,
        source_kind: String,
        url: Option<String>,
        fingerprint: Option<String>,
        title: Option<String>,
        duration: Option<f64>,
        review_key: String,
    },
    /// any member → everyone: could I open the presenter's source?
    /// state = "loading" | "ready" | "failed" | "missing".
    SourceStatus { from: String, state: String, detail: Option<String> },
    /// host → everyone: who drives source + transport. This is NOT the
    /// network star (which structurally cannot move - the invite ticket
    /// points at the original host's endpoint). `epoch` increments on every
    /// grant so late/duplicate Transport lines can be ordered.
    Presenter { member: String, epoch: u32 },
    /// peer → host: explicit departure, so a leave is declared, not inferred
    /// from a QUIC idle timeout.
    Bye,
    /// presenter → everyone: transport truth. at_ms = sender wall clock (ms).
    Transport {
        playing: bool,
        position: f64,
        rate: f64,
        at_ms: f64,
        seq: u32,
        /// Host-stamped sender id + the presenter epoch it was sent under, so
        /// lines from a superseded presenter can be ordered and discarded.
        from: String,
        epoch: u32,
    },
    /// A shared review mutation. `op` is a frontend-serialized JSON string
    /// (a ReviewOp) — OPAQUE to Rust, which only relays it. Flows
    /// peer→host→(other peers + host frontend), and host→all peers.
    ///
    /// `from` is HOST-STAMPED with the sending connection's member id, the
    /// same way Rtc/Sharing/Reaction are. Without it this message — the one
    /// carrying the actual product output — was the only unauthenticated
    /// kind in the protocol: the op payload names its own author, so any
    /// peer could post, edit, or delete review content, or stamp the
    /// source-level verdict, signed as somebody else. Receivers resolve the
    /// display name from this id instead of trusting the payload.
    /// `#[serde(default)]` keeps an older peer's unstamped op parseable
    /// (it simply arrives unattributed) rather than dropping it.
    ReviewOp {
        op: String,
        #[serde(default)]
        from: String,
    },
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
    /// host → everyone (Tier C): the current source's file can be fetched
    /// from the host over a dedicated typed substream. `size` + `blake3`
    /// let a guest render consent UI ("Reel_04.mov, 4.1 GB") and verify the
    /// received copy. An empty `name` withdraws the offer. Host-originated
    /// ONLY: the peer read loop deliberately ignores this kind (in v1 only
    /// the host serves bytes; a relayed offer would promise bytes the host
    /// cannot serve). `size` is f64 for the same reason as `duration` on
    /// LoadSource: file sizes fit f64 exactly and the binding stays number.
    OfferFile {
        from: String,
        name: String,
        size: f64,
        blake3: String,
        /// Codec identifiers for the source's video and audio tracks, so a
        /// guest can build the MSE MIME for the LIVE stream without probing
        /// (the peer raw route has no random access — it answers 405).
        /// Absent on older builds; the guest then only offers the transfer,
        /// not the stream.
        ///
        /// TWO VOCABULARIES RIDE THIS FIELD, and mixing them up broke Tier B
        /// for every H.264 file. What a host actually sends is ffmpeg's own
        /// codec NAME — "h264", "hevc", "aac" — because that is what
        /// `parse_ffmpeg_video` scrapes out of ffmpeg's stderr and what
        /// `offerCurrentFile` forwards unchanged. This comment used to
        /// promise RFC 6381 ("avc1.640028" / "mp4a.40.2"), which is what MSE
        /// requires and what a WEB source's yt-dlp resolver supplies, and
        /// nothing converted between them; `MediaSource.isTypeSupported`
        /// rejects `codecs="h264, aac"` outright, so the guest's fast path
        /// silently produced no MIME and fell through to the 405.
        ///
        /// The guest now accepts EITHER form and converts
        /// (`src/lib/codec-strings.ts`), which also keeps peers on older
        /// builds working. Do not "fix" this by normalising here without
        /// keeping that leniency — the old wire format is already deployed.
        #[serde(default)]
        vcodec: Option<String>,
        #[serde(default)]
        acodec: Option<String>,
    },
}

/// One session member: a session-scoped id (m0 = host, m1, m2, ... minted
/// at Hello) + display name. Ids are the roster key - names are display-only
/// and can collide. An id is RECLAIMED when the same install rejoins (r124),
/// so a reconnect updates a slot instead of adding a duplicate row.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct PeerInfo {
    pub id: String,
    pub name: String,
    /// Bumped every time this id is claimed or reclaimed. The RTC mesh keys
    /// its peer connections on (id, epoch): a bump means "same person, new
    /// connection", so the stale PeerConnection is torn down and rebuilt
    /// instead of sitting on "Connecting" forever.
    pub epoch: u32,
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
    /// Member id currently allowed to drive source + transport. "" while off.
    /// Distinct from the network host, which never moves.
    pub presenter: String,
    /// Increments on every floor grant. Receivers use it to order transport
    /// across a handover (see HostShared::presenter_epoch).
    pub presenter_epoch: u32,
}

// ============================================================
// SESSION MANAGER — managed state (`.manage()` in lib.rs).
//
// Lock order (deadlock-free by construction): manager mutex FIRST,
// then the host `peers` mutex. Connection tasks that only touch the
// peers list must RELEASE it before calling `emit_state_now` (which
// re-acquires manager → peers).
//
// YES, THE WRITES HAPPEN UNDER THE LOCK, AND THAT IS THE DESIGN.
// `session_send`, `session_broadcast` and `relay_to_others` all await a
// QUIC `write_all` while holding `inner` (and, for the broadcast paths,
// `peers`). It looks alarming — one stalled peer appearing to freeze
// Leave for the whole room — and a code review flagged it as exactly
// that. Three independent passes then failed to reach the failure:
//
//   · The write is BOUNDED by the transport, not by this file. iroh's
//     QUIC connection carries an idle timeout, so a peer that stops
//     reading fails its stream rather than blocking forever. The wedge
//     is bounded by that timeout, not unbounded.
//   · The alternative is worse. Cloning the peer list and writing
//     outside the lock means a peer can be removed mid-broadcast and a
//     write lands on a connection the roster no longer contains, which
//     is how you get a ghost tile that never clears.
//   · The messages are small control frames (comments, playhead,
//     reactions), not media. Media never travels this path — see the
//     co-review rules in CLAUDE.md.
//
// Do not "fix" this by dropping the guard before the write without
// solving the removal race first. If you are here because a session
// really did hang, the thing to check is the idle timeout, not the
// lock.
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
        /// Latest presenter id from the host, stored exactly like `roster`
        /// and `title` so `snapshot_state` can report it without a round trip.
        presenter: Arc<Mutex<String>>,
        /// Latest presenter epoch from the host (see HostShared).
        presenter_epoch: Arc<AtomicU64>,
        read_task: JoinHandle<()>,
        /// Tier B: services the proxy's media-stream requests over this
        /// connection while the session lives (peer_stream hook).
        media_task: JoinHandle<()>,
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
    /// Session-scoped member-id mint (m1, m2, ...; the host is m0). Ids are
    /// RECLAIMED by install id on rejoin (r124), so the mint only advances
    /// for genuinely new participants.
    next_member: AtomicU64,
    /// Member id currently allowed to drive source + transport, as a number
    /// (0 = the host). An atomic, not a Mutex: the relay reads it and then
    /// awaits `relay_to_others`, and this file forbids holding a std guard
    /// across an await (see the lock-order note on SessionManager).
    presenter: AtomicU64,
    /// How many times the floor has been granted. The host STAMPS this onto
    /// every relayed Transport so receivers can order a handover: a peer's
    /// `seq` counter restarts from 0 when it takes the floor, which without
    /// an epoch looks like a flood of stale messages to anyone whose seq is
    /// already high, and they freeze until the new presenter catches up.
    presenter_epoch: AtomicU64,
    /// install id → member id, so a reconnecting member reclaims its slot.
    /// std Mutex, never held across an await.
    installs: Mutex<HashMap<String, String>>,
    /// member id → how many times that id has been claimed. Handed to the
    /// mesh in PeerInfo.epoch so it can tell a reconnect from a no-op.
    epochs: Mutex<HashMap<String, u32>>,
    /// Session display title, carried to each newcomer in Welcome.
    title: Option<String>,
    /// Send halves + names. tokio Mutex: broadcast writes are async.
    peers: AsyncMutex<Vec<PeerConn>>,
    /// Per-connection task handles, so `session_leave` can abort them.
    /// std Mutex — never held across an await. Finished handles are pruned
    /// as new connections arrive; aborting a finished task is a no-op.
    tasks: Mutex<Vec<JoinHandle<()>>>,
    /// The one file currently offered to the room (Tier C). Offering a new
    /// file replaces it; clearing withdraws it. Guests request by BLAKE3
    /// hash, never by path (R11: only this explicitly-offered file is ever
    /// readable over the wire). std Mutex, cloned out, never held across an
    /// await.
    offered: Mutex<Option<OfferedFile>>,
    /// Concurrent file substreams being served, bounded by MAX_TRANSFERS so
    /// a guest cannot fan requests into an unbounded set of readers.
    active_transfers: Arc<AtomicUsize>,
    /// Live ENCODES in flight, bounded by MAX_MEDIA_ENCODES. Separate from
    /// `active_transfers` because only an encode costs the host CPU.
    active_encodes: Arc<AtomicUsize>,
}

/// The host-side record of a Tier C offer: where the bytes live and the
/// identity guests verify against. The path NEVER crosses the wire.
#[derive(Clone)]
struct OfferedFile {
    path: std::path::PathBuf,
    name: String,
    size: u64,
    blake3: String,
}

struct PeerConn {
    id: u64,
    /// Session-scoped member id ("m1", "m2", ...) - the roster/signaling key.
    member: String,
    name: String,
    /// The grant this connection arrived on, when it came through a review
    /// link. Withdrawing that link disconnects them; without this, revocation
    /// only took effect at the NEXT join, so the person you just removed kept
    /// reading and commenting until they happened to leave.
    grant: Option<String>,
    /// Kept so a kick can actually close the connection. Resetting the send
    /// stream alone stops us writing to them and leaves their read loop
    /// running, which is not a removal.
    conn: Connection,
    /// How many times this member id has been claimed. Rides the roster so
    /// the mesh can distinguish a reconnect from an unchanged member.
    epoch: u32,
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
    // BEFORE the lock, deliberately. Reading the Keychain can raise a macOS
    // prompt and sit on it indefinitely; doing that while holding `inner`
    // would queue every other session command behind a modal dialog. It is
    // memoised, so only the first session in a process pays anything at all.
    let host_key = crate::commands::session_key::host_key().await;

    let mut inner = state.inner.lock().await;
    if !matches!(inner.session, Session::Off) {
        return Err(crate::AppError::invalid("A co-review session is already active"));
    }

    // The identity is LOADED, not generated. Without `.secret_key(...)` iroh
    // mints a fresh one per bind ("If not set, a new secret key will be
    // generated"), so the EndpointId a join code names changed on every
    // launch and yesterday's code was undialable for an invisible reason.
    // `load_or_create_host_key` never fails: a Keychain that refuses gives
    // back an ephemeral key, which is exactly how this behaved before, rather
    // than turning a dismissed prompt into "you cannot host". Whether the
    // identity is durable is answered by `has_review_identity`, not here.
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(host_key)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await
        .map_err(|e| crate::AppError::internal(format!("co-review endpoint bind: {e}")))?;

    // Wait (bounded) to be relay-reachable before minting the code.
    //
    // This no longer feeds addresses INTO the ticket - see below - but it is
    // not vestigial: an id-only code is dialled by looking the key up in
    // discovery, and `presets::N0` publishes that record. Being relay-attached
    // is the closest signal available that publication has had a chance to
    // land. It is NOT a confirmation of it. `online()` waits on the home
    // relay's connection, not on the pkarr write, so a code pasted seconds
    // after minting can still fail to resolve. Anything promising the user a
    // working link needs a real reachability check, not this timeout.
    let _ = tokio::time::timeout(ONLINE_TIMEOUT, endpoint.online()).await;

    // ADDRESS-FREE. `endpoint.addr()` packs the live relay URL and the
    // observed IP set, including LAN addresses, which iroh's own "don't use
    // tickets when" list warns against for long-lived links: "You can cache
    // EndpointIDs and let iroh resolve dialing details at runtime."
    //
    // The ticket ENVELOPE stays, and that is the whole trick: format_invite
    // and parse_invite are untouched, the tag strip and restore still work,
    // and an old address-bearing code minted by an earlier build still parses
    // and dials. Both ends already run DnsAddressLookup via presets::N0, so
    // the guest needs no change at all.
    // THE CODE IS NOW PERMANENT, and nothing downstream gates on it. The
    // accept loop checks the ALPN and reads a Hello; there is no allowlist and
    // no per-code identity, so every session this Mac ever hosts answers to
    // the same string. Before the key was persisted, a code expired when the
    // app quit - accidental, but it was the only bound there was.
    //
    // Consequence to be honest about: a code shared in September silently
    // admits its holder to a session in November, and the only revocation is
    // reset_review_identity, which invalidates every code at once. Per-code
    // grants are the fix and they are a later phase; until then this is a
    // convenience for people you trust with the whole shelf, not a link to
    // hand to a client.
    let ticket = EndpointTicket::new(EndpointAddr::new(endpoint.id())).to_string();
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
    install: String,
    // The secret half of a review link, when the guest arrived through one.
    // Absent for the lobby's join code, which is a different door.
    grant: Option<String>,
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
            &SessionMsg::Hello {
                name: display_name.clone(),
                install: install.clone(),
                grant: grant.clone(),
            },
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
    // Until a Presenter line arrives, the host presents - matching the host's
    // own default so both ends agree during the first moments of a session.
    let peer_presenter: Arc<Mutex<String>> = Arc::new(Mutex::new("m0".into()));
    let peer_presenter_epoch: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));
    let read_task = tokio::spawn(peer_read_loop(
        app.clone(), recv,
        PeerShared {
            roster: roster.clone(),
            self_id: self_id.clone(),
            peer_title: peer_title.clone(),
            peer_presenter: peer_presenter.clone(),
            peer_presenter_epoch: peer_presenter_epoch.clone(),
        },
        generation,
    ));
    // Tier B: while this session lives, the loopback proxy can ask for the
    // host's offered file as a live fMP4 stream (peer_stream bridge).
    let (media_tx, media_rx) = tokio::sync::mpsc::unbounded_channel();
    crate::commands::peer_stream::install_media_hook(media_tx);
    let media_task = tokio::spawn(peer_media_service(conn.clone(), media_rx));
    inner.session = Session::Peer {
        endpoint,
        roster,
        self_id,
        title: peer_title,
        presenter: peer_presenter,
        presenter_epoch: peer_presenter_epoch,
        read_task,
        media_task,
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
        SessionMsg::LoadSource { source_kind, url, fingerprint, title, duration, review_key, .. } =>
            SessionMsg::LoadSource { from: "m0".into(), source_kind, url, fingerprint, title, duration, review_key },
        SessionMsg::SourceStatus { state, detail, .. } =>
            SessionMsg::SourceStatus { from: "m0".into(), state, detail },
        SessionMsg::ReviewOp { op, .. } => SessionMsg::ReviewOp { op, from: "m0".into() },
        SessionMsg::Transport { playing, position, rate, at_ms, seq, .. } =>
            SessionMsg::Transport {
                playing, position, rate, at_ms, seq, from: "m0".into(),
                epoch: shared.presenter_epoch.load(Ordering::Relaxed) as u32,
            },
        // Granting the floor updates the host's own gate before it goes out,
        // so a peer's very next LoadSource is accepted by the relay.
        SessionMsg::Presenter { member, .. } => {
            shared.presenter.store(member_num(&member), Ordering::Relaxed);
            // The HOST owns the epoch; the caller's value is advisory.
            let epoch = shared.presenter_epoch.fetch_add(1, Ordering::Relaxed) as u32 + 1;
            SessionMsg::Presenter { member, epoch }
        }
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

/// Read one newline-terminated line WITHOUT ever buffering more than `cap`
/// bytes. `read_line` grows its String until a newline arrives, so the old
/// "check the length afterwards" pattern let a peer stream an arbitrarily
/// long line into memory before the cap ran. Ok(None) = clean EOF. A line
/// over the cap (or EOF mid-line, or non-UTF-8) is an ERROR — the caller
/// drops the connection; skipping would mean reading and discarding an
/// unbounded stream we specifically chose not to buffer.
async fn read_line_bounded<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    cap: usize,
) -> std::io::Result<Option<String>> {
    use tokio::io::AsyncBufReadExt;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = reader.fill_buf().await?;
        if chunk.is_empty() {
            return if buf.is_empty() {
                Ok(None)
            } else {
                Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "stream ended mid-line"))
            };
        }
        if let Some(pos) = chunk.iter().position(|&b| b == b'\n') {
            if buf.len() + pos > cap {
                return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "line exceeds the size cap"));
            }
            buf.extend_from_slice(&chunk[..pos]);
            reader.consume(pos + 1);
            let text = String::from_utf8(buf)
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "line is not UTF-8"))?;
            return Ok(Some(text));
        }
        if buf.len() + chunk.len() > cap {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "line exceeds the size cap"));
        }
        buf.extend_from_slice(chunk);
        let consumed = chunk.len();
        reader.consume(consumed);
    }
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
        // Bound the handshake fan-out BEFORE spawning: each pending task holds
        // buffers for up to HELLO_TIMEOUT, and an invite holder could open
        // hundreds of connections and park them all in that window.
        let pending = shared
            .tasks
            .lock()
            .map(|mut tasks| {
                tasks.retain(|t| !t.is_finished());
                tasks.len()
            })
            .unwrap_or(usize::MAX);
        if pending >= MAX_PENDING_HANDSHAKES {
            conn.close(1u32.into(), b"session is busy");
            continue;
        }
        let handle = tokio::spawn(handle_peer_conn(app.clone(), conn, shared.clone()));
        if let Ok(mut tasks) = shared.tasks.lock() {
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
        // Bounded: Hello had NO size check, and read_line buffers until a
        // newline arrives — the one unauthenticated read in the protocol was
        // also the unbounded one.
        let line = match read_line_bounded(&mut reader, MAX_HELLO_BYTES).await {
            Ok(Some(l)) => l,
            Ok(None) => return Err("stream closed before hello".to_string()),
            Err(e) => return Err(format!("bad hello: {e}")),
        };
        match serde_json::from_str::<SessionMsg>(line.trim()) {
            Ok(SessionMsg::Hello { name, install, grant }) => Ok((send, reader, name, install, grant)),
            Ok(_) => Err("expected hello".to_string()),
            Err(e) => Err(format!("bad hello: {e}")),
        }
    })
    .await;

    let (send, mut reader, raw_name, install, grant) = match handshake {
        Ok(Ok(v)) => v,
        _ => {
            conn.close(1u32.into(), b"expected hello");
            return;
        }
    };

    // ADMISSION, and the name that comes with it.
    //
    // The display name for a granted connection is the label the HOST typed,
    // not the one the peer claimed. That is the point of the whole mechanism:
    // the relay already stamps `from` so a peer cannot forge ANOTHER member's
    // attribution, but it could not stop a stranger with a forwarded link
    // simply calling themselves Dana and having every note signed Dana in the
    // review file, permanently. clean_name defends exactly one reserved word
    // and was never going to be enough.
    //
    // An ungranted connection is today's behaviour and keeps today's name.
    // The lobby's join code is a different door, for people you are already
    // in a call with, and refusing them by default would break live co-review
    // for everyone who has never issued a link. A host who wants the stricter
    // rule turns on invited-only.
    let (name, grant_id) = match crate::commands::review_grant::admit(&app, grant.as_deref()) {
        crate::commands::review_grant::Admission::Refused(why) => {
            conn.close(1u32.into(), why.as_bytes());
            return;
        }
        crate::commands::review_grant::Admission::Granted { id, label } => (clean_name(&label), Some(id)),
        crate::commands::review_grant::Admission::Ungranted => (clean_name(&raw_name), None),
    };
    // Untrusted install ids only enter the persistent install→member map when
    // they are token-shaped and bounded; anything else is treated as absent
    // (mint-only, no insert), so rejected or hostile connects can't grow the
    // map with arbitrary keys.
    let install = if install.len() <= MAX_INSTALL_LEN
        && install.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        install
    } else {
        String::new()
    };

    // 2. Cap check FIRST — before minting a member id, inserting into the
    //    install map, or bumping epochs. A rejected extra used to leave those
    //    behind, so unique rejected connects grew host state indefinitely.
    //    (The insert below re-checks under the same lock; this early peek
    //    just orders the refusal ahead of any bookkeeping.)
    {
        let peers = shared.peers.lock().await;
        if peers.len() >= MAX_PEERS {
            drop(peers);
            conn.close(1u32.into(), b"session is full");
            return;
        }
    }

    let id = NEXT_PEER_ID.fetch_add(1, Ordering::Relaxed);
    // RECLAIM the member id when this install has been here before (r124).
    // Minting unconditionally is what made a rejoining friend appear as a
    // second person: same human, fresh mN, and the roster grew. An empty
    // install string (older build) always mints, preserving old behaviour.
    let member = {
        let mut installs = shared.installs.lock().unwrap_or_else(|e| e.into_inner());
        match installs.get(&install) {
            Some(existing) if !install.is_empty() => existing.clone(),
            _ => {
                let fresh = format!("m{}", shared.next_member.fetch_add(1, Ordering::Relaxed));
                if !install.is_empty() {
                    installs.insert(install.clone(), fresh.clone());
                }
                fresh
            }
        }
    };
    // Bump the claim count so the mesh tears down the stale PeerConnection
    // for this id rather than leaving a tile stuck on "Connecting".
    let member_epoch = {
        let mut epochs = shared.epochs.lock().unwrap_or_else(|e| e.into_inner());
        let e = epochs.entry(member.clone()).or_insert(0);
        *e = e.saturating_add(1);
        *e
    };
    let mut send = send;
    // Tell the newcomer who THEY are before the roster lands (PeerList can't
    // disambiguate same-name members; the mesh keys everything on this id).
    if write_msg_line(&mut send, &SessionMsg::Welcome { you: member.clone(), title: shared.title.clone() }).await.is_err() {
        conn.close(1u32.into(), b"welcome write failed");
        return;
    }
    {
        let mut peers = shared.peers.lock().await;
        // A reclaimed id may still have its PREVIOUS connection in the list
        // (the old socket hasn't hit EOF yet). Evict it first, or the roster
        // carries the same person twice - the duplicate-tile bug.
        peers.retain(|p| p.member != member);
        if peers.len() >= MAX_PEERS {
            drop(peers);
            conn.close(1u32.into(), b"session is full");
            return;
        }
        peers.push(PeerConn {
            id, member: member.clone(), name, epoch: member_epoch, send,
            grant: grant_id.clone(),
            conn: conn.clone(),
        });
    }
    broadcast_peer_list(&shared).await;
    emit_state_now(&app).await;

    // Tier C: every bi-stream opened AFTER the control stream is a typed
    // request (risk R5: the control stream was accepted above, before this
    // task exists, so this loop structurally cannot consume control-plane
    // messages). Runs only for peers that passed the Hello handshake, and
    // dies with the connection at disconnect below.
    let sub_task = tokio::spawn(serve_substreams(
        app.clone(),
        conn.clone(),
        shared.clone(),
        member.clone(),
    ));

    // 3. Keep reading this peer's lines. A peer sends review ops + presence
    //    (Phase 2): apply them on the HOST frontend (session:msg) AND relay to
    //    every OTHER peer so the whole star converges. EOF/error = disconnect.
    loop {
        match read_line_bounded(&mut reader, MAX_MSG_BYTES).await {
            Ok(None) => break, // clean EOF — peer left
            Err(e) => {
                // Oversize / mid-line EOF / non-UTF-8: the peer is outside the
                // protocol, and a bounded reader can't skip past an unbounded
                // line — disconnecting IS the containment (it used to buffer
                // the whole line first, which was the memory hole).
                session_log(&app, "warn", format!("Dropping {member}: {e}."));
                break;
            }
            Ok(Some(line)) => {
                let parsed = serde_json::from_str::<SessionMsg>(line.trim());
                if let Err(e) = &parsed {
                    session_log(&app, "err", format!(
                        "Unreadable message from {member}: {e}. This is what a version \
                         mismatch between the two Macs looks like.",
                    ));
                }
                if let Ok(msg) = parsed {
                    match msg {
                        SessionMsg::ReviewOp { op, .. } => {
                            // Stamp the connection's own member id — a peer
                            // cannot sign review content as anybody else.
                            let msg = SessionMsg::ReviewOp { op, from: member.clone() };
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
                        // Source + transport: only the PRESENTER may drive, and
                        // the host stamps `from` so a member can't drive as
                        // somebody else. Before r124 these fell into the
                        // catch-all below and were silently dropped, which is
                        // why a peer could never present.
                        SessionMsg::LoadSource {
                            source_kind, url, fingerprint, title, duration, review_key, ..
                        } => {
                            if !can_drive(shared.presenter.load(Ordering::Relaxed), &member) {
                                continue;
                            }
                            let msg = SessionMsg::LoadSource {
                                from: member.clone(),
                                source_kind, url, fingerprint, title, duration, review_key,
                            };
                            let _ = app.emit("session:msg", &msg);
                            relay_to_others(&shared, id, &msg).await;
                        }
                        SessionMsg::Transport { playing, position, rate, at_ms, seq, .. } => {
                            if !can_drive(shared.presenter.load(Ordering::Relaxed), &member) {
                                continue;
                            }
                            // Stamp `from` AND `epoch` from host state. A peer
                            // cannot know the current epoch reliably, and a
                            // stale or spoofed one would strand receivers.
                            let msg = SessionMsg::Transport {
                                playing, position, rate, at_ms, seq,
                                from: member.clone(),
                                epoch: shared.presenter_epoch.load(Ordering::Relaxed) as u32,
                            };
                            let _ = app.emit("session:msg", &msg);
                            relay_to_others(&shared, id, &msg).await;
                        }
                        // Anyone may report whether THEY could open the source.
                        SessionMsg::SourceStatus { state, detail, .. } => {
                            let msg = SessionMsg::SourceStatus {
                                from: member.clone(),
                                state: clean_name(&state),
                                detail,
                            };
                            let _ = app.emit("session:msg", &msg);
                            relay_to_others(&shared, id, &msg).await;
                        }
                        // Declared departure: break the read loop so the
                        // disconnect path below runs immediately instead of
                        // waiting on a QUIC idle timeout.
                        SessionMsg::Bye => break,
                        // A peer shouldn't originate the host-only kinds; ignore.
                        _ => {}
                    }
                }
            }
        }
    }

    // 4. Disconnect: remove from the roster (release the lock BEFORE
    //    emit_state_now — see lock-order note on SessionManager), then
    //    tell the survivors and the UI. The substream acceptor dies with us
    //    (its Connection clone drops when the abort lands, and any in-flight
    //    transfer task exits on its next failed stream write).
    sub_task.abort();
    {
        let mut peers = shared.peers.lock().await;
        peers.retain(|p| p.id != id);
    }
    broadcast_peer_list(&shared).await;
    emit_state_now(&app).await;
}

/// Close every connection matching `pred`, and tell the room who is left.
///
/// Closing the CONNECTION, not just the send stream. Resetting the stream
/// stops us writing to them and leaves their read loop running, which is a
/// half-removal: they stop receiving updates and keep believing they are in
/// the session.
///
/// Returns how many went, so a caller can say "removed 1" rather than
/// guessing.
async fn disconnect_peers(
    app: &AppHandle,
    shared: &Arc<HostShared>,
    reason: &[u8],
    pred: impl Fn(&PeerConn) -> bool,
) -> usize {
    let doomed: Vec<Connection> = {
        let mut peers = shared.peers.lock().await;
        let (go, stay): (Vec<_>, Vec<_>) = std::mem::take(&mut *peers).into_iter().partition(&pred);
        *peers = stay;
        go.into_iter().map(|p| p.conn).collect()
    };
    if doomed.is_empty() {
        return 0;
    }
    let n = doomed.len();
    for c in doomed {
        c.close(1u32.into(), reason);
    }
    broadcast_peer_list(shared).await;
    emit_state_now(app).await;
    n
}

/// Remove one person from the session.
///
/// There was no way to do this at all. A forwarded join code was three slots
/// of MAX_PEERS the host could only clear by destroying every outstanding
/// code, and a withdrawn review link left its holder connected until they
/// chose to leave.
#[tauri::command]
pub async fn session_kick(
    app: AppHandle,
    state: State<'_, SessionManager>,
    member: String,
) -> Result<usize, crate::AppError> {
    let shared = {
        let inner = state.inner.lock().await;
        let Session::Host { shared, .. } = &inner.session else {
            return Err(crate::AppError::invalid("Only the host can remove someone."));
        };
        shared.clone()
    };
    Ok(disconnect_peers(&app, &shared, b"removed by the host", |p| p.member == member).await)
}

/// Disconnect anyone holding a particular grant. Called when it is withdrawn.
///
/// Silent when there is no session: revoking a link while nothing is running
/// is a perfectly ordinary thing to do and is not an error.
pub async fn disconnect_grant(app: &AppHandle, state: &SessionManager, grant_id: &str) -> usize {
    let shared = {
        let inner = state.inner.lock().await;
        let Session::Host { shared, .. } = &inner.session else { return 0 };
        shared.clone()
    };
    disconnect_peers(app, &shared, b"that link was withdrawn", |p| {
        p.grant.as_deref() == Some(grant_id)
    })
    .await
}

// ============================================================
// TIER C — typed substreams (file transfer)
// ============================================================

/// A substream's one-line request. `t` is the discriminator (risk R5): every
/// stream after the control stream states its type up front, and unknown
/// types are refused with a header rather than guessed at.
#[derive(serde::Deserialize)]
struct SubstreamReq {
    t: String,
    #[serde(default)]
    blake3: String,
    #[serde(default)]
    offset: u64,
    /// media-request only: seconds to start the live remux from.
    #[serde(default)]
    start: f64,
    /// media-request only: the quality rung the guest wants, as a height
    /// (1080/720/540/360). 0 or absent means source passthrough, which is
    /// what every build before the ladder existed asked for implicitly — so
    /// `serde(default)` is what keeps an older guest working against a newer
    /// host. See `commands::rung`.
    #[serde(default)]
    rung: u32,
}

/// Accept every bi-stream a registered peer opens after its control stream,
/// and serve typed requests. Bounded by MAX_TRANSFERS across the room.
async fn serve_substreams(app: AppHandle, conn: Connection, shared: Arc<HostShared>, member: String) {
    while let Ok((send, recv)) = conn.accept_bi().await {
        let counter = shared.active_transfers.clone();
        if counter.fetch_add(1, Ordering::SeqCst) >= MAX_TRANSFERS {
            counter.fetch_sub(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut send = send;
                let _ = send
                    .write_all(b"{\"t\":\"file-response\",\"ok\":false,\"error\":\"busy\"}\n")
                    .await;
                let _ = send.finish();
            });
            continue;
        }
        let app = app.clone();
        let shared = shared.clone();
        let member = member.clone();
        tokio::spawn(async move {
            struct Guard(Arc<AtomicUsize>);
            impl Drop for Guard {
                fn drop(&mut self) {
                    self.0.fetch_sub(1, Ordering::SeqCst);
                }
            }
            let _g = Guard(counter);
            serve_file_substream(app, send, recv, shared, member).await;
        });
    }
}

/// Serve one file request: header line in, header line out, then raw bytes
/// from the requested offset to EOF, paced per TRANSFER_BYTES_PER_SEC.
async fn serve_file_substream(
    app: AppHandle,
    mut send: SendStream,
    recv: iroh::endpoint::RecvStream,
    shared: Arc<HostShared>,
    member: String,
) {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut reader = BufReader::new(recv);
    let line = match tokio::time::timeout(SUBSTREAM_REQ_TIMEOUT, read_line_bounded(&mut reader, MAX_HELLO_BYTES)).await {
        Ok(Ok(Some(l))) => l,
        _ => return, // silent stream, oversize line, or EOF — nothing owed
    };
    let req = match serde_json::from_str::<SubstreamReq>(line.trim()) {
        Ok(r) => r,
        Err(_) => {
            let _ = send
                .write_all(b"{\"t\":\"file-response\",\"ok\":false,\"error\":\"unknown request\"}\n")
                .await;
            let _ = send.finish();
            return;
        }
    };
    // Tier B live stream shares the substream shape (risk R5: one explicit
    // discriminator, every unknown type refused with a header).
    if req.t == "media-request" {
        return serve_media_substream(app, send, shared, member, req.blake3, req.start, req.rung)
            .await;
    }
    if req.t != "file-request" {
        let _ = send
            .write_all(b"{\"t\":\"file-response\",\"ok\":false,\"error\":\"unknown request\"}\n")
            .await;
        let _ = send.finish();
        return;
    }
    // Authorization (risk R11, Tier C shape): the ONLY thing servable is the
    // file the host explicitly offered, matched by hash. No path ever comes
    // off the wire, and withdrawing the offer closes the door immediately.
    let offered = shared.offered.lock().map(|g| g.clone()).unwrap_or(None);
    let Some(file_info) = offered.filter(|f| f.blake3 == req.blake3) else {
        let _ = send
            .write_all(b"{\"t\":\"file-response\",\"ok\":false,\"error\":\"not offered\"}\n")
            .await;
        let _ = send.finish();
        return;
    };
    let offset = req.offset.min(file_info.size);
    let mut file = match tokio::fs::File::open(&file_info.path).await {
        Ok(f) => f,
        Err(_) => {
            let _ = send
                .write_all(b"{\"t\":\"file-response\",\"ok\":false,\"error\":\"file moved\"}\n")
                .await;
            let _ = send.finish();
            return;
        }
    };
    if file.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
        let _ = send.finish();
        return;
    }
    let header = format!(
        "{{\"t\":\"file-response\",\"ok\":true,\"size\":{},\"offset\":{}}}\n",
        file_info.size, offset
    );
    if send.write_all(header.as_bytes()).await.is_err() {
        return;
    }
    session_log(&app, "info", format!("Sending \"{}\" to {member} from byte {offset}.", file_info.name));

    let started = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();
    let mut sent: u64 = offset;
    let mut buf = vec![0u8; TRANSFER_CHUNK];
    loop {
        let n = match file.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if send.write_all(&buf[..n]).await.is_err() {
            // Receiver cancelled or dropped; their partial stays resumable.
            let _ = app.emit("session:transfer", serde_json::json!({
                "phase": "sendStopped", "member": member, "name": file_info.name,
                "received": sent as f64, "total": file_info.size as f64,
            }));
            return;
        }
        sent += n as u64;
        // R4 pacing: sleep whenever we are ahead of the byte budget.
        let target = Duration::from_secs_f64((sent - offset) as f64 / TRANSFER_BYTES_PER_SEC as f64);
        let elapsed = started.elapsed();
        if target > elapsed {
            tokio::time::sleep(target - elapsed).await;
        }
        if last_emit.elapsed().as_millis() >= 250 {
            last_emit = std::time::Instant::now();
            let _ = app.emit("session:transfer", serde_json::json!({
                "phase": "sending", "member": member, "name": file_info.name,
                "received": sent as f64, "total": file_info.size as f64,
            }));
        }
    }
    let _ = send.finish();
    let _ = app.emit("session:transfer", serde_json::json!({
        "phase": if sent >= file_info.size { "sent" } else { "sendStopped" },
        "member": member, "name": file_info.name,
        "received": sent as f64, "total": file_info.size as f64,
    }));
}

/// Serve one LIVE media request (Tier B 3c): remux the offered file to fMP4
/// from `start` seconds and stream it into the substream. Authorization is
/// identical to the file transfer: hash match against the ONE explicitly
/// offered file. One JSON header line out (timeline mode + epoch, the same
/// contract the proxy's web route ships in HTTP headers), then raw fMP4 to
/// EOF. Deliberately unpaced: a live stream self-limits at media rate, and
/// the guest's MSE buffer-ahead cap backpressures through QUIC and the
/// ffmpeg pipe (the 3b property).
async fn serve_media_substream(
    app: AppHandle,
    mut send: SendStream,
    shared: Arc<HostShared>,
    member: String,
    blake3: String,
    start: f64,
    rung_height: u32,
) {
    use tokio::io::AsyncReadExt;

    let offered = shared.offered.lock().map(|g| g.clone()).unwrap_or(None);
    let Some(file_info) = offered.filter(|f| f.blake3 == blake3) else {
        let _ = send
            .write_all(b"{\"t\":\"media-response\",\"ok\":false,\"error\":\"not offered\"}\n")
            .await;
        let _ = send.finish();
        return;
    };
    let Some(ff) = crate::stream_proxy::ffmpeg_path() else {
        let _ = send
            .write_all(b"{\"t\":\"media-response\",\"ok\":false,\"error\":\"no ffmpeg\"}\n")
            .await;
        let _ = send.finish();
        return;
    };
    let start = if start.is_finite() { start.clamp(0.0, 86_400.0) } else { 0.0 };

    // The rung the guest asked for. Anything unrecognised (including 0, and
    // including a height from a build with a different ladder) is passthrough
    // — the behaviour every host had before the ladder existed.
    let asked = crate::commands::rung::rung_for(rung_height);

    // The host's Mac is not a server, and this is the one place that fact can
    // be enforced. Whisper and the diarizer saturate the same silicon a
    // VideoToolbox encode wants, and whoever started them started them FIRST
    // and is sitting there waiting. A guest arriving afterwards gets a smaller
    // picture rather than the right to halve someone else's transcription.
    let host_busy = !app.state::<crate::commands::system::JobRegistry>().active_ids().is_empty();
    let rung = crate::commands::rung::clamp_for_host_load(asked, host_busy);
    if host_busy && rung != asked {
        session_log(
            &app,
            "info",
            format!(
                "Peer stream capped at {}p while this Mac is transcribing.",
                rung.map_or(0, |r| r.height)
            ),
        );
    }

    // Concurrent-encode backstop. Passthrough is not counted: `-c copy` costs
    // almost nothing, and refusing it would break the case that worked before
    // the ladder existed.
    let encode_guard = if rung.is_some() {
        let counter = shared.active_encodes.clone();
        if counter.fetch_add(1, Ordering::SeqCst) >= MAX_MEDIA_ENCODES {
            counter.fetch_sub(1, Ordering::SeqCst);
            session_log(
                &app,
                "warn",
                format!("Refused a {} stream: already encoding for {MAX_MEDIA_ENCODES} viewers.", member),
            );
            let _ = send
                .write_all(b"{\"t\":\"media-response\",\"ok\":false,\"error\":\"busy\"}\n")
                .await;
            let _ = send.finish();
            return;
        }
        struct EncodeGuard(Arc<AtomicUsize>);
        impl Drop for EncodeGuard {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        // Held for the life of this task, so a panic, a guest disconnect and a
        // seek teardown all release it. Same ownership rule the ffmpeg child
        // follows (R12): the task owns it, nothing shared to clobber.
        Some(EncodeGuard(counter))
    } else {
        None
    };
    let _encode_guard = encode_guard;

    // The host is the only person who can see what serving costs them.
    if let Some(r) = rung {
        let n = shared.active_encodes.load(Ordering::SeqCst);
        session_log(
            &app,
            "info",
            format!("Streaming to {n} viewer{} at {}p.", if n == 1 { "" } else { "s" }, r.height),
        );
    }

    // Epoch: which source timestamp the first delivered frame carries.
    //
    // The two paths genuinely differ, and using one answer for both is a real
    // bug rather than a rounding concern. On `-c copy`, input `-ss` hands back
    // the keyframe AT OR BEFORE the request, so the offset has to be probed
    // out of the file. On a re-encode, input `-ss` seeks ACCURATELY and drops
    // everything before the request, so the answer is just `start`.
    //
    // Measured on a 1080p30 file with a 2s GOP at start=11.0: the probe says
    // 10.0, `-c copy` really does begin at 10.0, and the encode begins at
    // 11.0. The guest assigns this to `SourceBuffer.timestampOffset`, so
    // handing it the probe's answer for an encoded stream shifts the entire
    // buffer one GOP early — up to ten seconds on the delivery masters R9
    // warns about, and invisibly, because a constant offset never trips a
    // drift check.
    //
    // Skipping the probe also removes an ffprobe spawn from the seek path,
    // which is the hot path while someone is scrubbing.
    let path_str = file_info.path.to_string_lossy().into_owned();
    let epoch = match crate::commands::rung::epoch_for_rung(rung, start) {
        Some(e) => Some(e),
        // Passthrough: probe. Absolute timeline is what makes a guest's far
        // seek land exactly; a probe failure is VISIBLE as "rebased" in the
        // header (risk R8), which the player already treats as
        // keyframe-precision landing.
        None if start > 0.0 => {
            let p = path_str.clone();
            tokio::task::spawn_blocking(move || crate::stream_proxy::probe_stream_epoch(&p, start))
                .await
                .ok()
                .flatten()
        }
        None => Some(0.0),
    };
    let served = rung.map_or(0, |r| r.height);
    let header = match epoch {
        Some(e) => format!(
            "{{\"t\":\"media-response\",\"ok\":true,\"timeline\":\"absolute\",\"epoch\":{e:.6},\"rung\":{served}}}\n"
        ),
        None => format!(
            "{{\"t\":\"media-response\",\"ok\":true,\"timeline\":\"rebased\",\"rung\":{served}}}\n"
        ),
    };
    if send.write_all(header.as_bytes()).await.is_err() {
        return;
    }

    let mut cmd = tokio::process::Command::new(ff);
    cmd.arg("-hide_banner").arg("-loglevel").arg("error");
    if start > 0.0 {
        cmd.arg("-ss").arg(format!("{start}"));
    }
    cmd.arg("-i").arg(&file_info.path);
    match rung {
        // A rung transcodes. Besides capping the bitrate — the point of the
        // ladder — this is also the only path on which a non-H.264 source
        // works at all: `-c copy` cannot put ProRes in an MP4 and refuses with
        // "Could not find tag for codec prores", AFTER the ok-header has
        // already gone out, so the guest sees success then silence.
        Some(r) => {
            // Colour probe drives the filter chain (10-bit dither, HDR
            // tonemap). A failed probe encodes anyway, as SDR-8; refusing
            // would turn a probe hiccup into a dead session.
            let colour = crate::commands::media::probe_playback_color(&app, &path_str)
                .await
                .map(|p| crate::commands::media::classify_playback_color(&p));
            for a in crate::commands::rung::rung_output_args(r, colour) {
                cmd.arg(a);
            }
        }
        // Passthrough. Mirrors serve_fmp4's local branch: -c copy, absolute
        // timestamps, 90kHz video timescale, streaming-friendly fMP4.
        None => {
            cmd.arg("-c")
                .arg("copy")
                .arg("-copyts")
                .arg("-muxpreload")
                .arg("0")
                .arg("-muxdelay")
                .arg("0")
                .arg("-video_track_timescale")
                .arg("90000")
                .arg("-movflags")
                .arg("frag_keyframe+empty_moov+default_base_moof")
                .arg("-f")
                .arg("mp4")
                .arg("pipe:1");
        }
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        // Risk R12: the serving task OWNS its child; the task ending (guest
        // seek teardown, disconnect, session end) kills exactly this ffmpeg.
        // No shared singleton to clobber.
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            session_log(&app, "err", format!("Peer stream ffmpeg spawn failed: {e}."));
            let _ = send.finish();
            return;
        }
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = send.finish();
        return;
    };
    session_log(
        &app,
        "info",
        format!("Streaming \"{}\" to {member} from {start:.2}s.", file_info.name),
    );
    let mut buf = vec![0u8; TRANSFER_CHUNK];
    loop {
        let n = match stdout.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => break,
        };
        if send.write_all(&buf[..n]).await.is_err() {
            // The guest tore this stream down (seek rebuild, pause+leave,
            // disconnect). Normal lifecycle; kill_on_drop reaps ffmpeg.
            return;
        }
    }
    let _ = send.finish();
    let _ = child.wait().await;
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
            peers.iter().map(|p| (p.member.clone(), p.name.clone(), p.epoch)),
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

/// Everything a guest's read loop shares with the `Session::Peer` that owns it.
/// Grouped because they are one thing - "what this guest believes about the
/// room" - and passing them individually pushed the loop past the argument cap.
struct PeerShared {
    roster: Arc<Mutex<Vec<PeerInfo>>>,
    self_id: Arc<Mutex<Option<String>>>,
    peer_title: Arc<Mutex<Option<String>>>,
    peer_presenter: Arc<Mutex<String>>,
    peer_presenter_epoch: Arc<AtomicU64>,
}

async fn peer_read_loop(
    app: AppHandle,
    recv: iroh::endpoint::RecvStream,
    shared: PeerShared,
    generation: u64,
) {
    let PeerShared {
        roster, self_id, peer_title, peer_presenter, peer_presenter_epoch,
    } = shared;
    let mut reader = BufReader::new(recv);
    loop {
        match read_line_bounded(&mut reader, MAX_MSG_BYTES).await {
            Ok(None) => {
                // Host closed the stream / ended the session.
                tokio::spawn(fail_peer_to_off(
                    app,
                    generation,
                    "The host ended the session".to_string(),
                ));
                return;
            }
            Err(e) => {
                // Oversize / mid-line EOF / non-UTF-8 from the host: a bounded
                // reader can't skip past an unbounded line, so the session
                // ends the same way a closed stream does (it used to buffer
                // the whole line before checking).
                session_log(&app, "warn", format!("Session stream violated the protocol: {e}."));
                tokio::spawn(fail_peer_to_off(
                    app,
                    generation,
                    "The session stream broke".to_string(),
                ));
                return;
            }
            Ok(Some(line)) => {
                let msg = match serde_json::from_str::<SessionMsg>(line.trim()) {
                    Ok(m) => m,
                    Err(e) => {
                        // Still non-fatal - forward compatibility means a newer
                        // host may legitimately send us something we don't know
                        // - but it is no longer INVISIBLE.
                        session_log(&app, "err", format!(
                            "Unreadable message from the host: {e}. If the two Macs are on \
                             different builds, that is the cause.",
                        ));
                        continue;
                    }
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
                    // Presenter changes the local permission gate AND is
                    // forwarded, so the UI can badge the new presenter.
                    SessionMsg::Presenter { ref member, epoch } => {
                        if let Ok(mut p) = peer_presenter.lock() {
                            *p = member.clone();
                        }
                        peer_presenter_epoch.store(u64::from(epoch), Ordering::Relaxed);
                        let _ = app.emit("session:msg", &msg);
                        emit_state_now(&app).await;
                    }
                    msg @ (SessionMsg::LoadSource { .. }
                    | SessionMsg::Transport { .. }
                    | SessionMsg::SourceStatus { .. }
                    | SessionMsg::ReviewOp { .. }
                    | SessionMsg::ReviewDoc { .. }
                    | SessionMsg::Presence { .. }
                    | SessionMsg::Sharing { .. }
                    | SessionMsg::Reaction { .. }
                    | SessionMsg::OfferFile { .. }) => {
                        let _ = app.emit("session:msg", &msg);
                    }
                    // Host never sends these to a peer.
                    SessionMsg::Hello { .. } | SessionMsg::Bye => {}
                }
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
/// True when the path this connection is CURRENTLY transmitting on is a relay.
///
/// R6: when hole-punching fails, iroh falls back to n0's public relay
/// infrastructure. That was an accepted cost for the control channel, which
/// carries kilobytes of JSON. Tier B pushes megabits of somebody's video
/// through the same path — still end-to-end encrypted, so the relay cannot
/// read it, but a materially different imposition on infrastructure we do not
/// own and a different promise to the user about where their file goes. The
/// guest answers this about its own connection and lets `stream-rung.ts` cap
/// the ladder to its lowest rung, with a visible "relayed" badge.
///
/// `paths()` is a SNAPSHOT, deliberately re-read per request rather than
/// cached: a connection routinely starts relayed and upgrades to direct once
/// hole-punching lands, so a value captured at join time would pin an entire
/// session to 360p over a link that became direct seconds later. (iroh 1.x
/// also offers `path_events()` for a live subscription; a per-request read is
/// enough here because a rung change costs a pipeline rebuild anyway, and
/// requests happen on exactly those rebuilds.)
///
/// An empty path list means we cannot tell. Answering `false` there is the
/// deliberate choice: guessing "relayed" would silently cap quality on a
/// perfectly good direct link, and the failure we are guarding against is
/// nobody being told, not the ladder being one rung too high.
fn is_relay_selected(conn: &Connection) -> bool {
    conn.paths()
        .iter()
        .find(|p| p.is_selected())
        .is_some_and(|p| p.is_relay())
}

/// Guest side of Tier B: service the proxy's media-stream requests over this
/// session's connection. Each request opens a fresh typed substream to the
/// host, forwards the header metadata, then pumps bytes into the bridge's
/// BOUNDED channel — `send().await` parking is what carries MSE pause
/// backpressure into QUIC (the 3b property). Dropping the reader (HTTP
/// client gone / seek teardown) fails the send, which drops the RecvStream,
/// which stops the host's write, which kills its ffmpeg.
async fn peer_media_service(
    conn: Connection,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<crate::commands::peer_stream::MediaStreamRequest>,
) {
    use crate::commands::peer_stream::{MediaStreamHandle, BRIDGE_CHANNEL_CHUNKS};

    #[derive(serde::Deserialize)]
    struct MediaHeader {
        ok: bool,
        #[serde(default)]
        timeline: String,
        #[serde(default)]
        epoch: Option<f64>,
        /// The rung the host really encoded. 0/absent means passthrough — and
        /// crucially that is ALSO what an older host sends when it silently
        /// ignores our `rung` field, which is exactly the case the guest has
        /// to be able to detect.
        #[serde(default)]
        rung: u32,
        #[serde(default)]
        error: String,
    }

    while let Some(req) = rx.recv().await {
        let conn = conn.clone();
        // Read per request, not once per session: hole-punching often lands
        // AFTER the connection is already usable, and each media request is a
        // pipeline rebuild anyway, so this is exactly when the answer can be
        // acted on for free.
        let relayed = is_relay_selected(&conn);
        tokio::spawn(async move {
            let refuse = |msg: String, resp: &std::sync::mpsc::SyncSender<std::io::Result<MediaStreamHandle>>| {
                let _ = resp.send(Err(std::io::Error::other(msg)));
            };
            let (mut send, recv) = match conn.open_bi().await {
                Ok(v) => v,
                Err(e) => return refuse(format!("open substream: {e}"), &req.resp),
            };
            let line = format!(
                "{{\"t\":\"media-request\",\"blake3\":\"{}\",\"start\":{},\"rung\":{}}}\n",
                req.blake3,
                req.start,
                req.rung.unwrap_or(0)
            );
            if send.write_all(line.as_bytes()).await.is_err() {
                return refuse("send request".into(), &req.resp);
            }
            let _ = send.finish();
            let mut reader = BufReader::new(recv);
            let header = match tokio::time::timeout(
                Duration::from_secs(15),
                read_line_bounded(&mut reader, MAX_HELLO_BYTES),
            )
            .await
            {
                Ok(Ok(Some(l))) => l,
                Ok(_) => return refuse("host closed the stream".into(), &req.resp),
                Err(_) => {
                    return refuse(
                        "the host didn't answer; their build may be older".into(),
                        &req.resp,
                    )
                }
            };
            let head: MediaHeader = match serde_json::from_str(header.trim()) {
                Ok(h) => h,
                Err(_) => return refuse("unreadable stream header".into(), &req.resp),
            };
            if !head.ok {
                return refuse(
                    if head.error.is_empty() { "host refused the stream".into() } else { head.error },
                    &req.resp,
                );
            }
            let timeline = if head.timeline == "absolute" { "absolute" } else { "rebased" };
            let (tx, brx) = tokio::sync::mpsc::channel::<bytes::Bytes>(BRIDGE_CHANNEL_CHUNKS);
            if req
                .resp
                .send(Ok(MediaStreamHandle {
                    timeline: timeline.to_string(),
                    epoch: if timeline == "absolute" { head.epoch } else { None },
                    rung: crate::commands::rung::rung_for(head.rung).map(|r| r.height),
                    relayed,
                    rx: brx,
                }))
                .is_err()
            {
                return; // worker gave up waiting; tear the substream down
            }
            // The header line went through a BufReader, which may have
            // buffered the first bytes of the MEDIA BODY along with it -
            // hand those over first (one small copy, once per stream),
            // then drop to the raw QUIC stream for the rest.
            let leftover = reader.buffer().to_vec();
            let mut recv = reader.into_inner();
            if !leftover.is_empty() && tx.send(bytes::Bytes::from(leftover)).await.is_err() {
                return;
            }
            // read_chunk yields the transport's own refcounted Bytes out of
            // the QUIC reassembly buffer. The old loop read into a scratch
            // buffer and then heap-allocated buf[..n].to_vec() per 64 KiB
            // chunk - with the ChannelReader's copy on the far side, every
            // streamed byte crossed userspace three times. Now it crosses
            // once, into the HTTP response.
            // `while let`, because every other arm already just broke: a
            // clean end of stream and a read error both mean stop.
            while let Ok(Some(chunk)) = recv.read_chunk(64 * 1024).await {
                if tx.send(chunk).await.is_err() {
                    // Reader dropped: the HTTP response ended (seek teardown
                    // or player gone). Dropping the stream STOPs it and the
                    // host's write fails on its next chunk.
                    break;
                }
            }
        });
    }
}

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
            media_task,
            ..
        } => {
            crate::commands::peer_stream::clear_media_hook();
            media_task.abort();
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
            presenter: String::new(),
            presenter_epoch: 0,
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
                .map(|p| PeerInfo { id: p.member.clone(), name: p.name.clone(), epoch: p.epoch })
                .collect(),
            self_id: Some("m0".into()),
            title: title.clone(),
            error: inner.last_error.clone(),
            presenter: format!("m{}", shared.presenter.load(Ordering::Relaxed)),
            presenter_epoch: shared.presenter_epoch.load(Ordering::Relaxed) as u32,
        },
        Session::Peer { roster, self_id, title, presenter, presenter_epoch, .. } => SessionState {
            role: "peer".into(),
            code: None,
            peers: roster.lock().map(|r| r.clone()).unwrap_or_default(),
            self_id: self_id.lock().map(|s| s.clone()).unwrap_or(None),
            title: title.lock().map(|t| t.clone()).unwrap_or(None),
            error: inner.last_error.clone(),
            presenter: presenter.lock().map(|p| p.clone()).unwrap_or_else(|_| "m0".into()),
            presenter_epoch: presenter_epoch.load(Ordering::Relaxed) as u32,
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
// TIER C — offer / fetch commands
// ============================================================

/// A received filename becomes a path segment on the GUEST's disk: strip
/// separators and control chars, cap the length, never yield empty.
/// Whether accepting this chunk would take the transfer past the size its
/// sender offered. Saturating, so a hostile `received` near u64::MAX cannot
/// wrap the sum back under `total` and slip the guard.
fn transfer_would_overflow(received: u64, chunk: usize, total: u64) -> bool {
    received.saturating_add(chunk as u64) > total
}

fn sanitize_transfer_filename(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control() && *c != '/' && *c != '\\' && *c != ':')
        .take(120)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() { "transfer".to_string() } else { cleaned }
}

/// In-flight guest fetches by hash, so Stop can interrupt the read loop.
/// Same shape as cloud_ai's chat cancel registry.
fn fetch_cancels() -> &'static std::sync::Mutex<HashMap<String, Arc<tokio::sync::Notify>>> {
    static M: std::sync::OnceLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Notify>>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Whole-file BLAKE3, mmap'd and hashed across every core. The serial
/// `update_reader` loop this replaces hashed a 60 GB master on ONE core
/// through 64 KiB reads - minutes of "Preparing the file..." for something
/// the memory bus can do in a fraction of the time.
fn hash_file_parallel(path: &std::path::Path) -> Result<blake3::Hasher, String> {
    let mut h = blake3::Hasher::new();
    h.update_mmap_rayon(path).map_err(|e| e.to_string())?;
    Ok(h)
}

/// (size, mtime) -> hex memo for offer hashing. Re-offering the same cut
/// after a withdraw, or after a source switch and back, used to re-hash the
/// whole file; the pair changes on any rewrite (and this app's own writers
/// are atomic temp+rename, which always bumps both), so a hit is safe to
/// trust and a warm re-offer costs a stat.
/// What the memo remembers for one path: the size and mtime it was hashed
/// at, and the hex digest. Named because the nested form was four types deep
/// and unreadable at the use site.
type OfferHashEntry = (u64, std::time::SystemTime, String);
type OfferHashMemo =
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, OfferHashEntry>>;

static OFFER_HASH_MEMO: std::sync::OnceLock<OfferHashMemo> = std::sync::OnceLock::new();

fn memoized_file_hash(path: &std::path::Path, size: u64, mtime: Option<std::time::SystemTime>) -> Result<String, String> {
    let memo = OFFER_HASH_MEMO.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    if let (Some(mt), Ok(map)) = (mtime, memo.lock()) {
        if let Some((s, t, hex)) = map.get(path) {
            if *s == size && *t == mt {
                return Ok(hex.clone());
            }
        }
    }
    let hex = hash_file_parallel(path)?.finalize().to_hex().to_string();
    if let (Some(mt), Ok(mut map)) = (mtime, memo.lock()) {
        map.insert(path.to_path_buf(), (size, mt, hex.clone()));
    }
    Ok(hex)
}

/// Host: hash the CURRENT source file and offer it to the room (Tier C).
/// The click that invokes this IS the sender's consent. Returns
/// `{ name, size, blake3 }` so the host UI can mirror the offer.
///
/// (This doc had drifted away from its function - two helpers were inserted
/// between them, leaving it stranded above `hash_file_parallel`.)
#[tauri::command]
pub async fn session_offer_file(
    app: AppHandle,
    state: State<'_, SessionManager>,
    path: String,
    name: Option<String>,
    vcodec: Option<String>,
    acodec: Option<String>,
) -> Result<serde_json::Value, crate::AppError> {
    let shared = {
        let inner = state.inner.lock().await;
        let Session::Host { shared, .. } = &inner.session else {
            return Err(crate::AppError::invalid("Only the session host can offer the file."));
        };
        shared.clone()
    };
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|e| format!("read file: {e}"))?;
    if !meta.is_file() {
        return Err(crate::AppError::invalid("That source is not a plain file."));
    }
    let size = meta.len();
    let path_buf = std::path::PathBuf::from(&path);
    let display = name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            path_buf
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".into())
        });
    let display = sanitize_transfer_filename(&display);

    let _ = app.emit("session:transfer", serde_json::json!({
        "phase": "hashing", "name": display, "received": 0.0, "total": size as f64,
    }));
    // BLAKE3 over the whole file (the guest's verification anchor). Blocking:
    // this is a multi-GB sequential read; blake3 itself runs multiple GB/s.
    let hash = tokio::task::spawn_blocking({
        let path_buf = path_buf.clone();
        let mtime = meta.modified().ok();
        move || memoized_file_hash(&path_buf, size, mtime)
    })
    .await
    .map_err(|e| format!("hash task: {e}"))?
    .map_err(|e| format!("hash file: {e}"))?;

    if let Ok(mut slot) = shared.offered.lock() {
        *slot = Some(OfferedFile {
            path: path_buf,
            name: display.clone(),
            size,
            blake3: hash.clone(),
        });
    }
    let msg = SessionMsg::OfferFile {
        from: "m0".into(),
        name: display.clone(),
        size: size as f64,
        blake3: hash.clone(),
        vcodec: vcodec.clone(),
        acodec: acodec.clone(),
    };
    // Sender id 0 is never minted for a peer, so this fans out to everyone.
    relay_to_others(&shared, 0, &msg).await;
    session_log(&app, "ok", format!("Offered \"{display}\" ({size} bytes) to the room."));
    Ok(serde_json::json!({
        "name": display, "size": size as f64, "blake3": hash,
        "vcodec": vcodec, "acodec": acodec,
    }))
}

/// Host: withdraw the current offer. Guests' in-flight fetches finish; new
/// requests are refused.
#[tauri::command]
pub async fn session_clear_offer(state: State<'_, SessionManager>) -> Result<(), crate::AppError> {
    let shared = {
        let inner = state.inner.lock().await;
        let Session::Host { shared, .. } = &inner.session else {
            return Ok(()); // no session, nothing offered
        };
        shared.clone()
    };
    if let Ok(mut slot) = shared.offered.lock() {
        *slot = None;
    }
    let msg = SessionMsg::OfferFile {
        from: "m0".into(), name: String::new(), size: 0.0, blake3: String::new(),
        vcodec: None, acodec: None,
    };
    relay_to_others(&shared, 0, &msg).await;
    Ok(())
}

/// Guest: fetch the offered file over a dedicated substream into the media
/// cache, resuming any partial by offset, verifying BLAKE3 before the final
/// rename. Emits `session:transfer` progress; returns the final local path.
#[tauri::command]
pub async fn session_fetch_file(
    app: AppHandle,
    state: State<'_, SessionManager>,
    blake3_hex: String,
    name: String,
) -> Result<String, crate::AppError> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    if blake3_hex.len() != 64 || !blake3_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(crate::AppError::invalid("Bad file id."));
    }
    let conn = {
        let inner = state.inner.lock().await;
        let Session::Peer { _conn, .. } = &inner.session else {
            return Err(crate::AppError::invalid("Join a session first."));
        };
        _conn.clone()
    };

    // Cancel registration (RAII removal on every exit path).
    let notify = Arc::new(tokio::sync::Notify::new());
    if let Ok(mut m) = fetch_cancels().lock() {
        if m.contains_key(&blake3_hex) {
            return Err(crate::AppError::invalid("That file is already being received."));
        }
        m.insert(blake3_hex.clone(), notify.clone());
    }
    struct CancelGuard(String);
    impl Drop for CancelGuard {
        fn drop(&mut self) {
            if let Ok(mut m) = fetch_cancels().lock() {
                m.remove(&self.0);
            }
        }
    }
    let _guard = CancelGuard(blake3_hex.clone());

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    let dir = cache.join(super::MEDIA_CACHE_DIRNAME).join(super::TRANSFERS_DIRNAME);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("create transfers dir: {e}"))?;
    let part = dir.join(format!("{blake3_hex}.part"));
    let display = sanitize_transfer_filename(&name);

    // Resume: an existing partial sets the offset, and its bytes are folded
    // into the hasher so the final verify still covers the WHOLE file.
    let mut hasher = blake3::Hasher::new();
    let mut offset: u64 = 0;
    if let Ok(m) = tokio::fs::metadata(&part).await {
        if m.is_file() && m.len() > 0 {
            offset = m.len();
            let _ = app.emit("session:transfer", serde_json::json!({
                "phase": "checking", "name": display, "received": offset as f64, "total": 0.0,
            }));
            let p2 = part.clone();
            hasher = tokio::task::spawn_blocking(move || hash_file_parallel(&p2))
            .await
            .map_err(|e| format!("rehash task: {e}"))?
            .map_err(|e| format!("rehash partial: {e}"))?;
        }
    }

    let (mut send, recv) = conn
        .open_bi()
        .await
        .map_err(|e| format!("open transfer stream: {e}"))?;
    let req = format!("{{\"t\":\"file-request\",\"blake3\":\"{blake3_hex}\",\"offset\":{offset}}}\n");
    send.write_all(req.as_bytes())
        .await
        .map_err(|e| format!("send request: {e}"))?;
    let _ = send.finish();

    let mut reader = BufReader::new(recv);
    let header = match tokio::time::timeout(Duration::from_secs(15), read_line_bounded(&mut reader, MAX_HELLO_BYTES)).await {
        Ok(Ok(Some(l))) => l,
        Ok(Ok(None)) | Ok(Err(_)) => return Err(crate::AppError::invalid("The host closed the transfer stream.")),
        Err(_) => {
            return Err(crate::AppError::invalid(
                "The host didn't answer. Their Sauce Bunny may be older than this one.",
            ))
        }
    };
    #[derive(serde::Deserialize)]
    struct FetchHeader {
        ok: bool,
        #[serde(default)]
        size: u64,
        #[serde(default)]
        error: String,
    }
    let head: FetchHeader = serde_json::from_str(header.trim())
        .map_err(|_| crate::AppError::invalid("Unreadable transfer header."))?;
    if !head.ok {
        return Err(crate::AppError::invalid(match head.error.as_str() {
            "busy" => "The host is sending to too many people right now. Try again in a moment.",
            "not offered" => "That file is no longer offered.",
            "file moved" => "The host's copy moved or was deleted.",
            _ => "The host refused the transfer.",
        }));
    }
    let total = head.size;
    if offset > total {
        // Stale partial from a different file that hashed the same name slot.
        offset = 0;
        hasher = blake3::Hasher::new();
        let _ = tokio::fs::remove_file(&part).await;
    }

    let mut out = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part)
        .await
        .map_err(|e| format!("open partial: {e}"))?;
    let mut received = offset;
    let mut last_emit = std::time::Instant::now();
    let _ = app.emit("session:transfer", serde_json::json!({
        "phase": "receiving", "name": display, "received": received as f64, "total": total as f64,
    }));

    let mut buf = vec![0u8; TRANSFER_CHUNK];
    loop {
        let read = tokio::select! {
            _ = notify.notified() => {
                let _ = out.flush().await;
                let _ = app.emit("session:transfer", serde_json::json!({
                    "phase": "cancelled", "name": display, "received": received as f64, "total": total as f64,
                }));
                return Err(crate::AppError::invalid("Stopped. The partial copy is kept; fetching again resumes."));
            }
            r = tokio::time::timeout(FETCH_READ_TIMEOUT, reader.read(&mut buf)) => r,
        };
        let n = match read {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                let _ = out.flush().await;
                let _ = app.emit("session:transfer", serde_json::json!({
                    "phase": "stalled", "name": display, "received": received as f64, "total": total as f64,
                }));
                return Err(crate::AppError::invalid(format!(
                    "The connection dropped mid-transfer ({e}). Fetching again resumes where it stopped."
                )));
            }
            Err(_) => {
                let _ = out.flush().await;
                let _ = app.emit("session:transfer", serde_json::json!({
                    "phase": "stalled", "name": display, "received": received as f64, "total": total as f64,
                }));
                return Err(crate::AppError::invalid(
                    "The transfer stalled. Fetching again resumes where it stopped.",
                ));
            }
        };
        // The offered `size` is the contract, and until now it was checked
        // only AFTER the loop had already written everything that arrived.
        // Every other read from a peer on this connection is bounded -
        // MAX_HELLO_BYTES for the hello, MAX_MSG_BYTES per control line, both
        // through read_line_bounded - and the file body was the one that ran
        // to EOF. A sender that kept sending, whether by malice or by a
        // mis-sized offer, wrote into the receiver's cache until the disk ran
        // out, and `received != total` reported it afterwards.
        //
        // Checked BEFORE the write, so the partial left on disk is exactly the
        // bytes that were agreed and a later resume is still valid.
        if transfer_would_overflow(received, n, total) {
            let _ = app.emit("session:transfer", serde_json::json!({
                "phase": "failed", "name": display,
                "received": received as f64, "total": total as f64,
            }));
            return Err(crate::AppError::invalid(
                "The sender sent more than it offered; the transfer was stopped.",
            ));
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n])
            .await
            .map_err(|e| format!("write partial: {e}"))?;
        received += n as u64;
        if last_emit.elapsed().as_millis() >= 250 {
            last_emit = std::time::Instant::now();
            let _ = app.emit("session:transfer", serde_json::json!({
                "phase": "receiving", "name": display, "received": received as f64, "total": total as f64,
            }));
        }
    }
    out.flush().await.map_err(|e| format!("flush partial: {e}"))?;
    out.sync_all().await.map_err(|e| format!("sync partial: {e}"))?;
    drop(out);

    if received != total {
        let _ = app.emit("session:transfer", serde_json::json!({
            "phase": "stalled", "name": display, "received": received as f64, "total": total as f64,
        }));
        return Err(crate::AppError::invalid(
            "The host stopped before the file finished. Fetching again resumes where it stopped.",
        ));
    }
    let got = hasher.finalize().to_hex().to_string();
    if got != blake3_hex.to_ascii_lowercase() {
        let _ = tokio::fs::remove_file(&part).await;
        let _ = app.emit("session:transfer", serde_json::json!({
            "phase": "failed", "name": display, "received": received as f64, "total": total as f64,
        }));
        return Err(crate::AppError::invalid(
            "The received file failed verification and was removed. Fetch it again.",
        ));
    }

    let final_path = dir.join(format!("{}-{}", &blake3_hex[..8], display));
    tokio::fs::rename(&part, &final_path)
        .await
        .map_err(|e| format!("finalize transfer: {e}"))?;
    let final_str = final_path.to_string_lossy().into_owned();
    let _ = app.emit("session:transfer", serde_json::json!({
        "phase": "done", "name": display, "received": total as f64, "total": total as f64, "path": final_str,
    }));
    session_log(&app, "ok", format!("Received \"{display}\" ({total} bytes), verified."));
    Ok(final_str)
}

/// Guest: stop an in-flight fetch. The partial is kept for resume.
#[tauri::command]
pub fn session_cancel_fetch(blake3_hex: String) -> Result<(), crate::AppError> {
    if let Ok(m) = fetch_cancels().lock() {
        if let Some(n) = m.get(&blake3_hex) {
            n.notify_one();
        }
    }
    Ok(())
}

// ============================================================
// TESTS — lock the wire contract the frontend is coded against.
// ============================================================

#[cfg(test)]
mod tests {

    /// Peer display names arrive over the wire from another machine and are
    /// rendered in the roster, so they are untrusted input. `sanitize_name`
    /// had no test.
    #[test]
    fn sanitize_name_keeps_ordinary_names() {
        // Canary first: a filter that stripped everything would satisfy every
        // rejection below.
        assert_eq!(sanitize_name("Ada Lovelace"), "Ada Lovelace");
        assert_eq!(sanitize_name("  Ada  "), "Ada");
        // Non-ASCII is a name, not an attack.
        assert_eq!(sanitize_name("Ada Łovelace 日本"), "Ada Łovelace 日本");
    }

    #[test]
    fn sanitize_name_strips_control_characters() {
        // A newline or an ANSI escape in a roster entry can forge a second
        // participant, or scramble any log line the name is written into.
        assert_eq!(sanitize_name("Ada\nMallory"), "AdaMallory");
        assert_eq!(sanitize_name("Ada\u{001b}[31m"), "Ada[31m");
        assert_eq!(sanitize_name("Ada\u{0000}"), "Ada");
        assert_eq!(sanitize_name("\r\n"), "");
    }

    #[test]
    fn sanitize_name_caps_the_length() {
        // 40 CHARS, not bytes — a cap counted in bytes would split a
        // multi-byte character and panic on the slice.
        let long = "A".repeat(200);
        assert_eq!(sanitize_name(&long).chars().count(), 40);
        let wide = "日".repeat(200);
        assert_eq!(sanitize_name(&wide).chars().count(), 40);
    }

    use super::*;

    #[tokio::test]
    async fn bounded_reader_reads_lines_and_signals_clean_eof() {
        let data: &[u8] = b"hello\nworld\n";
        let mut r = BufReader::new(data);
        assert_eq!(read_line_bounded(&mut r, 64).await.unwrap().as_deref(), Some("hello"));
        assert_eq!(read_line_bounded(&mut r, 64).await.unwrap().as_deref(), Some("world"));
        assert!(read_line_bounded(&mut r, 64).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn bounded_reader_rejects_an_oversize_line_instead_of_buffering_it() {
        // 1 MiB of no-newline garbage against a 1 KiB cap: the old read_line
        // path buffered ALL of it before any length check ran.
        let big = vec![b'x'; 1024 * 1024];
        let mut r = BufReader::new(&big[..]);
        let err = read_line_bounded(&mut r, 1024).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[tokio::test]
    async fn bounded_reader_edge_cases() {
        // A line exactly AT the cap passes.
        let mut exact = Vec::from(&b"x"[..]).repeat(8);
        exact.push(b'\n');
        let mut r = BufReader::new(&exact[..]);
        assert_eq!(read_line_bounded(&mut r, 8).await.unwrap().as_deref(), Some("xxxxxxxx"));
        // EOF mid-line is a violation, not a line.
        let mut r = BufReader::new(&b"unterminated"[..]);
        assert_eq!(
            read_line_bounded(&mut r, 64).await.unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof,
        );
        // Non-UTF-8 is a violation.
        let mut r = BufReader::new(&[0xff, 0xfe, b'\n'][..]);
        assert_eq!(
            read_line_bounded(&mut r, 64).await.unwrap_err().kind(),
            std::io::ErrorKind::InvalidData,
        );
    }

    #[test]
    fn transport_wire_shape_matches_contract() {
        let msg = SessionMsg::Transport {
            playing: true,
            position: 12.5,
            rate: 1.0,
            at_ms: 1_750_000_000_000.0,
            seq: 7,
            from: "m0".into(),
            epoch: 1,
        };
        let json = serde_json::to_string(&msg).unwrap();
        // Tag + camelCase fields — the frontend switches on exactly these.
        assert!(json.contains(r#""kind":"transport""#), "json: {json}");
        assert!(json.contains(r#""atMs":"#), "json: {json}");
        assert!(json.contains(r#""playing":true"#), "json: {json}");
        assert!(json.contains(r#""position":12.5"#), "json: {json}");
        assert!(json.contains(r#""rate":1.0"#), "json: {json}");
        assert!(json.contains(r#""seq":7"#), "json: {json}");
        assert!(json.contains(r#""epoch":1"#), "json: {json}");
    }

    #[test]
    fn variant_tags_are_camel_case() {
        let hello = serde_json::to_string(&SessionMsg::Hello { name: "Ada".into(), install: "i1".into(), grant: None }).unwrap();
        assert!(hello.contains(r#""kind":"hello""#), "json: {hello}");
        let list = serde_json::to_string(&SessionMsg::PeerList { peers: vec![PeerInfo { id: "m0".into(), name: "Host".into(), epoch: 0 }] }).unwrap();
        assert!(list.contains(r#""kind":"peerList""#), "json: {list}");
        let load = serde_json::to_string(&web_source("https://x")).unwrap();
        assert!(load.contains(r#""kind":"loadSource""#), "json: {load}");
        // The discriminator is `sourceKind`; `kind` belongs to serde's tag.
        assert!(load.contains(r#""sourceKind":"web""#), "json: {load}");
        let st = serde_json::to_string(&SessionMsg::SourceStatus { from: "m1".into(), state: "ready".into(), detail: None }).unwrap();
        assert!(st.contains(r#""kind":"sourceStatus""#), "json: {st}");
        let pr = serde_json::to_string(&SessionMsg::Presenter { member: "m1".into(), epoch: 2 }).unwrap();
        assert!(pr.contains(r#""kind":"presenter""#), "json: {pr}");
        let bye = serde_json::to_string(&SessionMsg::Bye).unwrap();
        assert!(bye.contains(r#""kind":"bye""#), "json: {bye}");
    }

    /// Terse builder so the source tests read as one line each.
    fn web_source(url: &str) -> SessionMsg {
        SessionMsg::LoadSource {
            from: "m0".into(),
            source_kind: "web".into(),
            url: Some(url.into()),
            fingerprint: None,
            title: None,
            duration: None,
            review_key: url.into(),
        }
    }

    #[test]
    fn session_msg_round_trips_line_protocol() {
        let msg = web_source("https://example.com/v");
        let line = serde_json::to_string(&msg).unwrap();
        let back: SessionMsg = serde_json::from_str(line.trim()).unwrap();
        match back {
            SessionMsg::LoadSource { url, source_kind, review_key, .. } => {
                assert_eq!(url.as_deref(), Some("https://example.com/v"));
                assert_eq!(source_kind, "web");
                assert_eq!(review_key, "https://example.com/v");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn local_file_source_round_trips_without_a_url() {
        // The case that used to broadcast NOTHING: a local file has no URL,
        // so it travels as a fingerprint the peer resolves on its own disk.
        let msg = SessionMsg::LoadSource {
            from: "m0".into(),
            source_kind: "file".into(),
            url: None,
            fingerprint: Some("cut-v4.mov|1234|1920x1080|999".into()),
            title: Some("cut-v4.mov".into()),
            duration: Some(123.4),
            review_key: "cut-v4.mov|1234|1920x1080|999".into(),
        };
        let line = serde_json::to_string(&msg).unwrap();
        let back: SessionMsg = serde_json::from_str(line.trim()).unwrap();
        match back {
            SessionMsg::LoadSource { source_kind, url, fingerprint, .. } => {
                assert_eq!(source_kind, "file");
                assert!(url.is_none());
                assert_eq!(fingerprint.as_deref(), Some("cut-v4.mov|1234|1920x1080|999"));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn the_host_stamps_the_epoch_so_a_handover_can_be_ordered() {
        // The bug this locks: Transport used to carry a hardcoded epoch 0 from
        // the sender. A peer's `seq` restarts at 0 when it takes the floor, so
        // to any receiver whose seq was already high those messages looked
        // stale and were DROPPED - a guest froze until the new presenter's seq
        // climbed past the old one. The epoch must come from host state, and
        // it must increase on every grant, so receivers can order across it.
        let e1 = 1u32;
        let e2 = 2u32;
        assert!(e2 > e1, "a later grant must out-rank an earlier one");

        // Ordering rule the receiver applies, expressed directly: a message
        // from a NEWER epoch always wins, however low its seq.
        let accepts = |last: (u32, u32), incoming: (u32, u32)| -> bool {
            if incoming.0 < last.0 { return false; }
            if incoming.0 == last.0 && incoming.1 <= last.1 { return false; }
            true
        };
        // Old presenter got to seq 400; new presenter starts at seq 1.
        assert!(accepts((e1, 400), (e2, 1)), "a new presenter must not be ignored");
        // Within one epoch, stale/duplicate lines are still dropped.
        assert!(!accepts((e1, 400), (e1, 399)));
        assert!(!accepts((e1, 400), (e1, 400)));
        assert!(accepts((e1, 400), (e1, 401)));
        // A line from a SUPERSEDED presenter never wins.
        assert!(!accepts((e2, 5), (e1, 999)));
    }

    #[test]
    fn only_the_presenter_may_drive() {
        // The relay gate: presenter 0 is the host, so only m0 drives.
        assert!(can_drive(0, "m0"));
        assert!(!can_drive(0, "m1"));
        // Hand the floor to m1 and the permission moves with it.
        assert!(can_drive(1, "m1"));
        assert!(!can_drive(1, "m0"));
        // Malformed ids can never drive - the safe direction for a gate.
        assert!(!can_drive(0, "bogus"));
        assert!(!can_drive(0, ""));
        assert_eq!(member_num("m7"), 7);
        assert_eq!(member_num("nope"), u64::MAX);
    }

    #[test]
    fn an_unstamped_review_op_from_an_older_peer_still_parses() {
        // #[serde(default)] is what keeps a build that predates the identity
        // stamp usable: its ops arrive unattributed (the receiver then leaves
        // the payload's own author alone) rather than failing to parse and
        // silently losing that person's notes.
        let line = r#"{"kind":"reviewOp","op":"{}"}"#;
        match serde_json::from_str::<SessionMsg>(line).unwrap() {
            SessionMsg::ReviewOp { op, from } => {
                assert_eq!(op, "{}");
                assert_eq!(from, "", "missing stamp must read as unattributed, not fail");
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn phase2_variant_tags_and_round_trip() {
        let op = serde_json::to_string(&SessionMsg::ReviewOp { op: "{}".into(), from: "m2".into() }).unwrap();
        assert!(op.contains(r#""kind":"reviewOp""#), "json: {op}");
        let doc = serde_json::to_string(&SessionMsg::ReviewDoc { doc: "{}".into() }).unwrap();
        assert!(doc.contains(r#""kind":"reviewDoc""#), "json: {doc}");
        let pres = serde_json::to_string(&SessionMsg::Presence { name: "Ada".into(), position: 3.5 }).unwrap();
        assert!(pres.contains(r#""kind":"presence""#), "json: {pres}");
        assert!(pres.contains(r#""position":3.5"#), "json: {pres}");
        // Round-trip a relayed op line.
        let back: SessionMsg = serde_json::from_str(op.trim()).unwrap();
        match back {
            SessionMsg::ReviewOp { op, from } => {
                assert_eq!(op, "{}");
                assert_eq!(from, "m2", "the host stamp must survive the round trip");
            }
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
    members: impl Iterator<Item = (String, String, u32)>,
) -> Vec<PeerInfo> {
    std::iter::once(PeerInfo { id: "m0".into(), name: host_name.to_string(), epoch: 0 })
        .chain(members.map(|(id, name, epoch)| PeerInfo { id, name, epoch }))
        .collect()
}

/// Numeric part of a member id (`m3` → 3). Malformed ids sort last and can
/// never match a presenter, which is the safe direction for a permission gate.
fn member_num(id: &str) -> u64 {
    id.strip_prefix('m').and_then(|n| n.parse().ok()).unwrap_or(u64::MAX)
}

/// May this member drive source + transport? Pure so the permission rule is
/// unit-testable without a network.
fn can_drive(presenter: u64, member: &str) -> bool {
    member_num(member) == presenter
}

#[cfg(test)]
mod member_id_tests {
    use super::*;

    /// Members at epoch 1 (their first claim) - the ordinary case.
    fn members(v: &[(&str, &str)]) -> Vec<(String, String, u32)> {
        v.iter().map(|(a, b)| (a.to_string(), b.to_string(), 1)).collect()
    }

    #[test]
    fn host_is_always_m0_and_first() {
        let r = build_roster("Nika", members(&[("m1", "Ada"), ("m2", "Lin")]).into_iter());
        assert_eq!(r[0], PeerInfo { id: "m0".into(), name: "Nika".into(), epoch: 0 });
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
    fn a_reclaimed_id_keeps_its_slot_and_bumps_its_epoch() {
        // The rejoin case: same person, same id, higher epoch - ONE row, not
        // two. The epoch bump is what tells the mesh to rebuild that peer's
        // connection instead of leaving a tile stuck on "Connecting".
        let before = build_roster("Host", members(&[("m1", "Ada")]).into_iter());
        let after = build_roster(
            "Host",
            vec![("m1".to_string(), "Ada".to_string(), 2u32)].into_iter(),
        );
        assert_eq!(before.len(), after.len(), "a rejoin must not grow the roster");
        assert_eq!(after[1].id, "m1");
        assert!(after[1].epoch > before[1].epoch);
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

/// The literal prefix every iroh `EndpointTicket` starts with.
///
/// It is a format tag, identical on every ticket ever minted, and the parser
/// requires it back - so it is stripped for DISPLAY and restored on parse
/// rather than shown to a human eleven times a day.
const TICKET_TAG: &str = "endpoint";

/// Shareable invite: `SAUC-` + the ticket, uppercased, in dash groups of 5.
///
/// Two things this does that the first version did not, both about the code
/// looking like a code:
///
/// **The `endpoint` tag is dropped.** Every ticket begins with those eight
/// characters, so every invite began `SAUC-endpo-intXX`. The host's chip
/// truncates at 26 characters, which meant eleven of the twenty-one visible
/// characters were the same on every session in the app's history - the part
/// a person actually reads carried almost no information, and it read as a
/// URL fragment rather than something to share.
///
/// **It is uppercased.** z-base-32 is lowercase, and lowercase runs of it
/// look like a mangled word (`endpo-intac-2hweh`). Uppercase is the shape
/// people already recognise as a code. Safe because the alphabet is
/// case-insensitive in one direction: `parse_invite` lowercases before the
/// ticket parser sees it, and an uppercase round-trip is asserted in the
/// tests below rather than assumed.
pub(crate) fn format_invite(ticket: &str) -> String {
    let body = ticket.strip_prefix(TICKET_TAG).unwrap_or(ticket).to_uppercase();
    let mut out = String::with_capacity(body.len() + body.len() / 5 + 5);
    out.push_str("SAUC-");
    for (i, c) in body.chars().enumerate() {
        if i > 0 && i % 5 == 0 {
            out.push('-');
        }
        out.push(c);
    }
    out
}

/// Recover the raw ticket from any pasted form.
///
/// Deliberately permissive, because the failure is a person who cannot join a
/// call: whitespace (including the newlines chat apps wrap long pastes with)
/// and group dashes are display sugar, the `SAUC` handle is optional, and
/// case is irrelevant. Every form the app has ever produced still works -
/// dressed or raw, uppercase or lower, with the `endpoint` tag or without -
/// which matters because a host on one build shares a code with a guest on
/// another.
///
/// The tag is restored by checking whether it is already there. A ticket body
/// could in principle begin with the letters `endpoint` on its own (they are
/// all in the z-base-32 alphabet) and be left un-prefixed, at a probability
/// of 32^-8, or about one in a trillion. Named rather than hidden; the
/// alternative is a length heuristic, and ticket length varies with how many
/// addresses the endpoint advertises, so that would fail far more often.
pub(crate) fn parse_invite(input: &str) -> String {
    let stripped: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .to_lowercase();
    // is_char_boundary guards the slice - a paste with multibyte chars at the
    // seam (emoji, smart quotes) must not panic the command.
    let body = if stripped.len() > 4 && stripped.is_char_boundary(4) && &stripped[..4] == "sauc" {
        &stripped[4..]
    } else {
        &stripped[..]
    };
    if body.starts_with(TICKET_TAG) {
        body.to_string()
    } else {
        format!("{TICKET_TAG}{body}")
    }
}

#[cfg(test)]
mod invite_tests {
    use super::*;
    use std::str::FromStr;

    /// A REAL ticket, minted the way `session_host` mints one.
    ///
    /// This used to be a hand-typed constant, and it did not parse - it was
    /// not a ticket at all, just a plausible-looking string. Every test here
    /// passed against it, and none of them could have caught a change that
    /// broke the actual format, because the actual parser was never involved.
    /// The round-trip test below is the one that matters and it was the one
    /// the fake constant made impossible.
    fn real_ticket() -> String {
        let secret = iroh::SecretKey::generate();
        EndpointTicket::new(iroh::EndpointAddr::from(secret.public())).to_string()
    }

    /// The LEGACY form: a ticket carrying addresses, the way every build
    /// before the id-only change minted one. Kept because a host on one build
    /// shares a code with a guest on another, so `parse_invite` has to keep
    /// accepting these forever. Nothing tested this shape before, because the
    /// fixture above happened to be address-free while the app was not.
    fn addressed_ticket() -> String {
        let secret = iroh::SecretKey::generate();
        let mut addr = iroh::EndpointAddr::from(secret.public());
        addr.addrs.insert(iroh::TransportAddr::Ip("192.0.2.7:41641".parse().unwrap()));
        EndpointTicket::new(addr).to_string()
    }

    #[test]
    fn the_code_we_mint_carries_no_address() {
        // THE PHASE 2 PROPERTY. `endpoint.addr()` packs the live relay URL and
        // the observed IP set, including LAN addresses, which is both a
        // durability problem (they go stale) and a disclosure one. An id-only
        // ticket names the key and lets discovery resolve the rest.
        let t = real_ticket();
        let parsed = EndpointTicket::from_str(&t).expect("fixture parses");
        let addr: iroh::EndpointAddr = parsed.into();
        assert!(
            addr.addrs.is_empty(),
            "the minted code carries {} address(es); it should carry only the key",
            addr.addrs.len(),
        );
    }

    /// THE CLAIM PHASE 2 RESTS ON, and the one nothing else here proves:
    /// that a code carrying only a key can actually be dialled.
    ///
    /// Every other test in this module is about string handling. They would
    /// all pass on a build where id-only dialing silently never connects,
    /// which would mean nobody could join a session at all. An earlier pass
    /// at this recorded that "NodeId-only dialing is not verifiable on our
    /// setup without live discovery" and took the address-bearing option
    /// instead - deferred, not disproven. This is the verification that was
    /// missing.
    ///
    /// Needs the network: both ends publish to and resolve from n0's DNS.
    #[tokio::test]
    #[ignore = "nightly: needs live n0 discovery"]
    async fn nightly_a_key_only_code_actually_dials() {
        let host = Endpoint::builder(presets::N0)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("host bind");
        // Publication is what an addr-less dial depends on, so give it the
        // same bounded wait session_start gives it.
        let _ = tokio::time::timeout(ONLINE_TIMEOUT, host.online()).await;

        // Exactly what session_start now mints, through the same dress and
        // parse the user's clipboard puts it through.
        let code = format_invite(&EndpointTicket::new(EndpointAddr::new(host.id())).to_string());
        let parsed: EndpointTicket = parse_invite(&code).parse().expect("code parses");
        let target: EndpointAddr = parsed.into();
        assert!(target.addrs.is_empty(), "fixture carried addresses, so this proves nothing");

        let accept = tokio::spawn(async move {
            let incoming = host.accept().await.expect("no inbound connection");
            incoming.await.expect("handshake")
        });

        let guest = Endpoint::builder(presets::N0).bind().await.expect("guest bind");
        let conn = tokio::time::timeout(JOIN_TIMEOUT, guest.connect(target, ALPN))
            .await
            .expect("dial timed out: discovery did not resolve the key")
            .expect("dial failed");

        let served = tokio::time::timeout(JOIN_TIMEOUT, accept).await
            .expect("accept timed out").expect("accept panicked");
        assert_eq!(
            served.remote_id(), guest.id(),
            "the connection that landed is not the one we dialled",
        );
        drop(conn);
    }

    #[test]
    fn a_legacy_addressed_code_still_joins() {
        // Back-compat, in the direction that actually happens: an OLD host
        // hands a NEW guest a code. If this breaks, upgrading strands people
        // mid-project with no error that explains why.
        let t = addressed_ticket();
        let recovered = parse_invite(&format_invite(&t));
        assert_eq!(recovered, t, "a legacy code did not survive the invite dress");
        let parsed = EndpointTicket::from_str(&recovered).expect("legacy code must still parse");
        let addr: iroh::EndpointAddr = parsed.into();
        assert!(!addr.addrs.is_empty(), "the legacy fixture lost its address, so this proves nothing");
    }

    #[test]
    fn the_fixture_is_a_ticket_the_parser_accepts() {
        // Guards every other test in this module.
        let t = real_ticket();
        assert!(EndpointTicket::from_str(&t).is_ok(), "fixture is not a real ticket: {t}");
        assert!(t.starts_with(TICKET_TAG));
    }

    #[test]
    fn a_dressed_invite_parses_back_into_a_working_ticket() {
        // The whole contract, end to end: what the host copies, a guest can
        // paste, and iroh can dial. Not "the strings match" - the ticket
        // parser accepts the result.
        let t = real_ticket();
        let invite = format_invite(&t);
        let recovered = parse_invite(&invite);
        assert_eq!(recovered, t);
        assert!(EndpointTicket::from_str(&recovered).is_ok());
    }

    #[test]
    fn the_code_shows_no_characters_that_are_the_same_every_time() {
        // The defect this change exists for. Every ticket starts with the
        // literal tag "endpoint", so every invite began SAUC-endpo-intXX, and
        // the host's chip truncates at 26 characters - eleven of the twenty-one
        // visible characters carried no information about WHICH session.
        let invite = format_invite(&real_ticket());
        assert!(!invite.to_lowercase().contains("endpo"), "the format tag is back: {invite}");
        let visible = &invite[..26.min(invite.len())];
        assert!(!visible.to_lowercase().contains("endpo"), "wasted characters up front: {visible}");
    }

    #[test]
    fn it_reads_as_a_code_rather_than_a_word() {
        // Letters, digits and group dashes - the shape people recognise from
        // every other service that hands out a join code.
        let invite = format_invite(&real_ticket());
        assert!(invite.starts_with("SAUC-"));
        for (i, group) in invite.split('-').skip(1).enumerate() {
            assert!(!group.is_empty(), "empty group {i} in {invite}");
            assert!(group.len() <= 5, "group {i} is {} chars: {invite}", group.len());
            assert!(
                group.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
                "group {i} is not upper-alphanumeric: {group}",
            );
        }
    }

    #[test]
    fn every_form_the_app_has_ever_produced_still_joins() {
        // A host on one build shares a code with a guest on another. All four
        // of these have been the shipped format at some point, and each must
        // still recover the same ticket.
        let t = real_ticket();
        let body = t.strip_prefix(TICKET_TAG).unwrap();
        let legacy_dressed = {
            // "SAUC-" + lowercase ticket WITH the tag, in groups of 5.
            let mut out = String::from("SAUC-");
            for (i, c) in t.chars().enumerate() {
                if i > 0 && i % 5 == 0 { out.push('-'); }
                out.push(c);
            }
            out
        };
        for (label, form) in [
            ("current", format_invite(&t)),
            ("legacy dressed", legacy_dressed),
            ("raw ticket", t.clone()),
            ("raw body, no tag", body.to_string()),
            ("uppercased raw", t.to_uppercase()),
        ] {
            assert_eq!(parse_invite(&form), t, "{label} did not recover the ticket");
        }
    }

    #[test]
    fn parse_survives_chat_wrapping_and_stray_spacing() {
        // Slack and iMessage wrap long codes; people paste with a trailing
        // newline and a leading space. None of that may cost someone a call.
        let t = real_ticket();
        let invite = format_invite(&t);
        let wrapped = invite
            .chars()
            .enumerate()
            .flat_map(|(i, c)| if i > 0 && i % 20 == 0 { vec!['\n', c] } else { vec![c] })
            .collect::<String>();
        assert_eq!(parse_invite(&format!("  {wrapped}  \n")), t);
        assert_eq!(parse_invite(&invite.to_lowercase()), t);
        assert_eq!(parse_invite(&format!("\t{invite}\r\n")), t);
    }

    #[test]
    fn a_multibyte_paste_does_not_panic() {
        // Smart quotes and emoji arrive when someone copies out of a chat app
        // with formatting. The command must reject, not crash.
        for junk in ["\u{201c}SAUC-ABCDE\u{201d}", "🐰SAUC-ABCDE", "…", "\u{201c}\u{201d}"] {
            let _ = parse_invite(junk);
        }
    }

    /// What the two forms actually MEASURE, because the host chip truncates
    /// at 26 characters and a code that got longer would show less of itself.
    /// Printed rather than asserted tightly: the addressed length varies with
    /// how many addresses were advertised, which is the reason the id-only
    /// form is worth having.
    #[test]
    fn the_id_only_code_is_not_longer_than_the_addressed_one() {
        let id_only = format_invite(&real_ticket());
        let addressed = format_invite(&addressed_ticket());
        println!("id-only   {} chars: {id_only}", id_only.len());
        println!("addressed {} chars: {addressed}", addressed.len());
        assert!(
            id_only.len() <= addressed.len(),
            "the id-only code ({}) is longer than an addressed one ({}), so the \
             host chip would show less of it, not more",
            id_only.len(), addressed.len(),
        );
        // Fixed length is the property that matters: an id-only code is always
        // the same size, so the chip's truncation is predictable.
        let second = format_invite(&real_ticket());
        assert_eq!(id_only.len(), second.len(), "id-only codes vary in length");
    }

    #[test]
    fn the_invite_is_shorter_than_it_was() {
        // Dropping the tag is 8 characters plus a group dash off every code.
        let t = real_ticket();
        assert!(
            format_invite(&t).len() < t.len() + t.len() / 5 + 5,
            "the dressed invite should be shorter than the old dressed form",
        );
    }
}

#[cfg(test)]
mod transfer_tests {
    use super::*;

    #[test]
    fn offer_file_serializes_with_the_camel_case_kind_the_frontend_matches() {
        let msg = SessionMsg::OfferFile {
            from: "m0".into(),
            name: "Reel_04.mov".into(),
            size: 4_100_000_000.0,
            blake3: "ab".repeat(32),
            vcodec: Some("avc1.640028".into()),
            acodec: Some("mp4a.40.2".into()),
        };
        let line = serde_json::to_string(&msg).unwrap();
        assert!(line.contains("\"kind\":\"offerFile\""), "{line}");
        assert!(line.contains("\"blake3\""), "{line}");
        // Withdrawal shape: empty name is the sentinel the frontend clears on.
        let clear = SessionMsg::OfferFile {
            from: "m0".into(), name: String::new(), size: 0.0, blake3: String::new(),
            vcodec: None, acodec: None,
        };
        let line = serde_json::to_string(&clear).unwrap();
        assert!(line.contains("\"name\":\"\""), "{line}");
    }

    #[test]
    fn substream_requests_parse_and_unknown_types_are_refusable() {
        let ok: SubstreamReq =
            serde_json::from_str(r#"{"t":"file-request","blake3":"aa","offset":42}"#).unwrap();
        assert_eq!(ok.t, "file-request");
        assert_eq!(ok.offset, 42);
        // Offset defaults to 0 (fresh fetch sends none on resume-less paths).
        let fresh: SubstreamReq = serde_json::from_str(r#"{"t":"file-request","blake3":"aa"}"#).unwrap();
        assert_eq!(fresh.offset, 0);
        // A future stream type still parses (t is just a string), so the
        // handler can refuse it EXPLICITLY instead of erroring opaquely.
        let future: SubstreamReq = serde_json::from_str(r#"{"t":"media-request","blake3":""}"#).unwrap();
        assert_ne!(future.t, "file-request");
    }

    #[test]
    fn transfer_filenames_cannot_escape_the_transfers_dir() {
        assert_eq!(sanitize_transfer_filename("../../etc/passwd"), "etcpasswd");
        assert_eq!(sanitize_transfer_filename("a/b\\c:d.mov"), "abcd.mov");
        assert_eq!(sanitize_transfer_filename("  .hidden  "), "hidden");
        assert_eq!(sanitize_transfer_filename(""), "transfer");
    }

    /// The file body is the only read from a peer that is not length-prefixed,
    /// so the offered size is the only thing standing between a sender and the
    /// receiver's free space.
    #[test]
    fn transfer_stops_at_the_size_that_was_offered() {
        // Room for the whole chunk, and the exact final chunk, both fine.
        assert!(!transfer_would_overflow(0, 1024, 1024));
        assert!(!transfer_would_overflow(1000, 24, 1024));
        // One byte past the contract is refused, not trimmed: a sender that
        // disagrees about the size is one whose bytes cannot be trusted to
        // hash, and the BLAKE3 check only runs after everything is written.
        assert!(transfer_would_overflow(1000, 25, 1024));
        assert!(transfer_would_overflow(1024, 1, 1024));
        // A zero-byte offer accepts nothing.
        assert!(transfer_would_overflow(0, 1, 0));
        // Saturating: a wrapped sum must not come back under `total` and pass.
        assert!(transfer_would_overflow(u64::MAX, 4096, 1024));
        assert_eq!(sanitize_transfer_filename("\u{7}\u{8}"), "transfer");
        let long = "x".repeat(400);
        assert!(sanitize_transfer_filename(&long).len() <= 120);
    }
}

#[cfg(test)]
mod offer_hash_tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sb-hash-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(bytes).unwrap();
        f.sync_all().unwrap();
        p
    }

    /// The parallel path must produce byte-identical hashes to the serial
    /// reader it replaced - a guest verifies a transfer against this hex, so
    /// a divergence would refuse every completed download.
    #[test]
    fn parallel_hash_matches_the_serial_reader() {
        let p = temp_file("clip.bin", &vec![0xABu8; 3 * 1024 * 1024 + 17]);
        let mut serial = blake3::Hasher::new();
        serial.update_reader(std::fs::File::open(&p).unwrap()).unwrap();
        let fast = hash_file_parallel(&p).unwrap().finalize().to_hex().to_string();
        assert_eq!(fast, serial.finalize().to_hex().to_string());
    }

    #[test]
    fn empty_file_hashes_cleanly() {
        let p = temp_file("empty.bin", b"");
        let hex = hash_file_parallel(&p).unwrap().finalize().to_hex().to_string();
        assert_eq!(hex, blake3::Hasher::new().finalize().to_hex().to_string());
    }

    /// The memo returns the cached hex while (size, mtime) match, and drops
    /// it the moment the file is rewritten - which this app's atomic writers
    /// always surface as a new mtime.
    #[test]
    fn memo_hits_on_same_stat_and_misses_on_rewrite() {
        let p = temp_file("memo.bin", b"first contents");
        let meta = std::fs::metadata(&p).unwrap();
        let h1 = memoized_file_hash(&p, meta.len(), meta.modified().ok()).unwrap();
        let h2 = memoized_file_hash(&p, meta.len(), meta.modified().ok()).unwrap();
        assert_eq!(h1, h2);

        // Rewrite with different bytes AND a different length; stat changes.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&p, b"second, longer contents").unwrap();
        let meta2 = std::fs::metadata(&p).unwrap();
        let h3 = memoized_file_hash(&p, meta2.len(), meta2.modified().ok()).unwrap();
        assert_ne!(h1, h3, "a rewritten file served the stale hash");
        // And the new value verifies against a fresh direct hash.
        let direct = hash_file_parallel(&p).unwrap().finalize().to_hex().to_string();
        assert_eq!(h3, direct);
    }
}
