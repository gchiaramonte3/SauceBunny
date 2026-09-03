import { useEffect, useRef, useState } from "react";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { useReactionFlashes } from "../lib/reaction-store";
import { IconCrown, IconMic, IconMicOff, IconVideo, IconVideoOff, IconChevronRight } from "./Icons";
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
/**
 * Roster changes, phrased for a live region. Empty string means say nothing.
 *
 * Coalesced into ONE sentence per change because a polite live region only
 * ever announces its latest value: two setState calls in a tick would drop
 * the first arrival on the floor rather than reading both.
 */
function rosterAnnouncement(joined: readonly string[], left: readonly string[]): string {
  const phrase = (names: readonly string[], verb: string) =>
    names.length === 0 ? ""
      : names.length === 1 ? `${names[0]} ${verb} the session`
        : names.length === 2 ? `${names[0]} and ${names[1]} ${verb} the session`
          : `${names.length} people ${verb} the session`;
  return [phrase(joined, "joined"), phrase(left, "left")].filter(Boolean).join(". ");
}

export function PeoplePanel({ active, participants, remoteStreams, peerStates, sharingMembers, recordingMembers, selfRecording, shareStream, raisedHands, strip = false, presenter = "m0", canGrantPresenter = false, onMakePresenter, selfCamOff, selfMicMuted, onToggleCam, onToggleMic, mutedForMe, onToggleMuteForMe, onRemovePerson }: {
  active: boolean;
  participants: Participant[];
  /** Member ids recording their own camera. */
  recordingMembers?: ReadonlySet<string>;
  /** Is THIS machine recording? Derived locally so the badge does not lag a
   *  network round trip behind your own click - and because the host never
   *  receives its own broadcast at all. */
  selfRecording?: boolean;
  /** Member id currently driving source + transport. */
  presenter?: string;
  /** True for the host, who is the one who can pass the floor. */
  canGrantPresenter?: boolean;
  onMakePresenter?: (memberId: string) => void;
  /** Your own device state + toggles, rendered on your tile. */
  selfCamOff?: boolean;
  selfMicMuted?: boolean;
  onToggleCam?: () => void;
  onToggleMic?: () => void;
  /** Peers YOU muted locally ("Mute for me") - never signalled to them. */
  mutedForMe?: ReadonlySet<string>;
  onToggleMuteForMe?: (memberId: string, muted: boolean) => void;
  /** Remove someone from the session. Host only, and absent for everyone
   *  else, so the control does not exist rather than existing and refusing.
   *  Unlike the two beside it, this is NOT local-only: it disconnects them. */
  onRemovePerson?: (memberId: string, name: string) => void;
  remoteStreams: ReadonlyMap<string, MediaStream>;
  peerStates: ReadonlyMap<string, MeshPeerState>;
  /** Members flagged as screen-sharing (their tile badges "Sharing screen"). */
  sharingMembers: ReadonlySet<string>;
  /** Your own live share preview (v1: it replaces your camera tile). */
  shareStream: MediaStream | null;
  /** Members with a raised hand (persistent ✋ tile badge). */
  raisedHands: ReadonlySet<string>;
  /** Latest transient reaction per member (short-lived tile badge). */
  /** Theater bottom strip: horizontal row under the stage instead of the
   *  side column (the column hides in theater; this fills the space). */
  strip?: boolean;
}) {
  // Self-subscribed: the flash map changing re-renders these tiles, not App.
  const reactionFlashes = useReactionFlashes();
  const [selfStream, setSelfStream] = useState<MediaStream | null>(() => getSessionCapture());
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => subscribeSessionCapture(setSelfStream), []);

  // Who is in the room is the one thing here that changes without you doing
  // anything, and the roster is the only place it shows. Every control below
  // is labelled, but a label cannot tell you somebody just arrived: a screen
  // reader user would have to go and look. The app already announces that a
  // peer sent an emoji (ReactionLayer); this is the same courtesy for the
  // peer themselves.
  const [rosterNews, setRosterNews] = useState("");
  const seenRef = useRef<Map<string, string> | null>(null);
  useEffect(() => {
    if (!active) {
      // Leaving resets the baseline. This panel stays MOUNTED between
      // sessions (a stable sibling of <main>, so entering never remounts the
      // player), so without this a rejoin would diff the new roster against
      // the old one and announce a crowd of arrivals that never happened.
      seenRef.current = null;
      setRosterNews("");
      return;
    }
    // Keyed by member id, carrying the name: `left` has to be describable
    // AFTER the person is gone from `participants`, and names can collide.
    const now = new Map(participants.filter((p) => !p.isSelf).map((p) => [p.id, p.name]));
    const prev = seenRef.current;
    seenRef.current = now;
    // The first roster of a session is the baseline, not news. Walking into
    // a room that already has three people in it is not three arrivals.
    if (!prev) return;
    const joined = [...now].filter(([id]) => !prev.has(id)).map(([, name]) => name);
    const left = [...prev].filter(([id]) => !now.has(id)).map(([, name]) => name);
    const text = rosterAnnouncement(joined, left);
    if (text) setRosterNews(text);
  }, [active, participants]);

  if (!active) return null;

  const ordered = [...participants].sort((a, b) => Number(b.isSelf) - Number(a.isSelf));
  return (
    <aside className={"cp-people" + (strip ? " strip" : collapsed ? " spine" : "")} aria-label="Session participants">
      <span className="cp-visually-hidden" role="status" aria-live="polite">{rosterNews}</span>
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
            recording={p.isSelf ? !!selfRecording : !!recordingMembers?.has(p.id)}
            handUp={raisedHands.has(p.id)}
            flash={reactionFlashes.get(p.id) ?? null}
            isPresenter={p.id === presenter}
            canGrant={canGrantPresenter}
            onMakePresenter={onMakePresenter}
            selfCamOff={selfCamOff}
            selfMicMuted={selfMicMuted}
            onToggleCam={onToggleCam}
            onToggleMic={onToggleMic}
            mutedForMe={mutedForMe?.has(p.id) ?? false}
            onToggleMuteForMe={onToggleMuteForMe}
            onRemovePerson={onRemovePerson}
          />
        ))}
      </div>
    </aside>
  );
}

/** One member: camera tile when a video track flows, avatar card when not.
 *  Speaking glow rides an AnalyserNode threshold on the tile's own audio
 *  (reduced motion: no glow animation, static ring). */
function PersonTile({ p, stream, state, sharing, recording, handUp, flash, isPresenter, canGrant, onMakePresenter, selfCamOff, selfMicMuted, onToggleCam, onToggleMic, mutedForMe, onToggleMuteForMe, onRemovePerson }: {
  p: Participant;
  stream: MediaStream | null;
  state: MeshPeerState;
  sharing: boolean;
  recording?: boolean;
  handUp: boolean;
  flash: string | null;
  /** This member currently chooses what the room watches. */
  isPresenter: boolean;
  /** WE may hand the floor over (host only). */
  canGrant: boolean;
  onMakePresenter?: (memberId: string) => void;
  /** YOUR device state - only meaningful on your own tile. */
  selfCamOff?: boolean;
  selfMicMuted?: boolean;
  onToggleCam?: () => void;
  onToggleMic?: () => void;
  /** YOU muted this peer locally (remote tiles only). */
  mutedForMe?: boolean;
  onToggleMuteForMe?: (memberId: string, muted: boolean) => void;
  onRemovePerson?: (memberId: string, name: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // "Hide video" is pure presentation on THIS machine - the track keeps
  // flowing (stopping it would need renegotiation and would tell the peer).
  const [videoHidden, setVideoHidden] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  /** Remote-only. On your OWN tile this is the wrong source: see `micMuted`. */
  const [trackMicMuted, setTrackMicMuted] = useState(false);
  /**
   * TWO INDICATORS, ONE TRUTH.
   *
   * The bottom mute glyph used to read the audio TRACK, while the mic button
   * beside it read `selfMicMuted` (the persisted intent). They desynchronised
   * on the very first toggle and could never re-converge, because:
   *   · your own capture's audio track is a WebAudio destination track, whose
   *     `.muted` is permanently false and which never fires mute/unmute;
   *   · muting flips `t.enabled` on that same track in place, so neither the
   *     event nor the `[stream]` effect re-runs.
   * Join muted then unmute and the glyph stayed red for the whole session.
   * For yourself the intent flag IS the truth; for a peer the track is the
   * only signal there is.
   */
  const micMuted = p.isSelf ? !!selfMicMuted : trackMicMuted;
  /** Anchor for the peer context menu (client coords), null when closed. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(menuRef, () => setMenuAt(null), menuAt !== null);
  // role="menu" is a promise about the keyboard: arrows, Home/End, type-ahead
  // and focus returning to whatever opened it. menu-keyboard-contract enforces
  // it, and caught this menu shipping the role without the behaviour.
  useMenuKeys(menuRef, menuAt !== null, () => setMenuAt(null));
  const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.enabled && !t.muted)
    && !(videoHidden && !p.isSelf);

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
    if (!at) { setTrackMicMuted(true); return; }
    const update = () => setTrackMicMuted(at.muted || !at.enabled);
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
      // Streams arrive from getUserMedia/pc.ontrack, never from a gesture, so
      // WKWebView starts this context SUSPENDED: getByteTimeDomainData would
      // read the 128 silence midpoint forever and the speaking ring would never
      // light for anyone. No-op when it's already running (see level-meter.ts).
      if (ctx.state === "suspended") void ctx.resume();
      const src = ctx.createMediaStreamSource(new MediaStream([at]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      // See level-meter.ts: fftSize, not frequencyBinCount — the latter is
      // half the window, so the speaking ring missed late transients too.
      const data = new Uint8Array(analyser.fftSize);
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
      onContextMenu={p.isSelf ? undefined : (e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
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
      {/* Your own tile doubles as the device control: the camera and mic you
          see are the ones you click. Everyone else's tile stays read-only. */}
      {p.isSelf && onToggleCam && onToggleMic && (
        <div className="cp-person-controls self">
          <button
            type="button"
            className={"cp-person-ctl" + (selfCamOff ? " off" : "")}
            aria-pressed={!selfCamOff}
            title={selfCamOff ? "Turn camera on" : "Turn camera off"}
            aria-label={selfCamOff ? "Turn camera on" : "Turn camera off"}
            onClick={onToggleCam}
          >
            {selfCamOff ? <IconVideoOff size={13} /> : <IconVideo size={13} />}
          </button>
          <button
            type="button"
            className={"cp-person-ctl" + (selfMicMuted ? " off" : "")}
            aria-pressed={!selfMicMuted}
            title={selfMicMuted ? "Unmute" : "Mute"}
            aria-label={selfMicMuted ? "Unmute" : "Mute"}
            onClick={onToggleMic}
          >
            {selfMicMuted ? <IconMicOff size={13} /> : <IconMic size={13} />}
          </button>
        </div>
      )}
      {isPresenter && (
        <span className="cp-person-presenting" title="Choosing what everyone watches">Presenting</span>
      )}
      {sharing && <span className="cp-person-share">Sharing screen</span>}
      {recording && (
        <span className="cp-person-rec" title="Recording their own camera and mic">Recording</span>
      )}
      {handUp && <span className="cp-person-hand" title="Hand raised" aria-label="Hand raised">✋</span>}
      {flash && <span className="cp-person-flash" aria-hidden>{flash}</span>}
      <div className="cp-person-meta">
        {p.isHost && <span className="cp-person-crown" title="Host"><IconCrown size={10} /></span>}
        <span className="cp-person-name" title={p.name}>{p.isSelf ? `${p.name} (You)` : p.name}</span>
        {/* PEERS ONLY. On your own tile the mic BUTTON is the indicator, and a
            second glyph beside it was the "microphone in two places" that read
            muted while the button read live. One control, one truth. */}
        {micMuted && !p.isSelf && <span className="cp-person-muted" title="Mic muted" aria-label="Mic muted"><IconMicOff size={11} /></span>}
      </div>
      {/* EVERYTHING YOU CAN DO TO SOMEONE ELSE lives in one right-click menu.
          It used to be three hover buttons over their face plus a "Let them
          present" button floating in the middle of the picture, which read as
          controls over THEM (two of the three only ever affected this screen)
          and covered the video besides. A context menu is where a per-person
          action belongs, and it leaves the tile showing the person. */}
      {menuAt && !p.isSelf && (
        <div
          ref={menuRef}
          className="cp-person-menu"
          role="menu"
          style={{ left: menuAt.x, top: menuAt.y }}
        >
          {onToggleMuteForMe && (
            <>
              <button role="menuitem" onClick={() => { setVideoHidden((h) => !h); setMenuAt(null); }}>
                {videoHidden ? "Show their video" : "Hide their video"}
                <span className="cp-person-menu-note">for me</span>
              </button>
              <button role="menuitem" onClick={() => { onToggleMuteForMe(p.id, !mutedForMe); setMenuAt(null); }}>
                {mutedForMe ? "Unmute them" : "Mute them"}
                <span className="cp-person-menu-note">for me</span>
              </button>
            </>
          )}
          {canGrant && !isPresenter && onMakePresenter && (
            <button role="menuitem" onClick={() => { onMakePresenter(p.id); setMenuAt(null); }}>
              Let them present
            </button>
          )}
          {onRemovePerson && (
            <button
              role="menuitem"
              className="danger"
              onClick={() => { onRemovePerson(p.id, p.name); setMenuAt(null); }}
            >
              Remove from session
            </button>
          )}
        </div>
      )}
    </div>
  );
}
