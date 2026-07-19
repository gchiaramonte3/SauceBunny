import { useEffect, useRef, useState } from "react";
import { IconCrown, IconMicOff, IconChevronRight } from "./Icons";
import { initialsOf } from "../lib/review";
import { subscribeSessionCapture, getSessionCapture } from "../hooks/use-media-capture";
import type { MeshPeerState } from "../lib/rtc-mesh";

/** One person in the session. `id` is the session-scoped member id (m0 =
 *  host) - the roster key; names are display-only and can collide. */
export type Participant = { id: string; name: string; color: string; isHost: boolean; isSelf: boolean };

/**
 * The room's PEOPLE panel (Louper model: cameras are a place, not a
 * decoration). A left column of 16:9 camera tiles - you first (mirrored,
 * live from the green-room capture the moment you enter), then every other
 * member: their mesh stream when live, the avatar card when not (declined,
 * failed, camera off). Collapsible to a 72px avatar spine (auto below
 * ~1100px via CSS); tiles pop over on hover/focus in spine mode. Folds in
 * the old participant rail's roster duties; leave/end lives in the room
 * control bar.
 */
export function PeoplePanel({ active, participants, remoteStreams, peerStates, sharingMembers, shareStream, raisedHands, reactionFlashes, strip = false }: {
  active: boolean;
  participants: Participant[];
  remoteStreams: ReadonlyMap<string, MediaStream>;
  peerStates: ReadonlyMap<string, MeshPeerState>;
  /** Members flagged as screen-sharing (their tile badges "Sharing screen"). */
  sharingMembers: ReadonlySet<string>;
  /** Your own live share preview (v1: it replaces your camera tile). */
  shareStream: MediaStream | null;
  /** Members with a raised hand (persistent ✋ tile badge). */
  raisedHands: ReadonlySet<string>;
  /** Latest transient reaction per member (short-lived tile badge). */
  reactionFlashes: ReadonlyMap<string, string>;
  /** Theater bottom strip: horizontal row under the stage instead of the
   *  side column (the column hides in theater; this fills the space). */
  strip?: boolean;
}) {
  const [selfStream, setSelfStream] = useState<MediaStream | null>(() => getSessionCapture());
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => subscribeSessionCapture(setSelfStream), []);
  if (!active) return null;

  const ordered = [...participants].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
  return (
    <aside className={"cp-people" + (strip ? " strip" : collapsed ? " spine" : "")} aria-label="Session participants">
      <div className="cp-people-head">
        <span className="cp-people-title">People</span>
        <span className="cp-people-count">{participants.length}</span>
        <button
          type="button"
          className={"btn-icon cp-people-collapse" + (collapsed ? " open" : "")}
          title={collapsed ? "Expand people" : "Collapse to avatars"}
          aria-label={collapsed ? "Expand the people panel" : "Collapse the people panel to avatars"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <IconChevronRight size={12} />
        </button>
      </div>
      <div className="cp-people-list">
        {ordered.map((p) => (
          <PersonTile
            key={p.id}
            p={p}
            stream={p.isSelf ? (shareStream ?? selfStream) : remoteStreams.get(p.id) ?? null}
            state={p.isSelf ? "live" : peerStates.get(p.id) ?? "connecting"}
            sharing={p.isSelf ? shareStream != null : sharingMembers.has(p.id)}
            handUp={raisedHands.has(p.id)}
            flash={reactionFlashes.get(p.id) ?? null}
          />
        ))}
      </div>
    </aside>
  );
}

/** One member: camera tile when a video track flows, avatar card when not.
 *  Speaking glow rides an AnalyserNode threshold on the tile's own audio
 *  (reduced motion: no glow animation, static ring). */
function PersonTile({ p, stream, state, sharing, handUp, flash }: {
  p: Participant;
  stream: MediaStream | null;
  state: MeshPeerState;
  sharing: boolean;
  handUp: boolean;
  flash: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.enabled && !t.muted);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !stream) return;
    v.srcObject = stream;
    v.play().catch(() => { /* autoplay */ });
  }, [stream, hasVideo]);

  // Remote mute state: read the audio track's events (enabled propagates as
  // silence; muted flips when frames stop arriving).
  useEffect(() => {
    const at = stream?.getAudioTracks()[0];
    if (!at) { setMicMuted(true); return; }
    const update = () => setMicMuted(at.muted || !at.enabled);
    update();
    at.addEventListener("mute", update);
    at.addEventListener("unmute", update);
    return () => {
      at.removeEventListener("mute", update);
      at.removeEventListener("unmute", update);
    };
  }, [stream]);

  // Speaking glow: cheap RMS threshold, ~8 checks/second.
  useEffect(() => {
    const at = stream?.getAudioTracks()[0];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!at || reduced) return;
    let ctx: AudioContext | null = null;
    let timer = 0;
    try {
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(new MediaStream([at]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      timer = window.setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
        setSpeaking(peak > 18);
      }, 120);
    } catch { /* no audio context - no glow */ }
    return () => {
      window.clearInterval(timer);
      if (ctx) void ctx.close();
    };
  }, [stream]);

  return (
    <div
      className={"cp-person" + (speaking && !micMuted ? " speaking" : "") + (p.isSelf ? " self" : "")}
      style={{ ["--pr-color" as string]: p.color }}
    >
      {hasVideo ? (
        <video ref={videoRef} className={p.isSelf && !sharing ? "mirror" : undefined} muted playsInline aria-hidden />
      ) : (
        <div className="cp-person-avatar" aria-hidden>
          <span className="cp-person-initials">{initialsOf(p.name)}</span>
          {state === "connecting" && !p.isSelf && <span className="cp-person-conn">Connecting</span>}
          {state === "failed" && <span className="cp-person-conn">No connection</span>}
        </div>
      )}
      {sharing && <span className="cp-person-share">Sharing screen</span>}
      {handUp && <span className="cp-person-hand" title="Hand raised" aria-label="Hand raised">✋</span>}
      {flash && <span className="cp-person-flash" aria-hidden>{flash}</span>}
      <div className="cp-person-meta">
        {p.isHost && <span className="cp-person-crown" title="Host"><IconCrown size={10} /></span>}
        <span className="cp-person-name" title={p.name}>{p.isSelf ? `${p.name} (You)` : p.name}</span>
        {micMuted && <span className="cp-person-muted" title="Mic muted" aria-label="Mic muted"><IconMicOff size={11} /></span>}
      </div>
    </div>
  );
}
