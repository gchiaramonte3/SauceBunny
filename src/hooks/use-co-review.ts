// useCoReview — the P2P co-review session (r100 transport, r101 live review)
// + theater mode, extracted whole from App.tsx following the use-panel-bus /
// use-web-playback shape: one cohesive subsystem out of the God-component,
// vanilla hooks, no state library. Same effects, same dependency arrays, same
// refs as the inline original — the cross-window events and Rust session
// commands (commands/session.rs) are untouched.
//
// Architecture: Rust owns the iroh endpoint as a dumb relay; the frontend is
// the review source-of-truth. Host: broadcasts source + a 2 Hz transport
// heartbeat + a review-doc snapshot on each join + its own comment ops.
// Peer: follows the host playhead, adopts the shared doc, and sends its own
// comment ops up (the host relays them to everyone). Sources: web URLs open
// directly on every machine; a LOCAL file ships its fingerprint (never its
// bytes or path), and each peer resolves its own copy via the fingerprint
// index or falls back to the "Open my copy" affordance.

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type Dispatch, type MutableRefObject, type RefObject, type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatError } from "../lib/error-format";
import { loadInstallId } from "../lib/identity";
import {
  newScreening, openSegment, closeSegment, noteComment, unnoteComment,
  screeningIsWorthKeeping, type ScreeningDoc,
} from "../lib/screening";
import { saveScreening } from "../lib/screening-store";
import { getLastUserSeekAt, getPlayheadFrames } from "../lib/playhead-store";
import { useStreamKeep } from "./use-stream-keep";
import { acceptTransport, createClockEstimator, expectedPosition } from "../lib/session-clock";
import {
  loadReview, saveReview, ensureVersion, applyReviewOp, attributeReviewOp, mergeReviewDoc,
  adoptSnapshot,
  resolveByFingerprint, linkFingerprint, sanitizeDocForWire,
  commentMarkers as reviewMarkersOf, annotationsOf,
  loadReviewer, reviewerColorFor, initialsOf,
  type AnnotationStrokes, type ReviewDoc, type ReviewOp,
} from "../lib/review";
import type { PlayerHandle } from "../components/player-handle";
import type { Participant } from "../components/PeoplePanel";
import type { ToastKind } from "../components/CanvasToast";
import { asLogTag, type LogTag, type Metadata } from "../types";
import type { SessionMsg } from "../bindings/SessionMsg";
import type { SessionState as CoSessionState } from "../bindings/SessionState";
import { useRtcMesh, type TurnConfig } from "./use-rtc-mesh";
import type { MeshPeerState } from "../lib/rtc-mesh";
import { ShareController, type ShareState } from "../lib/share-machine";
import { mixShareAudio, openShareStream } from "../lib/share-stream";
import { getSessionCapture } from "./use-media-capture";
import type { ShareSourceArg } from "../bindings/ShareSourceArg";

/** Timeline/monitor read-model of one review comment marker. Shared by the
 *  solo path (App's local-review reload effect) and the session path (the
 *  shared-doc projection below) — both write the same App-owned state. */
export type ReviewMarkerView = {
  id: string; time: number; timeEnd: number | null; resolved: boolean;
  color: string; initials: string;
  /** True for an unresolved note carried from an EARLIER version of the cut —
   *  rendered dimmed, so scrubbing the new cut shows where the old notes sit
   *  without them reading as this cut's own thread. */
  carried?: boolean;
};
/** Same read-model for drawn annotations (author-tinted). */
export type ReviewAnnotationView = {
  id: string; time: number; color: string; strokes: AnnotationStrokes;
};

/** The room's current source, described so a REMOTE peer can act on it.
 *  "web"  → the peer re-resolves `url` with its own yt-dlp (no media crosses
 *           the wire; each machine streams for itself)
 *  "file" → the peer looks for `fingerprint` on its own disk
 *  "none" → nothing loaded; peers unload
 *  `reviewKey` is the SHARED review-doc identity - never a local path. */
export type SessionSource = {
  kind: "web" | "file" | "none";
  url: string | null;
  fingerprint: string | null;
  title: string | null;
  duration: number | null;
  reviewKey: string;
};

type Args = {
  /** Live transport values — mirrored into refs for the interval senders.
   *  (The playhead is NOT passed: it lives in lib/playhead-store, and the
   *  heartbeat/presence/chase read getPlayheadFrames() when they fire — a
   *  render-mirrored ref would go stale now that playback ticks don't
   *  re-render App.) */
  isPlaying: boolean;
  fps: number;
  /** Host's playback rate - broadcast so guests can match speed. */
  playbackRate: number;
  /** What the room is watching, in a form a PEER can act on (r124).
   *  Replaces the old web-only activeSourceUrl gate: a local file has no URL,
   *  which is exactly why loading one used to broadcast nothing at all and
   *  leave the guest staring at the empty state. */
  sessionSource: SessionSource;
  /** Synchronous mirror of the above (set mid-fetch) — the loadSource echo guard. */
  activeSourceUrlRef: MutableRefObject<string | null>;
  /** Review storage key of the current source — the host seeds the shared doc from it. */
  reviewSourceKey: string | null;
  playerRef: RefObject<PlayerHandle>;
  /** For the shared doc's version title — read at seed time so it's never stale. */
  metadataRef: MutableRefObject<Metadata | null>;
  /** Chase correction seek. Deliberately NOT App's onSeek: it must not
   *  arm the user-seek latch (review fix: the chase arming its own latch
   *  let two quick host scrubs strand a paused guest). */
  onChaseSeek: (frames: number) => void;
  setUrl: (url: string) => void;
  handleFetch: (url: string) => Promise<void>;
  /** Open a file from THIS Mac's disk. Used by the fingerprint ladder when a
   *  guest turns out to already have the presenter's file. */
  loadLocalPath: (path: string) => Promise<unknown>;
  /** Tier B: mount the host's offered file as a LIVE stream (App drives its
   *  source machine; the hook owns session bookkeeping around it). */
  loadPeerStream: (offer: { name: string; blake3: string; vcodec: string | null; acodec: string | null },
    pending: { title: string | null; duration: number | null }) => Promise<void>;
  pushNotification: (kind: ToastKind, title: string, body: string) => void;
  /** The pipeline log, which the diagnostics export reads. Co-review is the
   *  one subsystem that inherently needs two machines to reproduce, and it
   *  used to write NOTHING here - a failed session left no artifact on either
   *  Mac saying which side broke. Everything that changes what the room
   *  believes gets a line. */
  appendLog: (tag: LogTag, channel: string, line: string) => void;
  /** Theater auto-enter also opens the drawer (comments live there). */
  setQueueOpen: (open: boolean) => void;
  /** Session projection sinks — while in a session the shared doc drives the
   *  same marker state App's solo reload writes, so every participant's
   *  timeline shows everyone's live comments. */
  setReviewMarkers: (markers: ReviewMarkerView[]) => void;
  setReviewAnnotations: (annotations: ReviewAnnotationView[]) => void;
  /** Optional TURN relay for the webcam mesh (Settings; empty = STUN only). */
  turn: TurnConfig;
  /** STUN server for the webcam mesh (Settings; empty contacts nobody). */
  stunUrl: string;
};

/** One transient on-screen reaction (floater + tile badge, ~5s). */
export type LiveReaction = {
  id: number;
  /** Member id of the sender (m0 = host). */
  from: string;
  /** Sender's display name, snapshotted at fire time so a floater keeps
   *  the right name even if that peer leaves during its ~5s life. */
  name: string;
  /** applause | confetti | thumbsup | question */
  emote: string;
  at: number;
};

/** One `session:transfer` progress event (either direction, r143). */
export type TransferProgress = {
  phase: "hashing" | "checking" | "receiving" | "sending" | "sent"
    | "sendStopped" | "cancelled" | "stalled" | "failed" | "done";
  name: string;
  received: number;
  total: number;
  /** Present on host-side "sending" events: which member is receiving. */
  member?: string;
  /** Present on "done": the final local path of the received file. */
  path?: string;
};

export type CoReview = {
  /** Session state pushed from Rust over `session:state`. */
  coSession: CoSessionState;
  /** True while hosting or joined (role !== "off"). */
  coSessionActive: boolean;
  /** The shared review doc while in a session (null = solo). The Review panel +
   *  timeline markers read THIS instead of the local-by-sourceKey doc. */
  sessionDoc: ReviewDoc | null;
  /** Apply a review op to the shared doc + relay it (called by the Review
   *  panel for every mutation while in session). */
  postSessionOp: (op: ReviewOp) => void;
  /** Peer playheads in frames, tinted per name — the timeline ghost cursors. */
  coGhostMarkers: { name: string; frame: number; color: string }[];
  theater: boolean;
  setTheater: Dispatch<SetStateAction<boolean>>;
  theaterParticipants: Participant[];
  /** Live remote camera/mic streams from the webcam mesh, keyed by member id. */
  meshStreams: ReadonlyMap<string, MediaStream>;
  /** Per-member mesh connection state (connecting / live / failed). */
  meshStates: ReadonlyMap<string, MeshPeerState>;
  /** Peers YOU muted locally (tile "Mute for me"); never signalled to them. */
  meshMutedForMe: ReadonlySet<string>;
  toggleMuteForMe: (memberId: string, muted: boolean) => void;
  /** Screen share (native ffmpeg pipeline; v1 replaces your camera tile). */
  shareState: ShareState;
  shareStream: MediaStream | null;
  /** Member ids currently flagged as sharing (tile badges). */
  sharingMembers: ReadonlySet<string>;
  startShare: (source: ShareSourceArg) => void;
  stopShare: () => void;
  /** Transient reactions currently on screen (auto-pruned after ~5s). */
  liveReactions: LiveReaction[];
  /** Member ids with a raised hand (persistent until lowered). */
  raisedHands: ReadonlySet<string>;
  /** True when WE drive source + transport (the host, until the floor moves). */
  isPresenter: boolean;
  /** The presenter's source when we can't show it yet (null = nothing pending).
   *  A "file" kind here means the bytes live on the presenter's machine. */
  pendingSource: SessionSource | null;
  /** member id → "loading" | "ready" | "failed" | "missing" for the current source. */
  sourceStatus: ReadonlyMap<string, string>;
  /** Host only: hand the presenter floor to another member. */
  makePresenter: (memberId: string) => void;
  /** Point at YOUR copy of the presenter's local file (fingerprint ladder). */
  adoptPendingSource: () => Promise<void>;
  /** Tier C/B: the host's standing file offer (guests render Get / Watch). */
  offeredFile: { name: string; size: number; blake3: string; vcodec: string | null; acodec: string | null } | null;
  /** Live transfer progress on this machine, either direction. */
  transfer: TransferProgress | null;
  offerCurrentFile: (path: string, name?: string, vcodec?: string | null, acodec?: string | null) => Promise<void>;
  /** Why the last offer failed, for the host to see. Null once it succeeds. */
  offerError: string | null;
  clearOfferError: () => void;
  /** S.5: one quiet line about the copy running under a live stream, or null. */
  keepBadge: string | null;
  /** What the chip does when clicked, or null when it is only a label. */
  keepAction: { kind: "cancel" | "resume"; title: string } | null;
  onKeepCancel: () => void;
  onKeepResume: () => void;
  /** Whether watching also saves a copy on this Mac (Settings, per machine). */
  keepEnabled: boolean;
  setKeepEnabled: (on: boolean) => void;
  /** Forward the player's stall to the keep policy, so a background copy gets
   *  out of the way rather than starving the picture it is riding under. */
  onKeepStall: () => void;
  /** Forward what the presenter served; only `relayed` matters to the copy. */
  onKeepStreamInfo: (info: { rung: number | null; relayed: boolean }) => void;
  fetchOfferedFile: () => Promise<void>;
  watchOfferedStream: () => Promise<void>;
  cancelFetch: () => void;
  /** True when YOUR hand is up. */
  handRaised: boolean;
  /** Fire a transient reaction (throttled; echoes locally). */
  sendReaction: (emote: string) => void;
  /** Raise/lower your hand (persistent state, relayed). */
  toggleHand: () => void;
  startCoReview: (title?: string) => Promise<void>;
  joinCoReview: (ticket: string, name: string) => Promise<void>;
  leaveCoReview: () => void;
};

export function useCoReview({
  isPlaying, fps, playbackRate,
  sessionSource, activeSourceUrlRef, reviewSourceKey,
  playerRef, metadataRef,
  onChaseSeek, setUrl, handleFetch, loadLocalPath, loadPeerStream,
  pushNotification, setQueueOpen,
  setReviewMarkers, setReviewAnnotations,
  turn, stunUrl, appendLog,
}: Args): CoReview {
  // Every long-lived listener here is registered ONCE, so it must reach the
  // log through a ref or it captures the first render's closure forever.
  const appendLogRef = useRef(appendLog);
  appendLogRef.current = appendLog;
  /** One line in the pipeline log, on the "session" channel. */
  const slog = useCallback((tag: LogTag, line: string) => {
    appendLogRef.current(tag, "session", line);
  }, []);
  const [coSession, setCoSession] = useState<CoSessionState>({ role: "off", code: null, peers: [], selfId: null, title: null, error: null, presenter: "m0", presenterEpoch: 0 });
  // Live reactions: fire-and-forget, never persisted, pruned after ~5s
  // (the Zoom/Meet grammar - late joiners never see past reactions).
  const [liveReactions, setLiveReactions] = useState<LiveReaction[]>([]);
  const [raisedHands, setRaisedHands] = useState<ReadonlySet<string>>(new Set());
  const reactionIdRef = useRef(0);
  const lastReactionSendRef = useRef(0);
  const coSessionRef = useRef(coSession);
  coSessionRef.current = coSession;
  const nameForMember = useCallback((memberId: string): string => {
    const s = coSessionRef.current;
    if (memberId === s.selfId) return loadReviewer().name || "You";
    return s.peers.find((p) => p.id === memberId)?.name ?? "Someone";
  }, []);
  // Incoming SessionMsg::Rtc -> the mesh (assigned each render below; the
  // mesh hook must be declared after the message handler's closure).
  const rtcSignalRef = useRef<((from: string, payload: string) => void) | null>(null);
  const [sharingMembers, setSharingMembers] = useState<ReadonlySet<string>>(new Set());
  const [shareState, setShareState] = useState<ShareState>("idle");
  const [shareStream, setShareStream] = useState<MediaStream | null>(null);
  const coSessionActive = coSession.role !== "off";
  // The shared review doc while in a session (null = solo).
  const [sessionDoc, setSessionDoc] = useState<ReviewDoc | null>(null);
  const sessionDocRef = useRef<ReviewDoc | null>(null); sessionDocRef.current = sessionDoc;
  // Live peer playheads → ghost cursors on the timeline (excludes self; the
  // relay never echoes your own presence back).
  const [coGhosts, setCoGhosts] = useState<{ name: string; position: number; at: number }[]>([]);
  const coSeqRef = useRef(0);
  const coPlayingRef = useRef(false); coPlayingRef.current = isPlaying;
  const coFpsRef = useRef(30); coFpsRef.current = fps;
  const coRateRef = useRef(1); coRateRef.current = playbackRate;
  const coRoleRef = useRef("off"); coRoleRef.current = coSession.role;
  const coLastHostPosRef = useRef<number | null>(null);
  /** Cross-machine clock offset estimator (see lib/session-clock.ts). */
  const coClockRef = useRef(createClockEstimator());
  /** Last (epoch, seq) applied, so stale/duplicate heartbeats are ignored. */
  const coLastSeqRef = useRef({ epoch: -1, seq: -1 });
  /** When we last issued a chase seek — feeds decideChase's cooldown. */
  const coLastChaseAtRef = useRef(0);
  const coReadyRef = useRef(false); // has OUR player loaded the host's source yet?
  /** Latest persistDoc, so the message handler (registered once) can flush an
   *  outgoing doc without capturing a stale closure. */
  const persistDocRef = useRef<(d: ReviewDoc | null) => void>(() => {});
  /** The screening being recorded: which sources this room watched, in order,
   *  and which comments were made against each. Holds no comment bodies -
   *  those live in the per-source review docs (see lib/screening.ts). */
  const screeningRef = useRef<ScreeningDoc | null>(null);
  /** Latest recordOpInScreening, for the once-registered message handler. */
  const recordOpRef = useRef<(op: ReviewOp) => void>(() => {});
  // Am I the one driving source + transport? Defaults to the host until a
  // Presenter line says otherwise. The network star never moves; only this
  // permission does (see SessionMsg::Presenter).
  const isPresenter = coSessionActive
    && (coSession.presenter || "m0") === (coSession.selfId ?? (coSession.role === "host" ? "m0" : ""));
  const isPresenterRef = useRef(false);
  // Taking the floor restarts our seq at 0. Receivers order across a handover
  // by the host-stamped epoch, which bumps at the same moment - without the
  // reset our first messages would look stale to anyone whose seq is higher.
  if (isPresenter && !isPresenterRef.current) coSeqRef.current = 0;
  isPresenterRef.current = isPresenter;
  // The presenter's source when WE can't show it yet (a file we don't have,
  // or a web source still resolving). Drives the room's waiting affordance.
  const [pendingSource, setPendingSource] = useState<SessionSource | null>(null);
  // Who has reported they can/can't open the current source.
  const [sourceStatus, setSourceStatus] = useState<ReadonlyMap<string, string>>(new Map());
  // Tier C: the host's standing offer of the current source's file, and the
  // live transfer this machine is running (either direction). The offer is
  // room-truth (rides the wire); the transfer is local progress.
  // Why the last offer failed, for the host to actually SEE. It used to go to
  // the pipeline log only, so a host clicked Offer, nothing appeared, and the
  // guests kept reading "That file lives on their Mac" indefinitely with no
  // one able to tell why.
  const [offerError, setOfferError] = useState<string | null>(null);
  const [offeredFile, setOfferedFile] = useState<{
    name: string; size: number; blake3: string;
    vcodec: string | null; acodec: string | null;
  } | null>(null);
  const offeredFileRef = useRef(offeredFile);
  offeredFileRef.current = offeredFile;
  // Read inside the handoff callback, which must see the target as it is at
  // completion rather than as it was when the callback was created.
  const keepTargetRef = useRef<{ blake3: string; name: string; total: number; fingerprint: string | null } | null>(null);
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);

  // Send a session message the right way for our role: the host broadcasts to
  // all peers; a peer sends up to the host, which relays it to everyone else.
  const sendSessionMsg = useCallback((msg: SessionMsg) => {
    const cmd = coRoleRef.current === "host" ? "session_broadcast" : "session_send";
    void invoke(cmd, { msg }).catch(() => {});
  }, []);

  // Apply a review op to the shared doc + relay it (called by the Review panel
  // for every mutation while in session). Optimistic: apply locally now and
  // send; the host relays to all-but-sender so we never receive our own op back.
  /** Attribute a comment to the segment the room was watching when it was
   *  made, so a screening can later say "these three notes were about Cut A".
   *  Ids only - the bodies stay in the source's own review doc. */
  const recordOpInScreening = useCallback((op: ReviewOp) => {
    const sc = screeningRef.current;
    if (!sc) return;
    // Only ROOT comments anchor to a segment; a reply belongs to its parent.
    if (op.t === "add" && !op.comment.parentId) {
      screeningRef.current = noteComment(sc, op.comment.id);
    } else if (op.t === "del") {
      screeningRef.current = unnoteComment(sc, op.id);
    }
  }, []);

  recordOpRef.current = recordOpInScreening;

  /** Ops posted before the host's first reviewDoc snapshot lands. They are
   *  still SENT (the room applies them); without this buffer they simply
   *  vanished from the author's own screen until the next full snapshot.
   *  Replayed once on adoption — applyReviewOp is id-idempotent (insertComment
   *  dedups, edits/resolves are LWW), so an op the snapshot already contains
   *  is a no-op. */
  const pendingOpsRef = useRef<ReviewOp[]>([]);

  const postSessionOp = useCallback((op: ReviewOp) => {
    if (!sessionDocRef.current) pendingOpsRef.current.push(op);
    else setSessionDoc((prev) => (prev ? applyReviewOp(prev, op) : prev));
    recordOpInScreening(op);
    // `from` is stamped by the HOST on relay; whatever we put here is
    // overwritten, so send it empty rather than asserting an identity.
    sendSessionMsg({ kind: "reviewOp", op: JSON.stringify(op), from: "" });
  }, [sendSessionMsg, recordOpInScreening]);

  // Latest-closure ref so the once-registered session:msg listener never stales.
  const coApplyRef = useRef<(m: SessionMsg) => void>(() => {});
  coApplyRef.current = (m) => {
    switch (m.kind) {
      case "loadSource": {
        // The presenter changed what the room is watching. We are not synced
        // to it until OUR player reports ready for the NEW source - re-arm so
        // a stale-ready old player can't apply transport to the wrong video.
        if (m.sourceKind === "none") {
          slog("info", "Presenter cleared the source.");
          coReadyRef.current = false;
          setPendingSource(null);
          setSourceStatus(new Map());
          setOfferedFile(null); // the offer was for the outgoing source
          setKeepTarget(null); // and so was any copy running underneath it
          return;
        }
        slog("info",
          `LoadSource in: kind=${m.sourceKind} title=${JSON.stringify(m.title ?? "")} `
          + `reviewKey=${m.reviewKey} fingerprint=${m.fingerprint ?? "none"} url=${m.url ?? "none"}`);
        const src: SessionSource = {
          kind: m.sourceKind === "file" ? "file" : "web",
          url: m.url, fingerprint: m.fingerprint, title: m.title,
          duration: m.duration, reviewKey: m.reviewKey,
        };
        setSourceStatus(new Map());
        setOfferedFile(null); // a new source invalidates the old offer
        setKeepTarget(null); // and the copy running underneath the old one
        if (src.kind === "web" && m.url) {
          if (activeSourceUrlRef.current === m.url) {
            slog("info", "Already on that URL; ignoring.");
            return;
          }
          coReadyRef.current = false;
          setPendingSource(src);
          sendSessionMsg({ kind: "sourceStatus", from: "", state: "loading", detail: null });
          setUrl(m.url);
          void handleFetch(m.url)
            .then(() => { slog("ok", "Opened the presenter's web source."); setPendingSource(null); })
            .catch((err) => {
              // Clear the pending state too, or the guest renders "Loading…"
              // forever with no error and no retry.
              slog("err", `Could not open the presenter's source: ${formatError(err)}`);
              setPendingSource(null);
              sendSessionMsg({ kind: "sourceStatus", from: "", state: "failed", detail: null });
            });
          return;
        }
        // A local file. The bytes live on the presenter's disk and never cross
        // the wire, so the fingerprint is the question "do YOU have this same
        // content?". Tier 1 of the ladder: if we've reviewed this exact
        // content before, we know where our own copy is - open it, zero bytes
        // transferred. That's the whole point of shipping an identity rather
        // than a host-local path.
        coReadyRef.current = false;
        setPendingSource(src);
        const mine = src.fingerprint ? resolveByFingerprint(src.fingerprint) : null;
        if (mine) {
          sendSessionMsg({ kind: "sourceStatus", from: "", state: "loading", detail: null });
          void loadLocalPath(mine)
            .then(() => {
              setPendingSource(null);
              sendSessionMsg({ kind: "sourceStatus", from: "", state: "ready", detail: null });
            })
            .catch(() => {
              // Indexed but gone (moved, renamed, external drive unplugged).
              sendSessionMsg({ kind: "sourceStatus", from: "", state: "missing", detail: null });
            });
          return;
        }
        // Tier 3: we don't have it. Say so plainly; the room affordance offers
        // "Open my copy", which links the fingerprint so tier 1 hits next time.
        sendSessionMsg({ kind: "sourceStatus", from: "", state: "missing", detail: null });
        return;
      }
      case "sourceStatus":
        setSourceStatus((prev) => new Map(prev).set(m.from, m.state));
        return;
      case "offerFile":
        // Tier C/B: the host's offer (empty name withdraws it). Host-
        // originated only; the Rust relay never forwards a peer's version.
        setOfferedFile(m.name ? {
          name: m.name, size: m.size, blake3: m.blake3,
          vcodec: m.vcodec ?? null, acodec: m.acodec ?? null,
        } : null);
        return;
      case "presenter":
        // Rust already updated its own gate; mirror it so the UI can badge
        // the presenter without waiting for the next session:state.
        setCoSession((prev) => ({ ...prev, presenter: m.member }));
        return;
      case "reviewDoc":
        // MERGE, not blind-replace: the host re-broadcasts a full snapshot on
        // every join, and an existing peer may have an in-flight op not yet in
        // that snapshot — mergeReviewDoc keeps it (and unions likes) so no
        // comment/edit silently vanishes.
        //
        // When the snapshot describes a DIFFERENT source (the presenter
        // switched), our current doc belongs to the outgoing source: flush it
        // to its own file BEFORE adopting, or those notes die with the swap.
        // mergeReviewDoc refuses to fold across sourceKeys, so adopting is
        // then a clean replace rather than a silent contamination.
        try {
          const incoming = JSON.parse(m.doc) as ReviewDoc;
          // Both side effects happen HERE, once, not inside the updater.
          // StrictMode double-invokes updaters in development, and this one
          // used to write to disk and empty pendingOpsRef as it computed: the
          // second invocation then found the queue drained and returned a doc
          // without the replayed ops, which is the result React keeps. The
          // author's own pre-snapshot comments disappeared - the very thing
          // the replay exists to prevent.
          const prev = sessionDocRef.current;
          if (prev && prev.sourceKey !== incoming.sourceKey) persistDocRef.current(prev);
          // First adoption replays anything the author posted while the doc
          // was still null, so their own comments reappear.
          const replay = prev ? [] : pendingOpsRef.current;
          if (replay.length) pendingOpsRef.current = [];
          setSessionDoc((cur) => adoptSnapshot(cur, incoming, replay));
        } catch { /* malformed snapshot */ }
        return;
      case "reviewOp":
        try {
          // Attribute by the HOST-STAMPED sender id, never by what the
          // payload claims: the op names its own author, and the relay is
          // payload-agnostic, so trusting it let any peer sign review
          // content (including the source verdict) as somebody else.
          const op = attributeReviewOp(JSON.parse(m.op) as ReviewOp, nameForMember(m.from));
          setSessionDoc((prev) => (prev ? applyReviewOp(prev, op) : prev));
          // Everyone's notes belong to the screening, not just ours.
          recordOpRef.current(op);
        } catch { /* malformed op */ }
        return;
      case "reaction": {
        if (m.emote === "hand") {
          setRaisedHands((prev) => {
            const next = new Set(prev);
            if (m.on) next.add(m.from); else next.delete(m.from);
            return next;
          });
        } else if (m.on) {
          const r: LiveReaction = { id: ++reactionIdRef.current, from: m.from, name: nameForMember(m.from), emote: m.emote, at: Date.now() };
          setLiveReactions((prev) => [...prev.slice(-23), r]);
          window.setTimeout(() => {
            setLiveReactions((prev) => prev.filter((x) => x.id !== r.id));
          }, 5200);
        }
        return;
      }
      case "rtc":
        rtcSignalRef.current?.(m.from, m.payload);
        return;
      case "sharing":
        setSharingMembers((prev) => {
          const next = new Set(prev);
          if (m.on) next.add(m.from); else next.delete(m.from);
          return next;
        });
        return;
      case "presence": {
        const now = Date.now();
        setCoGhosts((prev) => [
          ...prev.filter((g) => g.name !== m.name && now - g.at < 5000),
          { name: m.name, position: m.position, at: now },
        ]);
        return;
      }
      case "transport": {
        const p = playerRef.current;
        // Session-first: hold the playhead chase until OUR player has actually
        // loaded the source — sync activates once both sides have the video.
        if (!p || !p.isReady()) { coReadyRef.current = false; return; }
        // First tick after our source finished loading — snap to the host even
        // when paused, so a late-loading guest lands on the shared frame.
        const justLoaded = !coReadyRef.current;
        coReadyRef.current = true;
        // Drop a heartbeat from a SUPERSEDED presenter, and any that arrives
        // out of order within the current epoch. Without this, a stale line
        // in flight during a floor handover yanks everyone backwards. The
        // rule lives in session-clock.ts (acceptTransport) so the handover
        // ordering is unit-tested against the frozen-guest scenario.
        const verdict = acceptTransport(coLastSeqRef.current, m, justLoaded);
        if (!verdict.accept) return;
        if (verdict.newEpoch) coClockRef.current.reset(); // new sender, new clock
        coLastSeqRef.current = { epoch: m.epoch, seq: m.seq };

        const now = Date.now();
        coClockRef.current.sample(m.atMs, now);
        const r = Math.max(1, Math.round(coFpsRef.current));
        // Translate the presenter's wall clock into ours before extrapolating.
        // Differencing raw Date.now() across two Macs made an ordinary clock
        // offset look like permanent drift and re-seeked every heartbeat.
        const expected = expectedPosition(m, now, coClockRef.current.offsetMs());
        const cur = getPlayheadFrames() / r;
        const hostScrubbed = coLastHostPosRef.current === null || Math.abs(m.position - coLastHostPosRef.current) > 0.25;
        // RC3 latch: a local seek in the last ~1.2s owns the playhead — the
        // chase yields so a guest can click a transcript cue without being
        // yanked back on the next heartbeat. decideChase (pure, unit-tested)
        // owns the branch logic; crucially a YIELDED heartbeat does NOT
        // commit the host position as seen (review fix: consuming the scrub
        // edge while yielding left a paused guest stranded forever).
        const localSeekHot = Date.now() - getLastUserSeekAt() < 1200;
        const decision = decideChase({
          justLoaded, localSeekHot, playing: m.playing,
          curSeconds: cur, expectedSeconds: expected, hostScrubbed,
          sinceLastChaseMs: now - coLastChaseAtRef.current,
        });
        if (decision.commitHostPos) {
          coLastHostPosRef.current = m.position;
        } else if (import.meta.env.DEV && Math.abs(cur - expected) > 0.5) {
          console.info("[co-review] chase yielded to a local seek", { cur, expected });
        }
        // Everything below APPLIES the presenter's state to our player. No
        // echo guard is needed: nothing broadcasts on a play-state CHANGE.
        // The only transport sender is the presenter's 2 Hz interval, gated
        // on isPresenter, and applying remote state never makes us the
        // presenter. (A write-only "applyingRemote" flag used to claim this
        // job; it was never read anywhere and is gone.)
        if (decision.seekSeconds != null) {
          coLastChaseAtRef.current = now;
          onChaseSeek(Math.floor(decision.seekSeconds * r));
        }
        // Rate was broadcast but never applied - a guest sat at 1x while the
        // presenter ran at 1.5x and got seek-corrected once a second instead.
        // MediaBunnyPlayer decodes at 1x by design, hence the capability gate.
        if (p.supportsPlaybackRate && Math.abs((m.rate || 1) - coRateRef.current) > 0.01) {
          p.setPlaybackRate(m.rate || 1);
        }
        if (m.playing !== coPlayingRef.current) {
          if (m.playing) p.play(); else p.pause();
        }
        return;
      }
    }
  };
  useEffect(() => {
    const unState = listen<CoSessionState>("session:state", (e) => {
      // Diff against what we believed BEFORE adopting it: the roster and the
      // floor are the two things whose disagreement across machines produces
      // "it looks connected and does nothing", and a diff is what tells you
      // which Mac's picture is wrong.
      const prev = coSessionRef.current;
      const next = e.payload;
      if (prev.role !== next.role) slog("info", `Role: ${prev.role} -> ${next.role}`);
      if (prev.selfId !== next.selfId) slog("info", `Self id: ${next.selfId ?? "none"}`);
      const before = new Map(prev.peers.map((p) => [p.id, p]));
      const after = new Map(next.peers.map((p) => [p.id, p]));
      for (const [id, p] of after) {
        const was = before.get(id);
        if (!was) slog("ok", `Peer joined: ${id} "${p.name}" epoch=${p.epoch ?? 0}`);
        else if ((was.epoch ?? 0) !== (p.epoch ?? 0)) {
          slog("info", `Peer reconnected: ${id} "${p.name}" epoch ${was.epoch ?? 0} -> ${p.epoch ?? 0}`);
        }
      }
      for (const [id, p] of before) {
        if (!after.has(id)) slog("info", `Peer left: ${id} "${p.name}"`);
      }
      if (prev.presenter !== next.presenter || prev.presenterEpoch !== next.presenterEpoch) {
        slog("info", `Floor: ${next.presenter} (epoch ${next.presenterEpoch})`);
      }
      if (next.error && next.error !== prev.error) slog("err", `Session error: ${next.error}`);
      setCoSession(next);
    });
    const unMsg = listen<SessionMsg>("session:msg", (e) => coApplyRef.current(e.payload));
    const unLog = listen<{ tag: string; line: string }>("session:log", (e) => {
      appendLogRef.current(asLogTag(e.payload.tag), "session", e.payload.line);
    });
    return () => { unState.then((f) => f()); unMsg.then((f) => f()); unLog.then((f) => f()); };
  }, [slog]);
  /** Write a doc back to ITS OWN source's file. The sourceKey on the doc is
   *  the authority - never the key of whatever source is on screen now. */
  const persistDoc = useCallback((d: ReviewDoc | null) => {
    // Persist whenever a doc exists - zero comments may MEAN "we deleted them
    // all", and skipping the save would resurrect them next session. MERGE
    // into any solo review the user already had (a guest must not lose their
    // own notes to the host-seeded doc); mergeReviewDoc refuses to fold
    // across differing sourceKeys.
    if (d && d.sourceKey) saveReview(mergeReviewDoc(loadReview(d.sourceKey), d));
  }, []);
  persistDocRef.current = persistDoc;

  // WRITE THROUGH AS THE ROOM TYPES. Session comments used to reach disk only
  // at session end (or a source change), so every note from a live review was
  // held in React state and nowhere else: quit the app, lose the renderer, or
  // just close the window without pressing End, and the whole session's notes
  // were gone on every machine at once - there is no close hook on the main
  // window to catch it. Solo editing has always persisted per-op; this makes a
  // session no more fragile than working alone. saveReview is debounced 500ms
  // with a pagehide flush, so this costs one merge per op, not one file write.
  useEffect(() => {
    if (sessionDoc) persistDoc(sessionDoc);
  }, [sessionDoc, persistDoc]);

  // The shared doc FOLLOWS the source. Seeding used to be gated on the role
  // transition (`role === "host" && prev !== "host"`), so it ran once when the
  // session started and never again - change source mid-session and the doc
  // kept the OLD sourceKey, so new comments filed against the previous source
  // and were written into ITS file on session end. That is the "loading a new
  // source wipes my comments" report: they were not lost so much as misfiled.
  const prevCoRoleRef = useRef("off");
  const prevDocKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevCoRoleRef.current;
    prevCoRoleRef.current = coSession.role;

    if (coSession.role === "off" && prev !== "off") {
      persistDoc(sessionDocRef.current);
      // Close the running segment and keep the screening - unless nothing was
      // ever watched and nobody else showed up, which is not a memory worth
      // cluttering the library with.
      const sc = screeningRef.current;
      if (sc) {
        const finished = closeSegment(sc);
        if (screeningIsWorthKeeping(finished)) void saveScreening(finished);
        screeningRef.current = null;
      }
      prevDocKeyRef.current = null;
      setSessionDoc(null);
      setCoGhosts([]);
      setLiveReactions([]);
      setRaisedHands(new Set());
      // Source state is per-session too. Left behind, the "waiting for the
      // host" overlay is an opaque full-bleed panel that reappears the moment
      // anyone joins the NEXT session, and member ids restart at 1 each
      // session, so a stale entry also reports the wrong person as unable to
      // open the file. Neither self-heals: the host never receives its own
      // broadcast, and the rebroadcast is gated on a source being set.
      setPendingSource(null);
      setSourceStatus(new Map());
      setOfferedFile(null);
      setTransfer(null);
      pendingOpsRef.current = [];
      coLastHostPosRef.current = null;
      coReadyRef.current = false;
      return;
    }
    if (coSession.role !== "host" || !reviewSourceKey) return;
    if (prevDocKeyRef.current === reviewSourceKey) return; // same source, nothing to do

    // CLOSE the outgoing source first: its comments belong to ITS file, and
    // they must be on disk before we point the room at anything else.
    const outgoing = sessionDocRef.current;
    if (outgoing && outgoing.sourceKey !== reviewSourceKey) persistDoc(outgoing);

    const { doc } = ensureVersion(
      loadReview(reviewSourceKey), reviewSourceKey, metadataRef.current?.title ?? undefined,
    );
    prevDocKeyRef.current = reviewSourceKey;
    setSessionDoc(doc);

    // Record what the room is watching. The screening starts on the first
    // source rather than at session start, so a room that never loads
    // anything leaves nothing behind.
    if (!screeningRef.current) {
      // Read the code and title off the ref, not the render closure: they are
      // used ONCE, to name a screening at creation, and depending on them
      // would re-run this whole source-follow effect the moment a title
      // arrived - closing and reopening a segment for no reason.
      const s = coSessionRef.current;
      screeningRef.current = newScreening(
        s.code ?? `local-${Date.now()}`,
        s.title || metadataRef.current?.title || "Screening",
        "host",
      );
    }
    screeningRef.current = openSegment(
      screeningRef.current, sessionSourceRef.current, reviewSourceKey,
    );
    // Guests are still holding the OUTGOING doc, so push the new one now.
    // Previously the snapshot only went out when a peer joined, which meant a
    // mid-session source change left every guest editing the old source.
    void invoke("session_broadcast", {
      // Wire boundary: local filesystem identity stays on this machine — the
      // doc travels keyed by the session fingerprint with version paths
      // stripped (see sanitizeDocForWire). sessionDoc keeps the REAL doc.
      msg: { kind: "reviewDoc", doc: JSON.stringify(sanitizeDocForWire(doc, sessionSourceRef.current.reviewKey || null)) },
    }).catch(() => { /* session raced closed */ });
  }, [coSession.role, reviewSourceKey, persistDoc, metadataRef]);
  // Presenter → everyone: the current source whenever it changes. r124: this
  // fires for LOCAL FILES and for clearing too. It used to early-return unless
  // a web URL existed, which is why loading a local file broadcast nothing and
  // the guest sat on the empty state with no timeline.
  const sessionSourceRef = useRef(sessionSource);
  sessionSourceRef.current = sessionSource;
  const sendLoadSource = useCallback((src: SessionSource) => {
    // A source change invalidates any standing Tier C offer: the offered
    // bytes belong to the OUTGOING source. Withdraw before announcing.
    if (offeredFileRef.current && coRoleRef.current === "host") {
      setOfferedFile(null);
      void invoke("session_clear_offer").catch(() => {});
    }
    sendSessionMsg({
      kind: "loadSource",
      from: "",                 // host stamps the true sender
      sourceKind: src.kind,
      url: src.url,
      fingerprint: src.fingerprint,
      title: src.title,
      duration: src.duration,
      reviewKey: src.reviewKey,
    });
  }, [sendSessionMsg]);
  useEffect(() => {
    if (!isPresenter) return;
    // Read through the ref, which render keeps current. Depending on the
    // OBJECT would re-broadcast every tick (App's memo makes a fresh one each
    // render); depending on its FIELDS is what we actually want, and reading
    // the ref here makes that honest instead of suppressed.
    //
    // The suppression this replaces sat on the array's second line while the
    // warning is reported on its first, so it had never suppressed anything -
    // it just looked like a decision had been made.
    sendLoadSource(sessionSourceRef.current);
  }, [isPresenter, sessionSource.kind, sessionSource.url, sessionSource.fingerprint,
      sessionSource.reviewKey, sendLoadSource]);
  // Host → new joiner: source + a fresh doc snapshot when the peer count rises.
  // Fanned to all; existing peers harmlessly re-adopt the identical doc.
  const prevPeerCountRef = useRef(0);
  useEffect(() => {
    const prev = prevPeerCountRef.current;
    prevPeerCountRef.current = coSession.peers.length;
    if (coSession.role !== "host" || coSession.peers.length <= prev) return;
    if (sessionSourceRef.current.kind !== "none") {
      sendLoadSource(sessionSourceRef.current);
    }
    const d = sessionDocRef.current;
    if (d) {
      // Same wire-boundary sanitization as the source-follow broadcast above.
      const wired = sanitizeDocForWire(d, sessionSourceRef.current.reviewKey || null);
      void invoke("session_broadcast", { msg: { kind: "reviewDoc", doc: JSON.stringify(wired) } }).catch(() => {});
    }
    // A standing Tier C/B offer is room-truth too: without this a late
    // joiner never sees the Get/Watch chips.
    const offer = offeredFileRef.current;
    if (offer) {
      void invoke("session_broadcast", { msg: {
        kind: "offerFile", from: "m0", name: offer.name, size: offer.size,
        blake3: offer.blake3, vcodec: offer.vcodec, acodec: offer.acodec,
      } }).catch(() => {});
    }
    // Re-broadcast persistent presence so a newcomer converges on the live
    // room: the host's own hand + share, and every currently-raised hand.
    const selfId = coSessionRef.current.selfId ?? "m0";
    if (raisedHands.has(selfId)) {
      void invoke("session_broadcast", { msg: { kind: "reaction", from: selfId, emote: "hand", on: true } }).catch(() => {});
    }
    if (shareState === "sharing") {
      void invoke("session_broadcast", { msg: { kind: "sharing", from: selfId, on: true } }).catch(() => {});
    }
  }, [coSession.role, coSession.peers.length, raisedHands, shareState, sendLoadSource]);
  // Host → peers: 2 Hz transport heartbeat (play/pause/seek/scrub-settle).
  useEffect(() => {
    if (!isPresenter) return;
    const send = () => {
      const r = Math.max(1, Math.round(coFpsRef.current));
      const msg: SessionMsg = {
        kind: "transport",
        playing: coPlayingRef.current,
        position: getPlayheadFrames() / r,
        rate: coRateRef.current,
        atMs: Date.now(),
        seq: ++coSeqRef.current,
        // `from` AND `epoch` are stamped by the host: a peer cannot know the
        // authoritative epoch, and sending a stale one strands receivers.
        from: "",
        epoch: 0,
      };
      sendSessionMsg(msg);
    };
    send();
    const iv = window.setInterval(send, 500);
    return () => window.clearInterval(iv);
  }, [isPresenter, sendSessionMsg]);
  // Everyone broadcasts their own playhead ~3 Hz for ghost cursors + prunes
  // stale ghosts (someone who stopped sending).
  useEffect(() => {
    if (!coSessionActive) return;
    const send = () => {
      const me = loadReviewer().name || (coRoleRef.current === "host" ? "Host" : "Guest");
      const r = Math.max(1, Math.round(coFpsRef.current));
      sendSessionMsg({ kind: "presence", name: me, position: getPlayheadFrames() / r });
      const now = Date.now();
      setCoGhosts((prev) => prev.filter((g) => now - g.at < 5000));
    };
    const iv = window.setInterval(send, 350);
    return () => window.clearInterval(iv);
  }, [coSessionActive, sendSessionMsg]);
  // Local echo + relay: the sender renders its own reaction immediately
  // (the host relay never echoes back to the origin).
  const sendReaction = useCallback((emote: string) => {
    const now = Date.now();
    if (now - lastReactionSendRef.current < 250) return; // per-sender throttle
    lastReactionSendRef.current = now;
    const selfId = coSessionRef.current.selfId ?? "m0";
    const r: LiveReaction = { id: ++reactionIdRef.current, from: selfId, name: nameForMember(selfId), emote, at: now };
    setLiveReactions((prev) => [...prev.slice(-23), r]);
    window.setTimeout(() => setLiveReactions((prev) => prev.filter((x) => x.id !== r.id)), 5200);
    sendSessionMsg({ kind: "reaction", from: selfId, emote, on: true });
  }, [sendSessionMsg, nameForMember]);

  const toggleHand = useCallback(() => {
    const selfId = coSessionRef.current.selfId ?? "m0";
    setRaisedHands((prev) => {
      const up = !prev.has(selfId);
      const next = new Set(prev);
      if (up) next.add(selfId); else next.delete(selfId);
      sendSessionMsg({ kind: "reaction", from: selfId, emote: "hand", on: up });
      return next;
    });
  }, [sendSessionMsg]);

  const startCoReview = useCallback(async (title?: string) => {
    try {
      // Host under the review identity's name (falls back to "Host" in Rust)
      // so guests see a real person heading the roster, not a role label.
      // The optional title names the SESSION (room header + peers' Welcome).
      await invoke<string>("session_start", { name: loadReviewer().name || null, title: title?.trim() || null });
    }
    catch (e) { pushNotification("error", "Couldn't start co-review", formatError(e)); }
  }, [pushNotification]);
  const joinCoReview = useCallback(async (ticket: string, name: string) => {
    // install: lets the host hand back the SAME member id if we've been in
    // this session before, instead of adding a duplicate person tile.
    try { await invoke("session_join", { ticket, name, install: loadInstallId() }); }
    catch (e) { pushNotification("error", "Couldn't join session", formatError(e)); }
  }, [pushNotification]);
  const leaveCoReview = useCallback(() => { void invoke("session_leave").catch(() => {}); }, []);

  // ── Screening mode (Louper-style cinematic watch-party layout) ──────
  // A reflow of the EXISTING body (participant rail ← sidebar, cinematic
  // viewport, comments) — never a new tree, so the player is not remounted
  // and the session/playback keep running. Auto-enters when a session starts,
  // auto-exits when it ends; the rail's "Exit" drops back to editing while the
  // session stays live (re-enter from the co-review popover).
  const [theater, setTheater] = useState(false);
  const prevScreenSessionRef = useRef(false);
  useEffect(() => {
    const was = prevScreenSessionRef.current;
    prevScreenSessionRef.current = coSessionActive;
    // Entering a session lands in the ROOM (theater is an opt-in sub-mode
    // now, not the entry experience); the drawer opens for comments.
    if (coSessionActive && !was) setQueueOpen(true);
    if (!coSessionActive && was) setTheater(false);
  }, [coSessionActive, setQueueOpen]);
  // Everyone in the session, for the rail — so people see each other. Host's
  // roster is peers-only (its own name is local); a peer's roster is the full
  // list the host broadcast (Host + peers, self found by name).
  const theaterParticipants = useMemo(() => {
    const me = loadReviewer();
    const myName = me.name || "You";
    if (coSession.role === "host") {
      return [
        { id: "m0", name: myName, color: me.color, isHost: true, isSelf: true },
        ...coSession.peers.map((p) => ({ id: p.id, name: p.name, color: reviewerColorFor(p.name, me), isHost: false, isSelf: false })),
      ];
    }
    // Peer view: ids are exact - the host is m0 and selfId came from the
    // host's Welcome, so name collisions can't confuse the roster.
    return coSession.peers.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.id === coSession.selfId ? me.color : reviewerColorFor(p.name, me),
      isHost: p.id === "m0",
      isSelf: p.id === coSession.selfId,
    }));
    // selfId MUST be a dependency. It arrives in `Welcome` while the roster
    // arrives in `PeerList` - two separate messages - so whenever selfId lands
    // second this memo held a roster where NOBODY was marked isSelf. The guest
    // then saw their own tile rendered as a remote peer: no self-view controls,
    // no "you" styling. That is a real divergence between what the host's
    // screen shows and what the guest's does, not a lint nit.
  }, [coSession.role, coSession.peers, coSession.selfId]);

  // In a session, the shared doc drives the timeline markers + annotations
  // (so everyone's live comments show on every timeline).
  useEffect(() => {
    if (!sessionDoc) return;
    const me = loadReviewer();
    const markers = reviewMarkersOf(sessionDoc, sessionDoc.activeVersionId);
    setReviewMarkers(markers.map((m) => ({
      id: m.id, time: m.time, timeEnd: m.timeEnd, resolved: m.resolved,
      color: reviewerColorFor(m.author, me), initials: initialsOf(m.author),
    })));
    setReviewAnnotations(annotationsOf(sessionDoc, sessionDoc.activeVersionId)
      .map((a) => ({ id: a.id, time: a.time, strokes: a.strokes, color: reviewerColorFor(a.author, me) })));
    // Both are useState setters from App, so React guarantees their identity;
    // listing them costs nothing and stops the array drifting out of date.
  }, [sessionDoc, setReviewMarkers, setReviewAnnotations]);

  // Ghost cursors for the timeline — peer playheads in frames, tinted per name.
  const coGhostMarkers = useMemo(() => {
    const r = Math.max(1, Math.round(fps));
    const me = loadReviewer();
    return coGhosts.map((g) => ({
      name: g.name,
      frame: Math.floor(g.position * r),
      color: reviewerColorFor(g.name, me),
    }));
  }, [coGhosts, fps]);

  // ── Webcam mesh (use-rtc-mesh) ──────────────────────────────────
  // Runs while the session is live and we know our member id; signaling
  // rides the iroh star (the rtc case above feeds incoming lines in).
  const selfId = coSession.selfId ?? (coSession.role === "host" ? "m0" : null);
  // Members carry their roster claim epoch: same id + higher epoch means that
  // person reconnected, so the mesh must rebuild that connection rather than
  // keep talking to a socket that's gone. Serialized into a string key so the
  // effect doesn't re-run on every identical render.
  const memberKey = coSession.peers.map((p) => `${p.id}:${p.epoch}`).join(",");
  const memberIds = useMemo(
    () => {
      const epochs = new Map(coSession.peers.map((p) => [p.id, p.epoch]));
      return theaterParticipants
        .filter((p) => !p.isSelf)
        .map((p) => ({ id: p.id, epoch: epochs.get(p.id) ?? 0 }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [theaterParticipants, memberKey],
  );
  const mesh = useRtcMesh({
    active: coSessionActive,
    selfId,
    role: coSession.role,
    memberIds,
    turn,
    stunUrl,
    // Into the pipeline log, not the console: in a built .app the WKWebView
    // console needs Safari's inspector attached, so anything logged there
    // during a real session is unreachable by the person hitting the bug.
    onLog: (tag, msg) => { appendLogRef.current(tag, "rtc", msg); },
  });
  rtcSignalRef.current = mesh.handleSignal;

  // ── Screen share controller (pure machine; pipeline injected) ────
  // Every ending - bar button, session end, ffmpeg death - converges on
  // the same cleanup: camera restored, peers un-flagged, child stopped.
  const shareRef = useRef<ShareController | null>(null);
  const meshOverrideRef = useRef(mesh.setVideoOverride);
  meshOverrideRef.current = mesh.setVideoOverride;
  const meshAudioOverrideRef = useRef(mesh.setAudioOverride);
  meshAudioOverrideRef.current = mesh.setAudioOverride;
  if (!shareRef.current) {
    shareRef.current = new ShareController({
      start: (source) => invoke<string>("start_screen_share", { source }),
      stopPipeline: () => invoke("stop_screen_share").then(() => undefined),
      open: openShareStream,
      setOverride: (t) => meshOverrideRef.current(t),
      setAudioOverride: (t) => meshAudioOverrideRef.current(t),
      mixAudio: (share) => mixShareAudio(share, getSessionCapture()?.getAudioTracks()[0] ?? null),
      announce: (on) => {
        const msg = { kind: "sharing", from: coRoleRef.current === "host" ? "m0" : "", on };
        const cmd = coRoleRef.current === "host" ? "session_broadcast" : "session_send";
        void invoke(cmd, { msg }).catch(() => { /* session raced closed */ });
      },
      onChange: (state, stream) => { setShareState(state); setShareStream(stream); },
      log: (tag, msg) => {
        if (tag === "err") console.error("[screen-share]", msg);
        else console.warn("[screen-share]", msg);
      },
      // A post-picker failure used to dead-end in the console while the
      // share button silently re-enabled. Recheck TCC: if screen recording
      // is the blocker, say so and how to fix it; otherwise surface the
      // generic failure so the user at least knows it broke.
      onStartError: (err) => {
        void invoke<string>("screen_capture_access", { request: false }).then((access) => {
          if (access !== "granted") {
            pushNotification("error", "Screen recording is blocked",
              "Allow Sauce Bunny under System Settings, Privacy and Security, Screen Recording, then quit and reopen the app.");
            void invoke("open_privacy_pane", { anchor: "Privacy_ScreenCapture" }).catch(() => { /* best-effort */ });
          } else {
            pushNotification("error", "Screen share failed to start", formatError(err));
          }
        }).catch(() => {
          pushNotification("error", "Screen share failed to start", formatError(err));
        });
      },
    });
  }
  /** Host only: hand the presenter floor to another member. This passes a
   *  PERMISSION, not the network star - the invite ticket points at the
   *  original host's endpoint, so the relay itself can never move. Rust
   *  updates its own gate as the message goes out, so the new presenter's
   *  very next source change is accepted. */
  const presenterEpochRef = useRef(0);
  const makePresenter = useCallback((memberId: string) => {
    if (coRoleRef.current !== "host") return;
    const epoch = ++presenterEpochRef.current;
    setCoSession((prev) => ({ ...prev, presenter: memberId }));
    void invoke("session_broadcast", { msg: { kind: "presenter", member: memberId, epoch } })
      .catch(() => { /* session raced closed */ });
  }, []);
  /** Tier 3 of the fingerprint ladder: the guest points at THEIR copy of the
   *  presenter's file. Linking the fingerprint to that path means the next
   *  time anyone shares this content we resolve it silently (tier 1) - the
   *  ladder teaches itself. */
  const pendingSourceRef = useRef<SessionSource | null>(null);
  pendingSourceRef.current = pendingSource;
  // Tier C progress (either direction). Terminal happy phases self-clear so
  // the room head returns to normal without a click; the unhappy ones stay
  // until the user acts (retry or cancel is their decision to make).
  const transferClearRef = useRef(0);
  useEffect(() => {
    const un = listen<TransferProgress>("session:transfer", (e) => {
      const p = e.payload;
      setTransfer(p);
      if (transferClearRef.current) window.clearTimeout(transferClearRef.current);
      if (p.phase === "done" || p.phase === "sent" || p.phase === "cancelled") {
        transferClearRef.current = window.setTimeout(() => setTransfer(null), 4000);
      }
    });
    return () => {
      if (transferClearRef.current) window.clearTimeout(transferClearRef.current);
      void un.then((f) => f());
    };
  }, []);

  /** Host: offer the loaded file's bytes to the room (Tier C). The click
   *  that calls this IS the sender's consent; hashing progress arrives on
   *  session:transfer as phase "hashing". */
  const offerCurrentFile = useCallback(async (path: string, name?: string, vcodec?: string | null, acodec?: string | null) => {
    try {
      const info = await invoke<{ name: string; size: number; blake3: string; vcodec: string | null; acodec: string | null }>(
        "session_offer_file", { path, name: name ?? null, vcodec: vcodec ?? null, acodec: acodec ?? null },
      );
      setOfferedFile(info);
      setOfferError(null);
      slog("ok", `Offered "${info.name}" to the room.`);
    } catch (e) {
      const msg = formatError(e);
      setOfferError(msg);
      slog("err", `Could not offer the file: ${msg}`);
    }
  }, [slog]);

  /** Guest: fetch the offered file (consent = clicking the chip that names
   *  the file and its size), then link its fingerprint and open it - Tier A
   *  hits forever after. */
  const fetchOfferedFile = useCallback(async () => {
    const offer = offeredFileRef.current;
    if (!offer) return;
    const pending = pendingSourceRef.current;
    try {
      const path = await invoke<string>("session_fetch_file", {
        blake3Hex: offer.blake3, name: offer.name,
      });
      if (pending?.fingerprint) linkFingerprint(pending.fingerprint, path);
      await loadLocalPath(path);
      setPendingSource(null);
      sendSessionMsg({ kind: "sourceStatus", from: "", state: "ready", detail: null });
    } catch (e) {
      slog("err", `Transfer: ${formatError(e)}`);
    }
  }, [loadLocalPath, sendSessionMsg, slog]);

  /** Guest: watch the host's offered file NOW as a live stream (Tier B).
   *  App mounts the stream; this wrapper owns the session bookkeeping so
   *  the room converges (pending cleared, readiness reported). */
  const watchOfferedStream = useCallback(async () => {
    const offer = offeredFileRef.current;
    if (!offer) return;
    const pending = pendingSourceRef.current;
    try {
      await loadPeerStream(
        { name: offer.name, blake3: offer.blake3, vcodec: offer.vcodec, acodec: offer.acodec },
        { title: pending?.title ?? offer.name, duration: pending?.duration ?? null },
      );
      // Captured BEFORE pendingSource is cleared — it is the only place the
      // fingerprint still exists, and without it the landed copy is un-indexed.
      setKeepTarget({
        blake3: offer.blake3, name: offer.name, total: offer.size,
        fingerprint: pending?.fingerprint ?? null,
      });
      setPendingSource(null);
      sendSessionMsg({ kind: "sourceStatus", from: "", state: "ready", detail: null });
      slog("ok", `Streaming "${offer.name}" from the host.`);
    } catch (e) {
      slog("err", `Stream: ${formatError(e)}`);
      sendSessionMsg({ kind: "sourceStatus", from: "", state: "failed", detail: null });
    }
  }, [loadPeerStream, sendSessionMsg, slog]);

  /**
   * S.5 — watching also keeps it.
   *
   * Set when a Tier B watch starts and cleared by anything that ends it, so a
   * copy finishing late can never be handed off after the room moved on. The
   * fingerprint is captured HERE because `watchOfferedStream` clears
   * `pendingSource` on success, and without it the landed copy would be
   * un-indexed — the next session would re-stream a file already on disk,
   * which is the whole thing Tier A exists to prevent.
   */
  const [keepTarget, setKeepTarget] = useState<
    { blake3: string; name: string; total: number; fingerprint: string | null } | null
  >(null);
  keepTargetRef.current = keepTarget;

  const onKeepHandOff = useCallback(async (path: string) => {
    const target = keepTargetRef.current;
    if (target?.fingerprint) linkFingerprint(target.fingerprint, path);
    // Carry the playhead across, the way the RC4 download-fallback handoff
    // does: a local player boots at 0 and this swap is meant to be invisible.
    // `onChaseSeek`, not a user seek — the user did not ask to move, and
    // arming the seek latch here would make the room think they had. If the
    // seek lands before the player is ready, the session's own chase corrects
    // it on the next heartbeat, so this is a head start rather than the only
    // thing holding the position.
    const at = getPlayheadFrames();
    // loadLocalPath CATCHES internally and RETURNS the error; null is success.
    // Awaiting it and ignoring the result meant a copy that verified but would
    // not open still announced "playing your own copy" while the peer stream
    // was what remained on screen. The hook's prop types it as Promise<unknown>
    // (which is how this got past the compiler), so the shape is narrowed here.
    const failure = await loadLocalPath(path) as { message?: string } | null;
    if (failure && typeof failure === "object" && failure.message) {
      slog("err", `Saved the copy, but could not open it: ${failure.message}`);
      // Deliberately keep watching. The stream is still good, and the copy is
      // on disk for the next session even though this handoff did not land.
      return;
    }
    onChaseSeek(at);
    setKeepTarget(null);
  }, [loadLocalPath, onChaseSeek, slog]);

  const streamKeep = useStreamKeep({
    watching: keepTarget,
    onHandOff: (path) => { void onKeepHandOff(path); },
    log: slog,
  });

  /** Guest: stop the in-flight fetch. The partial stays; fetching resumes. */
  const cancelFetch = useCallback(() => {
    const offer = offeredFileRef.current;
    if (offer) void invoke("session_cancel_fetch", { blake3Hex: offer.blake3 }).catch(() => {});
  }, []);

  const adoptPendingSource = useCallback(async () => {
    const pending = pendingSourceRef.current;
    if (!pending || pending.kind !== "file") return;
    const picked = await import("@tauri-apps/plugin-dialog").then((m) =>
      m.open({ multiple: false, directory: false, title: "Find your copy" }),
    );
    if (typeof picked !== "string" || !picked) return;
    if (pending.fingerprint) linkFingerprint(pending.fingerprint, picked);
    try {
      await loadLocalPath(picked);
      setPendingSource(null);
      sendSessionMsg({ kind: "sourceStatus", from: "", state: "ready", detail: null });
    } catch {
      sendSessionMsg({ kind: "sourceStatus", from: "", state: "failed", detail: null });
    }
  }, [loadLocalPath, sendSessionMsg]);
  const startShare = useCallback((source: ShareSourceArg) => { void shareRef.current?.start(source); }, []);
  const stopShare = useCallback(() => { void shareRef.current?.stop(); }, []);
  // Session over -> the share dies with it (same converged cleanup).
  useEffect(() => {
    if (!coSessionActive) {
      void shareRef.current?.stop();
      setSharingMembers(new Set());
    }
  }, [coSessionActive]);

  return {
    coSession, coSessionActive, sessionDoc, postSessionOp, coGhostMarkers,
    theater, setTheater, theaterParticipants,
    meshStreams: mesh.remoteStreams, meshStates: mesh.peerStates,
    meshMutedForMe: mesh.peerMutedForMe, toggleMuteForMe: mesh.toggleMuteForMe,
    shareState, shareStream, sharingMembers, startShare, stopShare,
    liveReactions,
    raisedHands,
    /** True when WE drive source + transport (host by default). */
    isPresenter,
    /** The presenter's source when we can't show it yet (null = nothing pending). */
    pendingSource,
    /** member id → "loading" | "ready" | "failed" | "missing" for that source. */
    sourceStatus,
    makePresenter,
    adoptPendingSource,
    offeredFile,
    transfer,
    offerCurrentFile,
    offerError,
    clearOfferError: useCallback(() => setOfferError(null), []),
    keepBadge: streamKeep.badge,
    keepAction: streamKeep.action,
    onKeepCancel: streamKeep.onCancel,
    onKeepResume: streamKeep.onResume,
    keepEnabled: streamKeep.enabled,
    setKeepEnabled: streamKeep.setEnabled,
    onKeepStall: streamKeep.onStall,
    onKeepStreamInfo: streamKeep.onStreamInfo,
    fetchOfferedFile,
    watchOfferedStream,
    cancelFetch,
    handRaised: coSession.selfId != null ? raisedHands.has(coSession.selfId) : raisedHands.has("m0"),
    sendReaction,
    toggleHand,
    startCoReview, joinCoReview, leaveCoReview,
  };
}

// ── Chase decision (pure — unit-tested in use-co-review.test.ts) ────────
export type ChaseInput = {
  /** First heartbeat after our player loaded: snap to the host even paused. */
  justLoaded: boolean;
  /** A local user seek in the last ~1.2s owns the playhead. */
  localSeekHot: boolean;
  playing: boolean;
  curSeconds: number;
  expectedSeconds: number;
  /** Host moved > 0.25s since the last heartbeat we ACTED on. */
  hostScrubbed: boolean;
  /** ms since our last chase seek. Guards against a correction storm: a seek
   *  takes time to land (a web seek rebuilds the whole ffmpeg stream), and
   *  measuring drift mid-seek produces another seek. */
  sinceLastChaseMs: number;
};
/** While playing, drift under this is left alone. Above the old 0.5s a normal
 *  clock offset kept the guest permanently "out of sync"; 0.75s is still well
 *  under a noticeable desync for review and stops the churn. */
const PLAYING_TOLERANCE_SEC = 0.75;
/** No two chase seeks closer together than this. */
const CHASE_COOLDOWN_MS = 1000;
export type ChaseDecision = {
  /** Seconds to seek to, or null to leave the playhead alone. */
  seekSeconds: number | null;
  /** Whether to record the host position as "seen". A yielded heartbeat
   *  must NOT commit it — the scrub edge has to survive the latch window. */
  commitHostPos: boolean;
};
export function decideChase(i: ChaseInput): ChaseDecision {
  if (i.localSeekHot && !i.justLoaded) return { seekSeconds: null, commitHostPos: false };
  // A seek we just issued may still be landing; measuring drift against a
  // mid-flight playhead would immediately order another one. The just-loaded
  // snap is exempt - that one must always fire.
  const cooling = !i.justLoaded && i.sinceLastChaseMs < CHASE_COOLDOWN_MS;
  if (i.playing) {
    const drift = Math.abs(i.curSeconds - i.expectedSeconds);
    return {
      seekSeconds: !cooling && drift > PLAYING_TOLERANCE_SEC ? i.expectedSeconds : null,
      commitHostPos: true,
    };
  }
  if (cooling) return { seekSeconds: null, commitHostPos: true };
  // Paused: only jump when the host actually scrubbed (or we just loaded) —
  // a paused guest glancing at a nearby frame must not be yanked back.
  if (i.justLoaded || (i.hostScrubbed && Math.abs(i.curSeconds - i.expectedSeconds) > 0.1)) {
    return { seekSeconds: i.expectedSeconds, commitHostPos: true };
  }
  return { seekSeconds: null, commitHostPos: true };
}
