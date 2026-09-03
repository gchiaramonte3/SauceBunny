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
import type { KeepAction } from "../lib/stream-keep";
import { listen } from "@tauri-apps/api/event";
import { formatError } from "../lib/error-format";
import { loadInstallId } from "../lib/identity";
import {
  newScreening, openSegment, closeScreening, noteComment, unnoteComment,
  noteParticipants, markWatched, screeningIsWorthKeeping, type ScreeningDoc,
} from "../lib/screening";
import { saveScreening } from "../lib/screening-store";
import { getLastUserSeekAt, getPlayheadFrames, isScrubbing, subscribeScrub } from "../lib/playhead-store";
import {
  clearGhosts, pruneGhosts, shouldSendPresence, upsertGhost,
} from "../lib/ghost-store";
import { clearReactions, pushReaction } from "../lib/reaction-store";
import { useStreamKeep } from "./use-stream-keep";
import { acceptTransport, createClockEstimator, expectedPosition } from "../lib/session-clock";
import { loadReview, saveReview, ensureVersion, applyReviewOp, attributeReviewOp, mergeReviewDoc, adoptSnapshot, resolveByFingerprint, linkFingerprint, sanitizeDocForWire, commentMarkers as reviewMarkersOf, annotationsOf, loadReviewer, reviewerColorFor, initialsOf, type AnnotationStrokes, type ReviewDoc, type ReviewOp, rememberReceivedAs } from "../lib/review";
import type { PlayerHandle } from "../components/player-handle";
import type { Participant } from "../components/PeoplePanel";
import type { ToastKind } from "../components/CanvasToast";
import { asLogTag, type LogTag, type Metadata } from "../types";
import {
  applyDrawOp, attributeDrawOp, EMPTY_DRAW_STATE, isDrawRelay,
  type DrawOp, type DrawState,
} from "../lib/draw-ops";
import type { SessionMsg } from "../bindings/SessionMsg";
import type { RecordingHandle } from "../bindings/RecordingHandle";
import type { RecordingResult } from "../bindings/RecordingResult";
import type { SessionState as CoSessionState } from "../bindings/SessionState";
import { useRtcMesh, type TurnConfig } from "./use-rtc-mesh";
import type { MeshPeerState } from "../lib/rtc-mesh";
import { ShareController, type ShareState } from "../lib/share-machine";
import { ViewerShareController, type ViewerShareState } from "../lib/viewer-share";
import { mixShareAudio, openShareStream } from "../lib/share-stream";
import { getSessionCapture } from "./use-media-capture";
import type { ShareSourceArg } from "../bindings/ShareSourceArg";
import { clearDelivered, enqueueOp, pendingCount, pendingOps } from "../lib/review-outbox";
import { splitReviewCode } from "../lib/review-link";

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
  /** Blank the stage when the ROOM moves to something this Mac cannot open.
   *  Narrower than the user's own "unload", which also empties the export
   *  queue and the marks - nobody asked for that because a peer changed
   *  source. */
  clearStageForPeerSource: () => void;
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

// LiveReaction moved to lib/reaction-store with the feed itself; re-exported
// so the components that type against it keep one import path.
export type { LiveReaction } from "../lib/reaction-store";

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
  /** The room's live shared drawing — the scratch surface before a note is
   *  posted. Ephemeral: it dies with the session, while a posted comment
   *  carries its finished strokes in the review doc like any other content. */
  liveDraw: DrawState;
  /** Draw locally and relay to the room. */
  postDrawOp: (op: DrawOp) => void;
  /** Wipe the room's live surface. Relays an erase for every stroke currently
   *  on it, including other people's: this is a shared scratch surface that
   *  dies with the session, and "clear the screen" is the verb a room of two
   *  to four expects. Nothing durable is touched. */
  clearLiveDraw: () => void;
  /** Drop faded strokes LOCALLY, with no relay. Each peer fades on its own
   *  clock (see LiveDrawLayer), so relaying expiry would fight that. */
  pruneLiveDraw: (ids: string[]) => void;
  /** Peer playheads in frames, tinted per name — the timeline ghost cursors. */
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
  /** Live view of the presenter's own monitor: the bridge that shows a guest
   *  a picture while the real file is still transferring. A real-time encode,
   *  so it is announced to the room and is never a delivery mechanism. */
  viewerShareState: ViewerShareState;
  /** False when there is no frame to capture yet; the caller should offer the
   *  file instead of claiming a share that is not running. */
  startViewerShare: () => boolean;
  stopViewerShare: () => void;
  shareStream: MediaStream | null;
  /** Member ids currently flagged as sharing (tile badges). */
  sharingMembers: ReadonlySet<string>;
  startShare: (source: ShareSourceArg) => void;
  stopShare: () => void;
  /** Member ids recording their own camera, and recording THIS WINDOW. Two
   *  sets because they mean different things to the person being told. */
  recordingMembers: ReadonlySet<string>;
  stageRecorders: ReadonlySet<string>;
  /** True while THIS machine is recording the stage. Held locally as well as
   *  announced, because a light driven by the wire lags your own click by a
   *  round trip - and the host never receives its own broadcast at all. */
  stageRecording: boolean;
  /** Start/stop recording this window. Announces to the room either way. */
  startStageRecording: (title: string | null) => Promise<void>;
  stopStageRecording: () => Promise<void>;
  /** The last take's file, for the toast that says where it went. */
  lastRecording: RecordingResult | null;
  /** Transient reactions currently on screen (auto-pruned after ~5s). */
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
  keepAction: KeepAction;
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
  watchOfferedStream: (opts?: { keepCopy?: boolean }) => Promise<void>;
  /** Start a copy of the stream already playing. Absent until one is. */
  keepOfferedCopy: () => void;
  /** Assign a placer to move a finished transfer out of the cache. */
  placeReceivedRef: MutableRefObject<((path: string, name: string) => Promise<void>) | null>;
  canKeepCopy: boolean;
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
  /** How many notes are waiting to be delivered, across every review.
   *  Zero when everything the user wrote has gone out. */
  outboxDepth: number;
  /** A join code delivered by a clicked link, or null. The lobby pre-fills
   *  it; nothing connects until the user presses Join. */
  pendingJoinCode: string | null;
  clearPendingJoinCode: () => void;
};

/**
 * Stamp a new comment with the session and segment it was made in.
 *
 * Module scope and pure, so it is testable without mounting the hook. Returns
 * the op unchanged when there is no screening (solo editing) or when the op is
 * not an add - a stamp is a fact about creation, so re-stamping an edit or a
 * relayed op would be inventing one.
 */
export function stampOpWithSession(op: ReviewOp, sc: ScreeningDoc | null): ReviewOp {
  if (op.t !== "add" || !sc) return op;
  const open = sc.segments[sc.segments.length - 1];
  return {
    ...op,
    comment: {
      ...op.comment,
      sessionId: sc.id,
      // Only a segment still OPEN describes what was on screen. A closed one
      // is what the room used to be watching.
      segmentId: open && open.endedAt === 0 ? open.id : undefined,
    },
  };
}

export function useCoReview({
  isPlaying, fps, playbackRate,
  sessionSource, activeSourceUrlRef, reviewSourceKey,
  playerRef, metadataRef,
  onChaseSeek, setUrl, handleFetch, loadLocalPath, loadPeerStream, clearStageForPeerSource,
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
  const [raisedHands, setRaisedHands] = useState<ReadonlySet<string>>(new Set());
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
  /**
   * Who is recording, keyed by what they are recording.
   *
   * Two sets rather than one, because the two recordings mean different
   * things to the person being told: "camera" is that member recording
   * themselves, "stage" is someone recording this window - which includes
   * everyone's tiles, and so their face. A single "is recording" flag cannot
   * carry that, and a consent signal that is vague is not one.
   */
  const [recordingMembers, setRecordingMembers] = useState<ReadonlySet<string>>(new Set());
  const [stageRecorders, setStageRecorders] = useState<ReadonlySet<string>>(new Set());
  const [shareState, setShareState] = useState<ShareState>("idle");
  const [shareStream, setShareStream] = useState<MediaStream | null>(null);
  const coSessionActive = coSession.role !== "off";
  // The shared review doc while in a session (null = solo).
  const [sessionDoc, setSessionDoc] = useState<ReviewDoc | null>(null);
  const sessionDocRef = useRef<ReviewDoc | null>(null); sessionDocRef.current = sessionDoc;
  // Live peer playheads → ghost cursors on the timeline (excludes self; the
  // relay never echoes your own presence back).
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
  /** The chase target we have asked for and not yet reached. See decideChase. */
  const coPendingChaseRef = useRef<number | null>(null);
  const coReadyRef = useRef(false); // has OUR player loaded the host's source yet?
  /** Latest persistDoc, so the message handler (registered once) can flush an
   *  outgoing doc without capturing a stale closure. */
  const persistDocRef = useRef<(d: ReviewDoc | null) => void>(() => {});
  /** The screening being recorded: which sources this room watched, in order,
   *  and which comments were made against each. Holds no comment bodies -
   *  those live in the per-source review docs (see lib/screening.ts). */
  const screeningRef = useRef<ScreeningDoc | null>(null);
  /** When the SESSION began, which is not when its first source loaded.
   *  newScreening stamps startedAt from `now`, and the screening is created on
   *  the first source - so a room that spent ten minutes gathering before
   *  anyone pressed play recorded a start ten minutes late, and the shelf's
   *  duration was the watching time rather than the session. */
  const sessionStartedAtRef = useRef<number>(0);
  /** Debounced write-through. The screening used to reach disk EXACTLY ONCE,
   *  in the role->off branch: quit mid-session, lose the renderer, or close
   *  the window without pressing End and the whole record was gone - while the
   *  comments survived, because the review store's own write-through was
   *  fixed for precisely this reason. */
  const screeningSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  /* The same send, but it TELLS YOU whether it worked.
     
     sendSessionMsg swallows its rejection, which is right for a presence beat
     or a transport tick - those are re-sent constantly and a dropped one is
     invisible by design. It is wrong for a note: that op was applied to the
     author's screen and, if the send failed, reached nobody, and the author
     was never told. Review content gets the version that can fail. */
  const trySendSessionMsg = useCallback(async (msg: SessionMsg): Promise<boolean> => {
    if (coRoleRef.current === "off") return false;
    const cmd = coRoleRef.current === "host" ? "session_broadcast" : "session_send";
    try {
      await invoke(cmd, { msg });
      return true;
    } catch {
      return false;
    }
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

  /** How many notes are waiting to be delivered, for the UI. A queue nobody
   *  can see is the failure this replaces, wearing different clothes. */
  const [outboxDepth, setOutboxDepth] = useState(() => pendingCount());

  /**
   * The room's live drawing, shared while a note is being composed.
   *
   * EPHEMERAL on purpose. A posted comment carries its finished strokes in the
   * review doc like any other content; this is the shared scratch surface
   * BEFORE anyone posts, so two people can point at the same frame at once. It
   * dies with the session, which is why it is state here and not in the doc.
   */
  const [liveDraw, setLiveDraw] = useState<DrawState>(EMPTY_DRAW_STATE);

  /** Draw locally + relay. Rides the reviewOp message, which the Rust relay
   *  treats as an opaque string, so this needed no backend change. */
  const postDrawOp = useCallback((op: DrawOp) => {
    setLiveDraw((prev) => applyDrawOp(prev, op));
    sendSessionMsg({ kind: "reviewOp", op: JSON.stringify({ t: "draw", op }), from: "" });
  }, [sendSessionMsg]);

  /** Erase everything on the live surface, for everyone. Reads the CURRENT
   *  state through the setter rather than closing over `liveDraw`, so a clear
   *  fired from a stale render still erases what is actually on screen. */
  const clearLiveDraw = useCallback(() => {
    setLiveDraw((prev) => {
      const at = Date.now();
      for (const st of prev.strokes) {
        sendSessionMsg({
          kind: "reviewOp",
          op: JSON.stringify({ t: "draw", op: { t: "strokeErase", id: st.id, at } }),
          from: "",
        });
      }
      return prev.strokes.reduce(
        (acc, st) => applyDrawOp(acc, { t: "strokeErase", id: st.id, at }), prev);
    });
  }, [sendSessionMsg]);

  /** Local-only expiry. No relay, no tombstone: a faded stroke is gone from
   *  THIS view, and another peer may still be holding it on a longer fade. */
  const pruneLiveDraw = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    setLiveDraw((prev) => prev.strokes.some((st) => gone.has(st.id))
      ? { ...prev, strokes: prev.strokes.filter((st) => !gone.has(st.id)) }
      : prev);
  }, []);

  const postSessionOp = useCallback((op: ReviewOp) => {
    // STAMP BEFORE ANYTHING ELSE SEES IT. A note gets the session and segment
    // it was made in here, once, so the local doc, the file on disk and every
    // peer's copy all carry the same value - stamping after the local apply or
    // after the stringify would leave the copies disagreeing.
    //
    // No wire change: the stamp rides inside the comment on the existing `add`
    // op, which the Rust relay treats as an opaque string, so a peer on an
    // older build carries the fields through untouched.
    op = stampOpWithSession(op, screeningRef.current);
    if (!sessionDocRef.current) pendingOpsRef.current.push(op);
    else setSessionDoc((prev) => (prev ? applyReviewOp(prev, op) : prev));
    recordOpInScreening(op);
    // `from` is stamped by the HOST on relay; whatever we put here is
    // overwritten, so send it empty rather than asserting an identity.
    void trySendSessionMsg({ kind: "reviewOp", op: JSON.stringify(op), from: "" })
      .then((sent) => {
        /* A note that did not go out is KEPT, on disk, under the review it
           belongs to. Before this it was applied to the author's own screen
           and then dropped: the send was fire-and-forget with a swallowed
           catch, so a host that had gone away cost the note with no sign
           anything had happened. */
        if (sent) return;
        const key = sessionDocRef.current?.sourceKey ?? sessionSourceRef.current?.reviewKey ?? null;
        if (key) setOutboxDepth(enqueueOp(key, op));
      });
  }, [trySendSessionMsg, recordOpInScreening]);

  /* Deliver what is waiting for a review, then forget exactly what landed.
     
     Sequential rather than Promise.all: these go down one QUIC stream and the
     host applies them in order, and an edit that overtakes the add it edits
     would be dropped by the LWW guard rather than applied. Stops at the first
     failure - if the connection has gone again, the rest stay queued. */
  const drainOutbox = useCallback(async (sourceKey: string, ops: readonly ReviewOp[]) => {
    const sent: ReviewOp[] = [];
    for (const op of ops) {
      const ok = await trySendSessionMsg({ kind: "reviewOp", op: JSON.stringify(op), from: "" });
      if (!ok) break;
      sent.push(op);
    }
    if (sent.length) clearDelivered(sourceKey, sent);
    setOutboxDepth(pendingCount());
  }, [trySendSessionMsg]);
  const drainOutboxRef = useRef(drainOutbox);
  drainOutboxRef.current = drainOutbox;

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
          // The notes go with the picture. Persist FIRST: a guest's own notes
          // are theirs, and the host clearing the room must not be a way to
          // lose them - persistDoc merges into any solo review they already
          // have. Through refs because this handler is registered once.
          if (sessionDocRef.current) {
            persistDocRef.current(sessionDocRef.current);
            setSessionDoc(null);
          }
          prevDocKeyRef.current = null;
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
              clearStageForPeerSource();
              sendSessionMsg({ kind: "sourceStatus", from: "", state: "missing", detail: null });
            });
          return;
        }
        /* Tier 3: we do not have it, so STOP SHOWING THE OLD ONE.
           This used to say "missing" and return, leaving the previous asset
           playing underneath the notice. The screen then read
           "<new file> - Anthony is showing this, and it cannot be streamed to
           you" over a completely different video that was still running, which
           invites exactly the wrong conclusion: that the thing on screen is
           what the room is discussing. A blank stage under that notice is
           worse to look at and far better to trust. */
        clearStageForPeerSource();
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

          /* EVERY adoption drains the durable outbox, not just the first.
             
             A snapshot is the one moment we know a host is listening and which
             review they are on. Gating this on `prev` being null - the way the
             in-memory replay above is gated - means a reconnect inside a live
             session delivers nothing, which is the common case: the host went
             away, the reviewer kept working, the host came back.
             
             Re-sending an op the host already has is a no-op. `add` carries
             the fully-built comment so inserts are id-idempotent, and
             resolve/like/status are SET rather than toggle, so an eager drain
             costs nothing while a missed one costs a note. */
          const waiting = pendingOps(incoming.sourceKey);
          const merged = [...replay, ...waiting];
          setSessionDoc((cur) => adoptSnapshot(cur, incoming, merged));
          if (waiting.length) void drainOutboxRef.current(incoming.sourceKey, waiting);
        } catch { /* malformed snapshot */ }
        return;
      case "reviewOp":
        try {
          // Attribute by the HOST-STAMPED sender id, never by what the
          // payload claims: the op names its own author, and the relay is
          // payload-agnostic, so trusting it let any peer sign review
          // content (including the source verdict) as somebody else.
          const parsed: unknown = JSON.parse(m.op);
          // Draw ops share this message and are NOT part of the persisted doc.
          if (isDrawRelay(parsed)) {
            const drawOp = attributeDrawOp(parsed.op, nameForMember(m.from));
            setLiveDraw((prev) => applyDrawOp(prev, drawOp));
            return;
          }
          const op = attributeReviewOp(parsed as ReviewOp, nameForMember(m.from));
          /* AN OP WITH NO DOC IS BUFFERED, NOT DROPPED.
             
             This was `prev ? applyReviewOp(prev, op) : prev` - a null guard
             that discarded somebody else's note without a word. It is not
             hypothetical: a guest's doc is null until the host's first
             snapshot lands, so an op posted in that window vanished from the
             receiver, and the only reason it usually survived was that the
             snapshot which followed happened to contain it. Nothing enforced
             that, and nothing said so if it did not.
             
             It matters more than it used to. The outbox now clears on a
             successful invoke, so the sender's copy is gone the moment the
             wire accepts it. A receiver that silently drops the op makes the
             note disappear from BOTH machines with no log on either - the one
             failure the outbox was written to make impossible.
             
             The buffer is the same one the local author's pre-snapshot ops
             use, and it is replayed on first adoption for the same reason. */
          if (sessionDocRef.current) {
            setSessionDoc((prev) => (prev ? applyReviewOp(prev, op) : prev));
          } else {
            pendingOpsRef.current.push(op);
            slog("info", "Held a note that arrived before the review did; it will apply with the first snapshot.");
          }
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
          // Straight into the reaction store - an applause burst must move
          // two leaves, not the App tree. It prunes itself.
          pushReaction({ from: m.from, name: nameForMember(m.from), emote: m.emote, at: Date.now() });
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
      case "recording": {
        const put = (prev: ReadonlySet<string>) => {
          const next = new Set(prev);
          if (m.on) next.add(m.from); else next.delete(m.from);
          return next;
        };
        if (m.what === "stage") setStageRecorders(put); else setRecordingMembers(put);
        slog(m.on ? "warn" : "info",
          `${m.from} ${m.on ? "started" : "stopped"} recording ${m.what === "stage" ? "the stage" : "their camera"}.`);
        return;
      }
      case "presence":
        // Straight into the ghost store - App must not re-render for a
        // peer's playhead tick. Only the Timeline leaf subscribes.
        upsertGhost(m.name, m.position, Date.now());
        return;
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
        // "Moved at all": 4ms is under any real frame duration (120fps is
        // 8.3ms) and over transport jitter, so a frame-step registers on the
        // first heartbeat that carries it.
        const hostStepped = coLastHostPosRef.current === null || Math.abs(m.position - coLastHostPosRef.current) > 0.004;
        // RC3 latch: a local seek in the last ~1.2s owns the playhead — the
        // chase yields so a guest can click a transcript cue without being
        // yanked back on the next heartbeat. decideChase (pure, unit-tested)
        // owns the branch logic; crucially a YIELDED heartbeat does NOT
        // commit the host position as seen (review fix: consuming the scrub
        // edge while yielding left a paused guest stranded forever).
        const localSeekHot = Date.now() - getLastUserSeekAt() < 1200;
        const decision = decideChase({
          justLoaded, localSeekHot, playing: m.playing,
          curSeconds: cur, expectedSeconds: expected, hostScrubbed, hostStepped,
          sinceLastChaseMs: now - coLastChaseAtRef.current,
          pendingChaseSeconds: coPendingChaseRef.current,
        });
        // Landed: the outstanding seek is done, so a later drift is a real
        // correction rather than the same one repeating.
        if (coPendingChaseRef.current != null
            && Math.abs(cur - coPendingChaseRef.current) <= 0.02) {
          coPendingChaseRef.current = null;
        }
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
          coPendingChaseRef.current = decision.seekSeconds;
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
  /* A clicked saucebunny://review/<code> link.
     
     It fills the join field and takes you to the lobby; it does NOT connect.
     A link is an instruction from someone else, and joining opens a network
     connection to whoever's key is in it, so the last step stays a press. The
     lobby is also where identity and devices are chosen, and skipping it would
     put a stranger on your camera because you clicked a link in Slack.
     
     Two arrivals, because there are two cases. A link clicked while the app
     runs comes as the event. A link clicked while it is CLOSED launches the
     app, and the URL lands before any webview exists - Tauri drops events
     rather than queueing them for a listener that has not registered - so the
     code is buffered in Rust and pulled here on mount. Same shape as the
     panel window's request-state handshake. */
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);
  /** The grant secret from the same link, held beside the code so joining can
   *  present it. Not shown anywhere: it is a credential, not a label. */
  const pendingGrantRef = useRef<string | null>(null);
  const onDeeplinkReview = useCallback((delivered: string) => {
    const { code, grant } = splitReviewCode(delivered);
    if (!code) return;
    pendingGrantRef.current = grant;
    setPendingJoinCode(code);
  }, []);
  useEffect(() => {
    const un = listen<string>("deeplink:review", (e) => onDeeplinkReview(e.payload));
    // The cold-launch half. `take` rather than `read`: a link opens once, and
    // leaving it in place would re-fill the field on every remount.
    void invoke<string | null>("take_pending_review_link")
      .then((code) => { if (code) onDeeplinkReview(code); })
      .catch(() => { /* no link waiting is the normal case */ });
    return () => { void un.then((f) => f()); };
  }, [onDeeplinkReview]);

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
    // Ask once, AFTER the listener above is registered - the same ordering the
    // panel bus uses. A session that was already running when this window
    // mounted emits nothing (it has not changed), so without this pull the
    // renderer would show a lobby over a live room until something moved.
    void invoke<CoSessionState>("session_state")
      .then((st) => { if (st.role !== "off") setCoSession(st); })
      .catch(() => { /* backend not up yet; the pushed event still arrives */ });
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

    if (coSession.role !== "off" && prev === "off") sessionStartedAtRef.current = Date.now();

    if (coSession.role === "off" && prev !== "off") {
      persistDoc(sessionDocRef.current);
      // Close the running segment and keep the screening - unless nothing was
      // ever watched and nobody else showed up, which is not a memory worth
      // cluttering the library with.
      const sc = screeningRef.current;
      if (screeningSaveRef.current) {
        // A debounced write-through may still be pending. Let this final save
        // supersede it rather than racing it: the doc below is strictly newer.
        clearTimeout(screeningSaveRef.current);
        screeningSaveRef.current = null;
      }
      if (sc) {
        const finished = closeScreening(sc);
        if (screeningIsWorthKeeping(finished)) {
          void saveScreening(finished).catch((e) => {
            // The session is already over, so there is nothing to retry into -
            // but the user watched something and it is not in their library,
            // and they are entitled to know that rather than find out later.
            appendLogRef.current("warn", "session",
              `This screening could not be saved: ${formatError(e)}`);
          });
        }
        screeningRef.current = null;
      }
      prevDocKeyRef.current = null;
      setSessionDoc(null);
      clearGhosts();
      clearReactions();
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
    if (coSession.role !== "host") return;
    // THE ROOM IS WATCHING NOTHING. Clearing the source used to fall through
    // this early return, so the shared doc kept the outgoing clip's notes and
    // the panel went on showing them - on the host's screen and, because the
    // clear only ever moved the picture, on every guest's too. The room looked
    // like it had cleared and was still holding a previous clip's review.
    //
    // The notes go to DISK before the panel drops them. They belong to the
    // clip, not to the room, and clearing the room must never be a way to lose
    // them - persistDoc merges into whatever solo review already exists.
    if (!reviewSourceKey) {
      if (sessionDocRef.current) {
        persistDoc(sessionDocRef.current);
        setSessionDoc(null);
      }
      prevDocKeyRef.current = null;
      return;
    }
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
    /** The position advertised for the duration of the current drag. */
    let held: number | null = null;
    const send = () => {
      const r = Math.max(1, Math.round(coFpsRef.current));
      const advertised = advertisedPosition(getPlayheadFrames() / r, isScrubbing(), held);
      held = advertised.held;
      const msg: SessionMsg = {
        kind: "transport",
        playing: coPlayingRef.current,
        position: advertised.position,
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
    // Settling sends AT ONCE rather than waiting out the next beat: the frame
    // the presenter stopped on is the point of the whole gesture, and up to
    // 500ms of extra wait on it is the part a viewer would call slow.
    const offScrub = subscribeScrub((active) => { if (!active) { held = null; send(); } });
    return () => { window.clearInterval(iv); offScrub(); };
  }, [isPresenter, sendSessionMsg]);
  // Everyone broadcasts their own playhead for ghost cursors: every 350ms
  // tick WHILE IT MOVES, a quiet keepalive beat while parked. The always-on
  // 3 Hz version meant a host alone in a paused room still sent (and every
  // receiver still processed) three messages a second for the whole session.
  // The prune rides the same tick and bails allocation-free when nothing
  // expired - see ghost-store.ts for the receive-side half of this.
  useEffect(() => {
    if (!coSessionActive) return;
    let lastSentPos = Number.NaN;
    let lastSentAt = 0;
    const tick = () => {
      const now = Date.now();
      const r = Math.max(1, Math.round(coFpsRef.current));
      const pos = getPlayheadFrames() / r;
      if (shouldSendPresence(lastSentPos, pos, lastSentAt, now)) {
        lastSentPos = pos;
        lastSentAt = now;
        const me = loadReviewer().name || (coRoleRef.current === "host" ? "Host" : "Guest");
        sendSessionMsg({ kind: "presence", name: me, position: pos });
      }
      pruneGhosts(now);
    };
    tick();
    const iv = window.setInterval(tick, 350);
    return () => window.clearInterval(iv);
  }, [coSessionActive, sendSessionMsg]);
  // Local echo + relay: the sender renders its own reaction immediately
  // (the host relay never echoes back to the origin).
  const sendReaction = useCallback((emote: string) => {
    const now = Date.now();
    if (now - lastReactionSendRef.current < 250) return; // per-sender throttle
    lastReactionSendRef.current = now;
    const selfId = coSessionRef.current.selfId ?? "m0";
    pushReaction({ from: selfId, name: nameForMember(selfId), emote, at: now });
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

  /**
   * Adopt whatever Rust says is true.
   *
   * The pushed `session:state` event is the normal channel; this is the pull
   * that lets the renderer RECOVER when the two have drifted, which a pushed
   * channel alone cannot do (events are dropped, not queued).
   */
  const syncSessionState = useCallback(async (): Promise<CoSessionState | null> => {
    try {
      const st = await invoke<CoSessionState>("session_state");
      setCoSession(st);
      return st;
    } catch { return null; }
  }, []);

  const startCoReview = useCallback(async (title?: string) => {
    try {
      // Host under the review identity's name (falls back to "Host" in Rust)
      // so guests see a real person heading the roster, not a role label.
      // The optional title names the SESSION (room header + peers' Welcome).
      await invoke<string>("session_start", { name: loadReviewer().name || null, title: title?.trim() || null });
    }
    catch (e) {
      // "A session is already active" means the RENDERER is out of date, not
      // that the user did anything wrong: Rust is holding a session this
      // window has stopped showing. Adopting Rust's state puts the room back
      // on screen, which is both the answer and the way out - so the failure
      // repairs itself instead of leaving a dead-end error that repeats on
      // every press.
      const st = await syncSessionState();
      if (st && st.role !== "off") {
        slog("info", "Start refused: a session was already running. Re-synced from the backend.");
        return;
      }
      pushNotification("error", "Couldn't start co-review", formatError(e));
    }
  }, [pushNotification, syncSessionState, slog]);
  const joinCoReview = useCallback(async (ticket: string, name: string, grant?: string | null) => {
    // install: lets the host hand back the SAME member id if we've been in
    // this session before, instead of adding a duplicate person tile.
    try { await invoke("session_join", { ticket, name, install: loadInstallId(), grant: grant ?? null }); }
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

  // ── The screening record ────────────────────────────────────────────
  // Three effects, all of them running for BOTH roles. Screening recording
  // used to live inside the host-only doc-seeding effect, which early-returns
  // on `role !== "host"`, so a guest left a session with NO record at all -
  // their comments survived in the per-source review doc, but nothing said
  // those notes came from a session, who else was in the room, or what else
  // the room watched.
  //
  // Each machine records what it OBSERVED. The ids are local (see
  // ScreeningDoc.id): nothing correlates two attendees' files, because nothing
  // needs to yet and inventing a shared id means putting one on the wire.

  /** The screening for this session, created on demand. */
  const ensureScreening = useCallback((): ScreeningDoc => {
    if (!screeningRef.current) {
      const s = coSessionRef.current;
      screeningRef.current = newScreening(
        crypto.randomUUID(),
        s.title || metadataRef.current?.title || "Screening",
        s.role === "host" ? "host" : "guest",
        // The SESSION's start, not this moment. See sessionStartedAtRef.
        sessionStartedAtRef.current || Date.now(),
      );
    }
    return screeningRef.current;
  }, [metadataRef]);

  /** Write through, debounced. Skips a record not yet worth keeping so a
   *  session that goes nowhere never creates a file; the predicate is
   *  monotonic (segments and participants only accumulate), so anything that
   *  becomes worth keeping is written the moment it does. */
  const saveScreeningSoon = useCallback(() => {
    if (screeningSaveRef.current) clearTimeout(screeningSaveRef.current);
    screeningSaveRef.current = setTimeout(() => {
      screeningSaveRef.current = null;
      const sc = screeningRef.current;
      if (!sc || !screeningIsWorthKeeping(sc)) return;
      void saveScreening(sc).catch((e) => {
        appendLogRef.current("warn", "session",
          `This screening could not be saved: ${formatError(e)}`);
      });
    }, 1500);
  }, []);

  // What THE ROOM watched, in order - which is not the same as what this
  // machine managed to open, and reading the second for the first left two
  // holes.
  //
  // This used to drive off `sessionSource` alone and early-return on
  // kind === "none". `sessionSource` is what THIS machine has loaded, so:
  //
  //   1. A guest who could not open the source got NO SEGMENT AT ALL. Their
  //      record said the room watched nothing, when the room watched something
  //      they were locked out of - the single most useful thing that record
  //      could have told them.
  //   2. `watched` could never be false, because the effect could not run
  //      without a resolved local source, so openSegment always set it true
  //      and markWatched was a call that could not change anything. Exactly
  //      the "declared, indexed, rendered, never actually written" shape that
  //      screening-record-contract was written about - hiding BEHIND that
  //      contract, which asks whether a production caller exists and not
  //      whether the caller can ever make the updater do work.
  //
  // `pendingSource` is what the room announced via loadSource and this machine
  // has not opened yet; it clears on success AND on failure. So the room's
  // source is the pending one if there is one, else what we have open.
  useEffect(() => {
    if (coSession.role === "off") return;
    const room = pendingSource ?? sessionSource;
    // Nothing has ever been on. Do not mint a screening for a room that has
    // not watched anything yet.
    if (room.kind === "none" && !screeningRef.current) return;
    const before = ensureScreening();
    // The local key belongs to the segment ONLY when we are actually on the
    // room's source. While a source is pending, `reviewSourceKey` still names
    // the PREVIOUS one, and handing that over would file the new segment as
    // watched, against the wrong document.
    const onIt = pendingSource == null && sessionSource.kind !== "none";
    let next = openSegment(before, room, onIt ? (reviewSourceKey || null) : null);
    // ...and this is what flips it when the guest finally lands on the source:
    // openSegment sees the same source and no-ops, then markWatched does the
    // one field. That sequence is the whole reason markWatched exists.
    if (onIt && reviewSourceKey) next = markWatched(next, reviewSourceKey);
    if (next === before) return;
    screeningRef.current = next;
    saveScreeningSoon();
    // Granular source deps, matching sendLoadSource's own effect below.
    // `sessionSource` is a fresh object on most App renders; depending on it
    // whole re-runs this on every one. openSegment returns identity for an
    // unchanged source so that was harmless, but harmless churn is still churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coSession.role, sessionSource.kind, sessionSource.url, sessionSource.fingerprint,
      sessionSource.title, sessionSource.duration, reviewSourceKey, pendingSource,
      ensureScreening, saveScreeningSoon]);

  // A pending write-through must not outlive the hook. Without this, quitting
  // during the debounce window fires a save into a torn-down renderer.
  useEffect(() => () => {
    if (screeningSaveRef.current) clearTimeout(screeningSaveRef.current);
  }, []);

  // Who was in the room. theaterParticipants is the normalised roster - the
  // host's `peers` excludes itself while a guest's includes everyone - so this
  // reads the same on both sides rather than reconstructing that difference.
  useEffect(() => {
    if (coSession.role === "off") return;
    const before = ensureScreening();
    const next = noteParticipants(
      before,
      theaterParticipants.map((p) => ({ name: p.name, isHost: p.isHost })),
    );
    if (next === before) return;
    screeningRef.current = next;
    saveScreeningSoon();
  }, [coSession.role, theaterParticipants, ensureScreening, saveScreeningSoon]);

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

  // ── Live view of the presenter's monitor ──────────────────────────
  // The bridge that makes a shared asset feel instant: a guest without the
  // file sees the presenter's own picture in about a second, while the real
  // bytes are still moving. It rides the SAME mesh senders as screen share,
  // so the two are mutually exclusive by construction rather than by rule.
  const [viewerShareState, setViewerShareState] = useState<ViewerShareState>("off");
  const viewerShareRef = useRef<ViewerShareController | null>(null);
  if (!viewerShareRef.current) {
    viewerShareRef.current = new ViewerShareController({
      getElement: () => playerRef.current?.getCaptureElement?.() ?? null,
      setOverride: (t) => meshOverrideRef.current(t),
      setAudioOverride: (t) => meshAudioOverrideRef.current(t),
      // The same "sharing" message screen share sends, so a guest's tile
      // already knows how to label a live view rather than needing a second
      // concept it would have to learn.
      announce: (on) => {
        const msg = { kind: "sharing", from: coRoleRef.current === "host" ? "m0" : "", on };
        const cmd = coRoleRef.current === "host" ? "session_broadcast" : "session_send";
        void invoke(cmd, { msg }).catch(() => { /* session raced closed */ });
      },
      onChange: (st) => setViewerShareState(st),
      log: (tag, msg) => slog(tag === "err" ? "err" : "warn", msg),
    });
  }
  const startViewerShare = useCallback(() => {
    const ok = viewerShareRef.current?.start() ?? false;
    if (!ok) {
      pushNotification("info", "Nothing to show live yet",
        "Play the source for a moment, then try again. Sending them the file always works.");
    }
    return ok;
  }, [pushNotification]);
  const stopViewerShare = useCallback(() => { viewerShareRef.current?.stop(); }, []);
  /* The source changed under a live view. Re-capture: the old element belongs
     to something nobody is watching, and an engine that reuses its element
     would otherwise send the NEW picture under the OLD announcement. */
  const sharedSourceRef = useRef<string | null>(null);
  useEffect(() => {
    const now = activeSourceUrlRef.current ?? null;
    if (sharedSourceRef.current === now) return;
    sharedSourceRef.current = now;
    viewerShareRef.current?.resync();
  });

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
  /** Set by the app, because WHERE a received file goes is a preference and
   *  this hook does not read preferences. */
  const placeReceivedRef = useRef<((path: string, name: string) => Promise<void>) | null>(null);
  useEffect(() => {
    const un = listen<TransferProgress>("session:transfer", (e) => {
      const p = e.payload;
      setTransfer(p);
      if (transferClearRef.current) window.clearTimeout(transferClearRef.current);
      if (p.phase === "done" || p.phase === "sent" || p.phase === "cancelled") {
        transferClearRef.current = window.setTimeout(() => setTransfer(null), 4000);
      }
      // WHERE IT LANDS. The transfer itself always writes into the cache's
      // transfers/ dir, because that is where resume, the running hash and
      // cancel all work from, and re-pointing the streaming write would put
      // a half-file somewhere the size cap deliberately does not sweep.
      // Placing it is a separate, verified step at the end.
      if (p.phase === "done" && p.path) {
        void placeReceivedRef.current?.(p.path, p.name);
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
      /* Remember which review this file belongs to. Without it a guest's notes
         are filed under the host's reviewKey during the session and read back
         under a path-derived key afterwards, so reopening the film shows an
         empty review while the notes sit on disk under a key nothing looks up.
         The fingerprint index cannot cover this: the guest has no metadata yet
         here, so it cannot compute its own fingerprint to link, and the copy's
         filename carries a <hash8>- prefix that changes it anyway. */
      if (pending?.reviewKey) rememberReceivedAs(path, pending.reviewKey);
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
  /**
   * The file we are streaming, held so a copy can be started LATER.
   *
   * `setKeepTarget` is what begins the Tier C write. Watching no longer does
   * it automatically, so the details have to survive until the guest asks.
   */
  const keepCandidateRef = useRef<{
    blake3: string; name: string; total: number; fingerprint: string | null;
  } | null>(null);

  /** Start saving a copy of what is already playing. The optional half. */
  const keepOfferedCopy = useCallback(() => {
    const c = keepCandidateRef.current;
    if (!c) return;
    setKeepTarget(c);
    slog("info", `Saving a copy of "${c.name}" while you watch.`);
  }, [slog]);

  const watchOfferedStream = useCallback(async (opts?: { keepCopy?: boolean }) => {
    const offer = offeredFileRef.current;
    if (!offer) return;
    const pending = pendingSourceRef.current;
    try {
      await loadPeerStream(
        { name: offer.name, blake3: offer.blake3, vcodec: offer.vcodec, acodec: offer.acodec },
        { title: pending?.title ?? offer.name, duration: pending?.duration ?? null },
      );
      // The keep CANDIDATE, captured whether or not we start a copy now.
      //
      // Watching used to imply a multi-GB write with no way to decline it, so
      // the only way to see what somebody was showing you was to accept their
      // file onto your disk. Those are two different decisions and this splits
      // them: the stream starts on its own, and the copy is offered.
      //
      // Captured HERE because pendingSource is cleared below and it is the
      // only place the fingerprint still exists. Without it a landed copy is
      // un-indexed, and the next session re-streams a file already on disk -
      // the exact thing Tier A exists to prevent.
      const candidate = {
        blake3: offer.blake3, name: offer.name, total: offer.size,
        fingerprint: pending?.fingerprint ?? null,
      };
      keepCandidateRef.current = candidate;
      if (opts?.keepCopy) setKeepTarget(candidate);
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
  const [stageRecording, setStageRecording] = useState(false);
  const [lastRecording, setLastRecording] = useState<RecordingResult | null>(null);

  /** Tell the room. Safe outside a session: it is a no-op there. */
  const announceRecording = useCallback((what: string, on: boolean) => {
    if (coRoleRef.current === "off") return;
    void trySendSessionMsg({ kind: "recording", from: "", what, on }).catch(() => {});
  }, [trySendSessionMsg]);

  const startStageRecording = useCallback(async (title: string | null) => {
    try {
      // The window id is found by the backend, not passed from here: a
      // CGWindowID is not something the renderer can know, and asking the
      // capture engine which window belongs to our pid is the only honest way
      // to get it.
      const windowId = await invoke<number>("recording_own_window");
      await invoke<RecordingHandle>("recording_start", { windowId, title });
      setStageRecording(true);
      announceRecording("stage", true);
    } catch (e) {
      pushNotification("error", "Couldn't start recording", formatError(e));
    }
  }, [announceRecording, pushNotification]);

  const stopStageRecording = useCallback(async () => {
    try {
      const res = await invoke<RecordingResult>("recording_stop");
      setLastRecording(res);
    } catch (e) {
      pushNotification("error", "Couldn't finish the recording", formatError(e));
    } finally {
      // Local state and the announcement clear even if finalizing complained:
      // a red light that stays on after the recording has stopped is worse
      // than a missing file, because it is a lie about what is happening.
      setStageRecording(false);
      announceRecording("stage", false);
    }
  }, [announceRecording, pushNotification]);

  // What is ALREADY recording, asked once on mount. Same reason session state
  // is asked for: a reload cannot be told by a pushed event about something
  // that started before it existed, and a recording outlives a reload.
  useEffect(() => {
    void invoke<RecordingHandle | null>("recording_status")
      .then((h) => { if (h) setStageRecording(true); })
      .catch(() => { /* older backend, or nothing recording */ });
  }, []);

  /**
   * PRUNE AGAINST THE ROSTER, which `sharing` and `hand` both fail to do.
   *
   * Neither of those is ever pruned; they clear only when the whole session
   * ends. Rust holds no per-member flag state either, and member ids are
   * reclaimed by install id - so a peer that drops while flagged and rejoins
   * comes back still flagged. For "Sharing screen" that is cosmetic. For a
   * recording light it is a lie about whether someone is being recorded.
   */
  useEffect(() => {
    const live = new Set(coSession.peers.map((p) => p.id));
    const keep = (prev: ReadonlySet<string>) => {
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    };
    setRecordingMembers(keep);
    setStageRecorders(keep);
  }, [coSession.peers]);

  // RE-ANNOUNCE ON ROSTER GROWTH, per member. The existing re-sync is
  // host-only and self-only, so "guest B is recording, guest C joins" told C
  // nothing. Each member re-sends its OWN flag; the host cannot do it on
  // anyone's behalf, because session_broadcast rewrites `from` to m0.
  const peerCountRef = useRef(0);
  useEffect(() => {
    const n = coSession.peers.length;
    const grew = n > peerCountRef.current;
    peerCountRef.current = n;
    if (grew && stageRecording) announceRecording("stage", true);
  }, [coSession.peers.length, stageRecording, announceRecording]);

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
    coSession, coSessionActive, sessionDoc, postSessionOp,
    // Live shared drawing: the room's scratch surface before anyone posts.
    liveDraw, postDrawOp, clearLiveDraw, pruneLiveDraw,
    theater, setTheater, theaterParticipants,
    meshStreams: mesh.remoteStreams, meshStates: mesh.peerStates,
    meshMutedForMe: mesh.peerMutedForMe, toggleMuteForMe: mesh.toggleMuteForMe,
    shareState, shareStream, sharingMembers, startShare, stopShare,
    recordingMembers, stageRecorders, stageRecording, lastRecording,
    startStageRecording, stopStageRecording,
    viewerShareState, startViewerShare, stopViewerShare,
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
    keepOfferedCopy,
    placeReceivedRef,
    canKeepCopy: keepCandidateRef.current != null && keepTarget == null,
    cancelFetch,
    handRaised: coSession.selfId != null ? raisedHands.has(coSession.selfId) : raisedHands.has("m0"),
    sendReaction,
    toggleHand,
    startCoReview, joinCoReview, leaveCoReview,
    /** Notes written that nobody has received yet. */
    outboxDepth,
    /** A code from a clicked link, for the lobby to pre-fill. */
    pendingJoinCode, clearPendingJoinCode: () => setPendingJoinCode(null),
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
  /** Host moved AT ALL (beyond clock jitter) since that heartbeat. A paused
   *  frame-step is 0.033-0.042s - an order of magnitude under the scrub
   *  threshold - so gating the paused chase on hostScrubbed alone meant the
   *  core review gesture, stepping to THE frame, never reached guests: the
   *  room silently reviewed different frames while the UI said "frame
   *  accurate". The no-op branch commits the host position, so steps never
   *  accumulated past the threshold either. */
  hostStepped: boolean;
  /** ms since our last chase seek. Guards against a correction storm: a seek
   *  takes time to land (a web seek rebuilds the whole ffmpeg stream), and
   *  measuring drift mid-seek produces another seek. */
  sinceLastChaseMs: number;
  /** The position the LAST chase asked for, or null if none is outstanding.
   *  A web seek rebuilds the whole ffmpeg pipeline and takes seconds; the
   *  cooldown is one. Without this the chase re-orders the same position it
   *  is already waiting on, and each re-order tears down the rebuild that was
   *  about to deliver the picture - so a guest never settles and the monitor
   *  stays on .cp-monitor's own black. */
  pendingChaseSeconds: number | null;
};
/**
 * What position a presenter should ADVERTISE, given where the playhead really
 * is and whether the user is mid-drag.
 *
 * Holding the pre-drag position is the whole idea: guests stay parked on the
 * frame the room was already looking at, then make ONE seek to wherever the
 * presenter stopped. Sending the live position instead spends each guest a
 * stream rebuild per beat on frames nobody chose to look at, and the chosen
 * frame - the only one that matters - arrives behind all of them.
 *
 * Pure so the rule is testable without a session; the caller owns `held`.
 */
export function advertisedPosition(
  live: number, scrubbing: boolean, held: number | null,
): { position: number; held: number | null } {
  if (!scrubbing) return { position: live, held: null };
  const h = held ?? live;
  return { position: h, held: h };
}

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
  // ALREADY ON THE WAY THERE. Re-issuing a seek we have not landed yet is not
  // a correction, it is a restart: on a web source it throws away the pipeline
  // rebuild that was about to produce the frame. Only a target that has MOVED
  // is worth a new seek; one within tolerance of what we already asked for is
  // the same instruction arriving twice.
  const stillHeadingThere = i.pendingChaseSeconds != null
    && Math.abs(i.expectedSeconds - i.pendingChaseSeconds) <= PLAYING_TOLERANCE_SEC
    && Math.abs(i.curSeconds - i.pendingChaseSeconds) > 0.02;
  if (stillHeadingThere && !i.justLoaded) return { seekSeconds: null, commitHostPos: true };
  if (i.playing) {
    const drift = Math.abs(i.curSeconds - i.expectedSeconds);
    return {
      seekSeconds: !cooling && drift > PLAYING_TOLERANCE_SEC ? i.expectedSeconds : null,
      commitHostPos: true,
    };
  }
  if (cooling) return { seekSeconds: null, commitHostPos: true };
  // Paused: jump when the host MOVED - a scrub or a single frame-step alike -
  // and stay parked when the host is static, so a paused guest glancing at a
  // nearby frame is never yanked back by a motionless presenter. The drift
  // gate is half a frame at 24fps: fine enough that every step lands, coarse
  // enough that a guest already on the host's frame is left alone.
  if (i.justLoaded || (i.hostStepped && Math.abs(i.curSeconds - i.expectedSeconds) > 0.02)) {
    return { seekSeconds: i.expectedSeconds, commitHostPos: true };
  }
  return { seekSeconds: null, commitHostPos: true };
}
