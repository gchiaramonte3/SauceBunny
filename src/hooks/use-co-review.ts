// useCoReview — the P2P co-review session (r100 transport, r101 live review)
// + screening mode, extracted whole from App.tsx following the use-panel-bus /
// use-web-playback shape: one cohesive subsystem out of the God-component,
// vanilla hooks, no state library. Same effects, same dependency arrays, same
// refs as the inline original — the cross-window events and Rust session
// commands (commands/session.rs) are untouched.
//
// Architecture: Rust owns the iroh endpoint as a dumb relay; the frontend is
// the review source-of-truth. Host: broadcasts source + a 2 Hz transport
// heartbeat + a review-doc snapshot on each join + its own comment ops.
// Peer: follows the host playhead, adopts the shared doc, and sends its own
// comment ops up (the host relays them to everyone). WEB-ONLY — a local file
// can't be pushed to peers, so hosting is gated to web sources.

import {
  useCallback, useEffect, useMemo, useRef, useState,
  type Dispatch, type MutableRefObject, type RefObject, type SetStateAction,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatError } from "../lib/error-format";
import { getLastUserSeekAt, getPlayheadFrames } from "../lib/playhead-store";
import {
  loadReview, saveReview, ensureVersion, applyReviewOp, mergeReviewDoc,
  commentMarkers as reviewMarkersOf, annotationsOf,
  loadReviewer, reviewerColorFor, initialsOf,
  type AnnotationStrokes, type ReviewDoc, type ReviewOp,
} from "../lib/review";
import type { PlayerHandle } from "../components/player-handle";
import type { Participant } from "../components/PeoplePanel";
import type { ToastKind } from "../components/CanvasToast";
import type { Metadata } from "../types";
import type { SessionMsg } from "../bindings/SessionMsg";
import type { SessionState as CoSessionState } from "../bindings/SessionState";
import { useRtcMesh, type TurnConfig } from "./use-rtc-mesh";
import type { MeshPeerState } from "../lib/rtc-mesh";
import { ShareController, type ShareState } from "../lib/share-machine";
import { openShareStream } from "../lib/share-stream";

/** Timeline/monitor read-model of one review comment marker. Shared by the
 *  solo path (App's local-review reload effect) and the session path (the
 *  shared-doc projection below) — both write the same App-owned state. */
export type ReviewMarkerView = {
  id: string; time: number; timeEnd: number | null; resolved: boolean;
  color: string; initials: string;
};
/** Same read-model for drawn annotations (author-tinted). */
export type ReviewAnnotationView = {
  id: string; time: number; color: string; strokes: AnnotationStrokes;
};

type Args = {
  /** Live transport values — mirrored into refs for the interval senders.
   *  (The playhead is NOT passed: it lives in lib/playhead-store, and the
   *  heartbeat/presence/chase read getPlayheadFrames() when they fire — a
   *  render-mirrored ref would go stale now that playback ticks don't
   *  re-render App.) */
  isPlaying: boolean;
  fps: number;
  /** Committed web-source URL (null = none/local). The host pushes it to peers. */
  activeSourceUrl: string | null;
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
  pushNotification: (kind: ToastKind, title: string, body: string) => void;
  /** Screening auto-enter also opens the drawer (comments live there). */
  setQueueOpen: (open: boolean) => void;
  /** Session projection sinks — while in a session the shared doc drives the
   *  same marker state App's solo reload writes, so every participant's
   *  timeline shows everyone's live comments. */
  setReviewMarkers: (markers: ReviewMarkerView[]) => void;
  setReviewAnnotations: (annotations: ReviewAnnotationView[]) => void;
  /** Optional TURN relay for the webcam mesh (Settings; empty = STUN only). */
  turn: TurnConfig;
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
  screening: boolean;
  setScreening: Dispatch<SetStateAction<boolean>>;
  screeningParticipants: Participant[];
  /** Live remote camera/mic streams from the webcam mesh, keyed by member id. */
  meshStreams: ReadonlyMap<string, MediaStream>;
  /** Per-member mesh connection state (connecting / live / failed). */
  meshStates: ReadonlyMap<string, MeshPeerState>;
  /** Screen share (native ffmpeg pipeline; v1 replaces your camera tile). */
  shareState: ShareState;
  shareStream: MediaStream | null;
  /** Member ids currently flagged as sharing (tile badges). */
  sharingMembers: ReadonlySet<string>;
  startShare: (displayIndex: number) => void;
  stopShare: () => void;
  startCoReview: () => Promise<void>;
  joinCoReview: (ticket: string, name: string) => Promise<void>;
  leaveCoReview: () => void;
};

export function useCoReview({
  isPlaying, fps,
  activeSourceUrl, activeSourceUrlRef, reviewSourceKey,
  playerRef, metadataRef,
  onChaseSeek, setUrl, handleFetch,
  pushNotification, setQueueOpen,
  setReviewMarkers, setReviewAnnotations,
  turn,
}: Args): CoReview {
  const [coSession, setCoSession] = useState<CoSessionState>({ role: "off", code: null, peers: [], selfId: null, error: null });
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
  const coRoleRef = useRef("off"); coRoleRef.current = coSession.role;
  const coLastHostPosRef = useRef<number | null>(null);
  const coReadyRef = useRef(false); // has OUR player loaded the host's source yet?

  // Send a session message the right way for our role: the host broadcasts to
  // all peers; a peer sends up to the host, which relays it to everyone else.
  const sendSessionMsg = useCallback((msg: SessionMsg) => {
    const cmd = coRoleRef.current === "host" ? "session_broadcast" : "session_send";
    void invoke(cmd, { msg }).catch(() => {});
  }, []);

  // Apply a review op to the shared doc + relay it (called by the Review panel
  // for every mutation while in session). Optimistic: apply locally now and
  // send; the host relays to all-but-sender so we never receive our own op back.
  const postSessionOp = useCallback((op: ReviewOp) => {
    setSessionDoc((prev) => (prev ? applyReviewOp(prev, op) : prev));
    sendSessionMsg({ kind: "reviewOp", op: JSON.stringify(op) });
  }, [sendSessionMsg]);

  // Latest-closure ref so the once-registered session:msg listener never stales.
  const coApplyRef = useRef<(m: SessionMsg) => void>(() => {});
  coApplyRef.current = (m) => {
    switch (m.kind) {
      case "loadSource":
        if (activeSourceUrlRef.current !== m.url) {
          // The source is changing under us — we're not synced to it until our
          // own player reports ready for the NEW source. Re-arm here so a
          // stale-ready old player can't apply the host's transport to the
          // wrong video, and the snap-to-host fires on the first ready tick.
          coReadyRef.current = false;
          setUrl(m.url);
          void handleFetch(m.url);
        }
        return;
      case "reviewDoc":
        // MERGE, not blind-replace: the host re-broadcasts a full snapshot on
        // every join, and an existing peer may have an in-flight op not yet in
        // that snapshot — mergeReviewDoc keeps it (and unions likes) so no
        // comment/edit silently vanishes.
        try {
          const incoming = JSON.parse(m.doc) as ReviewDoc;
          setSessionDoc((prev) => (prev ? mergeReviewDoc(prev, incoming) : incoming));
        } catch { /* malformed snapshot */ }
        return;
      case "reviewOp":
        try {
          const op = JSON.parse(m.op) as ReviewOp;
          setSessionDoc((prev) => (prev ? applyReviewOp(prev, op) : prev));
        } catch { /* malformed op */ }
        return;
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
        const r = Math.max(1, Math.round(coFpsRef.current));
        const expected = m.position + (m.playing ? (Math.max(0, Date.now() - m.atMs) / 1000) * m.rate : 0);
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
        });
        if (decision.commitHostPos) {
          coLastHostPosRef.current = m.position;
        } else if (import.meta.env.DEV && Math.abs(cur - expected) > 0.5) {
          console.info("[co-review] chase yielded to a local seek", { cur, expected });
        }
        if (decision.seekSeconds != null) onChaseSeek(Math.floor(decision.seekSeconds * r));
        if (m.playing !== coPlayingRef.current) {
          if (m.playing) p.play(); else p.pause();
        }
        return;
      }
    }
  };
  useEffect(() => {
    const unState = listen<CoSessionState>("session:state", (e) => setCoSession(e.payload));
    const unMsg = listen<SessionMsg>("session:msg", (e) => coApplyRef.current(e.payload));
    return () => { unState.then((f) => f()); unMsg.then((f) => f()); };
  }, []);
  // Host seeds the shared doc from its local review of the current source on
  // start; persists the collaborative doc for everyone on end.
  const prevCoRoleRef = useRef("off");
  useEffect(() => {
    const prev = prevCoRoleRef.current;
    prevCoRoleRef.current = coSession.role;
    if (coSession.role === "host" && prev !== "host" && reviewSourceKey) {
      const { doc } = ensureVersion(loadReview(reviewSourceKey), reviewSourceKey, metadataRef.current?.title ?? undefined);
      setSessionDoc(doc);
    }
    if (coSession.role === "off" && prev !== "off") {
      const d = sessionDocRef.current;
      if (d && d.comments.length > 0 && d.sourceKey) saveReview(d); // everyone keeps the review
      setSessionDoc(null);
      setCoGhosts([]);
      coLastHostPosRef.current = null;
      coReadyRef.current = false;
    }
  }, [coSession.role, reviewSourceKey]);
  // Host → peers: current source whenever it changes (web only — a local file
  // has no activeSourceUrl so nothing is pushed).
  useEffect(() => {
    if (coSession.role !== "host" || !activeSourceUrl) return;
    void invoke("session_broadcast", { msg: { kind: "loadSource", url: activeSourceUrl } }).catch(() => {});
  }, [coSession.role, activeSourceUrl]);
  // Host → new joiner: source + a fresh doc snapshot when the peer count rises.
  // Fanned to all; existing peers harmlessly re-adopt the identical doc.
  const prevPeerCountRef = useRef(0);
  useEffect(() => {
    const prev = prevPeerCountRef.current;
    prevPeerCountRef.current = coSession.peers.length;
    if (coSession.role !== "host" || coSession.peers.length <= prev) return;
    if (activeSourceUrlRef.current) {
      void invoke("session_broadcast", { msg: { kind: "loadSource", url: activeSourceUrlRef.current } }).catch(() => {});
    }
    const d = sessionDocRef.current;
    if (d) void invoke("session_broadcast", { msg: { kind: "reviewDoc", doc: JSON.stringify(d) } }).catch(() => {});
  }, [coSession.role, coSession.peers.length]);
  // Host → peers: 2 Hz transport heartbeat (play/pause/seek/scrub-settle).
  useEffect(() => {
    if (coSession.role !== "host") return;
    const send = () => {
      const r = Math.max(1, Math.round(coFpsRef.current));
      const msg: SessionMsg = {
        kind: "transport",
        playing: coPlayingRef.current,
        position: getPlayheadFrames() / r,
        rate: 1,
        atMs: Date.now(),
        seq: ++coSeqRef.current,
      };
      void invoke("session_broadcast", { msg }).catch(() => {});
    };
    send();
    const iv = window.setInterval(send, 500);
    return () => window.clearInterval(iv);
  }, [coSession.role]);
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
  const startCoReview = useCallback(async () => {
    try {
      // Host under the review identity's name (falls back to "Host" in Rust)
      // so guests see a real person heading the roster, not a role label.
      await invoke<string>("session_start", { name: loadReviewer().name || null });
    }
    catch (e) { pushNotification("error", "Couldn't start co-review", formatError(e)); }
  }, [pushNotification]);
  const joinCoReview = useCallback(async (ticket: string, name: string) => {
    try { await invoke("session_join", { ticket, name }); }
    catch (e) { pushNotification("error", "Couldn't join session", formatError(e)); }
  }, [pushNotification]);
  const leaveCoReview = useCallback(() => { void invoke("session_leave").catch(() => {}); }, []);

  // ── Screening mode (Louper-style cinematic watch-party layout) ──────
  // A reflow of the EXISTING body (participant rail ← sidebar, cinematic
  // viewport, comments) — never a new tree, so the player is not remounted
  // and the session/playback keep running. Auto-enters when a session starts,
  // auto-exits when it ends; the rail's "Exit" drops back to editing while the
  // session stays live (re-enter from the co-review popover).
  const [screening, setScreening] = useState(false);
  const prevScreenSessionRef = useRef(false);
  useEffect(() => {
    const was = prevScreenSessionRef.current;
    prevScreenSessionRef.current = coSessionActive;
    // Entering a session lands in the ROOM (theater is an opt-in sub-mode
    // now, not the entry experience); the drawer opens for comments.
    if (coSessionActive && !was) setQueueOpen(true);
    if (!coSessionActive && was) setScreening(false);
  }, [coSessionActive]);
  // Everyone in the session, for the rail — so people see each other. Host's
  // roster is peers-only (its own name is local); a peer's roster is the full
  // list the host broadcast (Host + peers, self found by name).
  const screeningParticipants = useMemo(() => {
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
  }, [coSession.role, coSession.peers]);

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
  }, [sessionDoc]);

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
  const memberIds = useMemo(
    () => screeningParticipants.filter((p) => !p.isSelf).map((p) => p.id),
    [screeningParticipants],
  );
  const mesh = useRtcMesh({
    active: coSessionActive,
    selfId,
    role: coSession.role,
    memberIds,
    turn,
    onLog: (tag, msg) => {
      if (tag === "err") console.error("[co-review rtc]", msg);
      else if (tag === "warn") console.warn("[co-review rtc]", msg);
    },
  });
  rtcSignalRef.current = mesh.handleSignal;

  // ── Screen share controller (pure machine; pipeline injected) ────
  // Every ending - bar button, session end, ffmpeg death - converges on
  // the same cleanup: camera restored, peers un-flagged, child stopped.
  const shareRef = useRef<ShareController | null>(null);
  const meshOverrideRef = useRef(mesh.setVideoOverride);
  meshOverrideRef.current = mesh.setVideoOverride;
  if (!shareRef.current) {
    shareRef.current = new ShareController({
      start: (i) => invoke<string>("start_screen_share", { displayIndex: i }),
      stopPipeline: () => invoke("stop_screen_share").then(() => undefined),
      open: openShareStream,
      setOverride: (t) => meshOverrideRef.current(t),
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
    });
  }
  const startShare = useCallback((displayIndex: number) => { void shareRef.current?.start(displayIndex); }, []);
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
    screening, setScreening, screeningParticipants,
    meshStreams: mesh.remoteStreams, meshStates: mesh.peerStates,
    shareState, shareStream, sharingMembers, startShare, stopShare,
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
};
export type ChaseDecision = {
  /** Seconds to seek to, or null to leave the playhead alone. */
  seekSeconds: number | null;
  /** Whether to record the host position as "seen". A yielded heartbeat
   *  must NOT commit it — the scrub edge has to survive the latch window. */
  commitHostPos: boolean;
};
export function decideChase(i: ChaseInput): ChaseDecision {
  if (i.localSeekHot && !i.justLoaded) return { seekSeconds: null, commitHostPos: false };
  if (i.playing) {
    return {
      seekSeconds: Math.abs(i.curSeconds - i.expectedSeconds) > 0.5 ? i.expectedSeconds : null,
      commitHostPos: true,
    };
  }
  // Paused: only jump when the host actually scrubbed (or we just loaded) —
  // a paused guest glancing at a nearby frame must not be yanked back.
  if (i.justLoaded || (i.hostScrubbed && Math.abs(i.curSeconds - i.expectedSeconds) > 0.1)) {
    return { seekSeconds: i.expectedSeconds, commitHostPos: true };
  }
  return { seekSeconds: null, commitHostPos: true };
}
