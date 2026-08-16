import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RtcMesh, type MeshPeerState, type MeshSignalPayload } from "../lib/rtc-mesh";
import { getSessionCapture, subscribeSessionCapture } from "./use-media-capture";
import {
  SESSION_VOLUME_CHANGED_EVENT, SPEAKER_OUTPUT_CHANGED_EVENT,
  canPickSpeakers, loadDeviceChoice, loadSessionVolume,
} from "../lib/media-devices";
import { buildIceServers, type TurnConfig } from "../lib/ice-servers";

/** Route one session-voice element to the chosen output (WebKit 18.4+;
 *  silently a no-op elsewhere or on "system default"). */
function applySpeaker(el: HTMLAudioElement): void {
  if (!canPickSpeakers()) return;
  // "" = the system default sink, so switching BACK to default re-routes too.
  const id = loadDeviceChoice().speakerId ?? "";
  void (el as HTMLAudioElement & { setSinkId(id: string): Promise<void> })
    .setSinkId(id).catch(() => { /* device gone - default output */ });
}

/** Session output volume (Settings > Camera & Mic) on one voice element. */
function applyVolume(el: HTMLAudioElement): void {
  el.volume = loadSessionVolume().output;
}

/**
 * Browser wrapper around the pure RtcMesh core (lib/rtc-mesh.ts): real
 * RTCPeerConnection, signaling over the iroh star (SessionMsg::Rtc via
 * session_broadcast for the host / session_send for a peer), remote voice
 * through one hidden <audio> element per peer (NOT attached to the DOM -
 * the stage <video> stays the app's only media clock), and the green-room
 * capture wired in via the use-media-capture singleton (device switch =
 * replaceTrack on every sender).
 *
 * Consumed by use-co-review: it owns WHEN the mesh runs (session live +
 * self id known) and feeds incoming Rtc lines into handleSignal.
 */
export type { TurnConfig } from "../lib/ice-servers";

export function useRtcMesh(args: {
  active: boolean;
  selfId: string | null;
  role: string; // "off" | "host" | "peer"
  memberIds: { id: string; epoch: number }[];
  turn: TurnConfig;
  /** STUN server for reflexive candidates; "" contacts nobody (LAN + TURN
   *  only). See lib/ice-servers for what this reveals and to whom. */
  stunUrl: string;
  onLog: (tag: "info" | "warn" | "err", msg: string) => void;
}) {
  const { active, selfId, role, memberIds, turn, stunUrl, onLog } = args;
  const { url: turnUrl, username: turnUser, password: turnPass } = turn;
  const [remoteStreams, setRemoteStreams] = useState<ReadonlyMap<string, MediaStream>>(new Map());
  const [peerStates, setPeerStates] = useState<ReadonlyMap<string, MeshPeerState>>(new Map());
  // Per-peer LOCAL mute (People tile "Mute for me"): flips the hidden voice
  // element's muted flag on THIS machine only. A social-safe control - the
  // remote person is never actually muted and never notified. The ref copy is
  // read by onRemoteStream so a re-published stream (track added/removed
  // mid-call) re-applies the choice to the recreated element.
  const [peerMutedForMe, setPeerMutedForMe] = useState<ReadonlySet<string>>(new Set());
  const peerMutedForMeRef = useRef(peerMutedForMe);
  peerMutedForMeRef.current = peerMutedForMe;
  const meshRef = useRef<RtcMesh | null>(null);
  const audioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const roleRef = useRef(role);
  useEffect(() => { roleRef.current = role; }, [role]);
  // Read during mesh construction, so a rebuilt mesh starts with the roster it
  // should already have. Kept current on every render, not in an effect: the
  // construction effect must never see a roster one render stale.
  const memberIdsRef = useRef(memberIds);
  memberIdsRef.current = memberIds;

  // Speaker choice changed in settings: re-route every live voice element.
  useEffect(() => {
    const onChange = () => { for (const el of audioRef.current.values()) applySpeaker(el); };
    window.addEventListener(SPEAKER_OUTPUT_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SPEAKER_OUTPUT_CHANGED_EVENT, onChange);
  }, []);
  // Session output volume changed: re-apply to every live voice element.
  useEffect(() => {
    const onChange = () => { for (const el of audioRef.current.values()) applyVolume(el); };
    window.addEventListener(SESSION_VOLUME_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SESSION_VOLUME_CHANGED_EVENT, onChange);
  }, []);
  const onLogRef = useRef(onLog);
  useEffect(() => { onLogRef.current = onLog; }, [onLog]);

  const stopAudio = (id: string) => {
    const el = audioRef.current.get(id);
    if (el) {
      el.pause();
      el.srcObject = null;
      audioRef.current.delete(id);
    }
  };

  // Mesh lifecycle: build when the session is live and we know who we are;
  // full teardown (every PC closed, every voice stopped) when it ends.
  useEffect(() => {
    if (!active || !selfId) return;
    // Rebuilt from the FIELDS, not from `turn` itself. App composes that
    // object inline on every render, so depending on its identity would tear
    // the whole mesh down and rebuild it on any unrelated re-render - every
    // participant's video dropping several times a second. The deps below
    // are primitives for the same reason.
    const iceServers = buildIceServers(stunUrl, { url: turnUrl, username: turnUser, password: turnPass });
    const mesh = new RtcMesh({
      selfId,
      iceServers,
      createPc: (config) => new RTCPeerConnection(config),
      createStream: () => new MediaStream(),
      sendSignal: (to, payload) => {
        const msg = { kind: "rtc", from: selfId, to, payload: JSON.stringify(payload) };
        const cmd = roleRef.current === "host" ? "session_broadcast" : "session_send";
        void invoke(cmd, { msg }).catch(() => { /* session raced closed */ });
      },
      onRemoteStream: (id, stream) => {
        setRemoteStreams((prev) => {
          const next = new Map(prev);
          if (stream) next.set(id, stream); else next.delete(id);
          return next;
        });
        // The mesh now publishes ONE accumulating stream per peer, so this
        // fires again as each track lands (and again when one ends). Attaching
        // is idempotent; the no-audio branch covers both "peer gone" and "peer
        // muted their mic away entirely".
        if (stream && stream.getAudioTracks().length > 0) {
          let el = audioRef.current.get(id);
          if (!el) {
            el = document.createElement("audio");
            el.autoplay = true;
            applySpeaker(el);
            applyVolume(el);
            el.muted = peerMutedForMeRef.current.has(id);
            audioRef.current.set(id, el);
          }
          if (el.srcObject !== stream) el.srcObject = stream;
          el.play().catch(() => { /* resumes on user gesture */ });
        } else {
          stopAudio(id);
        }
      },
      onState: (id, state) => {
        // "Tile stuck on Connecting" is the single most-reported session
        // symptom and it has several unrelated causes; the transition log is
        // what separates "never negotiated" from "connected then failed".
        onLogRef.current(state === "failed" ? "err" : "info", `peer ${id}: ${state}`);
        setPeerStates((prev) => new Map(prev).set(id, state));
      },
      getLocalStream: () => getSessionCapture(),
      log: (tag, msg) => onLogRef.current(tag, msg),
    });
    meshRef.current = mesh;
    const els = audioRef.current;
    // Seed the roster HERE, not only from the effect below. This effect also
    // reruns when the TURN fields change (Settings, per keystroke), and the
    // roster effect is keyed on `memberIds` - which does NOT change when a
    // mesh is rebuilt. So editing TURN mid-session closed every connection and
    // left the replacement with an empty roster: all tiles stuck "Connecting"
    // with no recovery short of rejoining. setMembers is idempotent.
    onLogRef.current("info",
      `mesh up: self=${selfId} role=${roleRef.current} `
      // Both, not just TURN: STUN is switchable now, and "nobody can see
      // anybody" with an empty STUN field on a routed network is exactly the
      // report this line has to be able to explain.
      + `stun=${stunUrl.trim() ? "on" : "off"} turn=${turnUrl.trim() ? "configured" : "none"} `
      + `roster=[${memberIdsRef.current.map((m) => `${m.id}@${m.epoch}`).join(",")}]`);
    mesh.setMembers(memberIdsRef.current);
    const unsub = subscribeSessionCapture((s) => { void mesh.replaceLocalStream(s); });
    return () => {
      unsub();
      mesh.close();
      meshRef.current = null;
      // Snapshot the map identity for the cleanup rather than reading
      // audioRef.current at teardown time, which may already point elsewhere.
      for (const id of [...els.keys()]) stopAudio(id);
      setRemoteStreams(new Map());
      setPeerStates(new Map());
    };
  }, [active, selfId, stunUrl, turnUrl, turnUser, turnPass]);

  // Roster reconciliation on every membership change.
  useEffect(() => {
    meshRef.current?.setMembers(memberIds);
  }, [memberIds]);

  /** Screen share: route the share track to every peer (null = camera). */
  const setVideoOverride = useCallback((track: MediaStreamTrack | null) => {
    void meshRef.current?.setVideoOverride(track);
  }, []);

  /** Share audio: the share+mic mix to every peer (null = mic only). */
  const setAudioOverride = useCallback((track: MediaStreamTrack | null) => {
    void meshRef.current?.setAudioOverride(track);
  }, []);

  /** Incoming SessionMsg::Rtc line (already addressed to us). */
  const handleSignal = useCallback((from: string, payloadJson: string) => {
    try {
      const payload = JSON.parse(payloadJson) as MeshSignalPayload;
      void meshRef.current?.handleSignal(from, payload);
    } catch { /* malformed signaling line */ }
  }, []);

  const toggleMuteForMe = useCallback((id: string, muted: boolean) => {
    setPeerMutedForMe((prev) => {
      const next = new Set(prev);
      if (muted) next.add(id); else next.delete(id);
      return next;
    });
    const el = audioRef.current.get(id);
    if (el) el.muted = muted;
  }, []);

  return { remoteStreams, peerStates, peerMutedForMe, toggleMuteForMe, handleSignal, setVideoOverride, setAudioOverride };
}
