import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RtcMesh, type MeshPeerState, type MeshSignalPayload } from "../lib/rtc-mesh";
import { getSessionCapture, subscribeSessionCapture } from "./use-media-capture";
import {
  SESSION_VOLUME_CHANGED_EVENT, SPEAKER_OUTPUT_CHANGED_EVENT,
  canPickSpeakers, loadDeviceChoice, loadSessionVolume,
} from "../lib/media-devices";

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
export type TurnConfig = { url: string; username: string; password: string };

export function useRtcMesh(args: {
  active: boolean;
  selfId: string | null;
  role: string; // "off" | "host" | "peer"
  memberIds: string[];
  turn: TurnConfig;
  onLog: (tag: "info" | "warn" | "err", msg: string) => void;
}) {
  const { active, selfId, role, memberIds, turn, onLog } = args;
  const [remoteStreams, setRemoteStreams] = useState<ReadonlyMap<string, MediaStream>>(new Map());
  const [peerStates, setPeerStates] = useState<ReadonlyMap<string, MeshPeerState>>(new Map());
  const meshRef = useRef<RtcMesh | null>(null);
  const audioRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const roleRef = useRef(role);
  useEffect(() => { roleRef.current = role; }, [role]);

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
    const iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
    if (turn.url.trim()) {
      iceServers.push({ urls: turn.url.trim(), username: turn.username || undefined, credential: turn.password || undefined });
    }
    const mesh = new RtcMesh({
      selfId,
      iceServers,
      createPc: (config) => new RTCPeerConnection(config),
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
        if (stream && stream.getAudioTracks().length > 0) {
          let el = audioRef.current.get(id);
          if (!el) {
            el = document.createElement("audio");
            el.autoplay = true;
            applySpeaker(el);
            applyVolume(el);
            audioRef.current.set(id, el);
          }
          el.srcObject = stream;
          el.play().catch(() => { /* resumes on user gesture */ });
        } else if (!stream) {
          stopAudio(id);
        }
      },
      onState: (id, state) => {
        setPeerStates((prev) => new Map(prev).set(id, state));
      },
      getLocalStream: () => getSessionCapture(),
      log: (tag, msg) => onLogRef.current(tag, msg),
    });
    meshRef.current = mesh;
    const unsub = subscribeSessionCapture((s) => { void mesh.replaceLocalStream(s); });
    return () => {
      unsub();
      mesh.close();
      meshRef.current = null;
      for (const id of [...audioRef.current.keys()]) stopAudio(id);
      setRemoteStreams(new Map());
      setPeerStates(new Map());
    };
  }, [active, selfId, turn.url, turn.username, turn.password]);

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

  return { remoteStreams, peerStates, handleSignal, setVideoOverride, setAudioOverride };
}
