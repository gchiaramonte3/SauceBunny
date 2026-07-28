import { useState, type RefObject } from "react";
import { LocalMediaPlayer } from "./LocalMediaPlayer";
import { MediaBunnyPlayer } from "./MediaBunnyPlayer";
import type { PlayerHandle } from "./player-handle";
import {
  IconPlay, IconPause, IconSkipBack, IconSkipForward, IconPanelRight, IconFilm, IconSpinnerArc,
} from "./Icons";
import { usePlayheadSeconds } from "../lib/playhead-store";
import { secondsToHms } from "../lib/timecode";

/**
 * The reader's follow-along source — a local file resolved for playback the
 * SAME way the Clip/Library flow resolves it (this is why a file that plays in
 * the Library also plays here):
 *   - `useWebCodecs` true  → MediaBunnyPlayer, which reads the ORIGINAL via
 *     native byte-range IPC and decodes with WebCodecs. This is the reliable
 *     primary path; a raw file handed to a native <video src="asset://…">
 *     hangs in WKWebView (black canvas, duration 0:00, no error event).
 *   - `useWebCodecs` false → the file was ffmpeg-transcoded to a small
 *     WKWebView-friendly copy (`path`), played via LocalMediaPlayer.
 * `origPath` is kept so an on-error fallback can transcode the original;
 * `prepared` marks that `path` is already a transcoded copy (stops a re-prep
 * loop). Web / source-less transcripts read text-only (source === null).
 */
export type ReaderSource = {
  origPath: string;
  path: string;
  hasVideo: boolean;
  fps: number;
  title: string;
  useWebCodecs: boolean;
  prepared: boolean;
};

/** HH:MM:SS (or M:SS under an hour) for the transport clock. */
function fmtClock(s: number): string {
  const t = Math.max(0, Math.floor(isFinite(s) ? s : 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

type Props = {
  /** The resolved local source to play, or null for text-only / while preparing. */
  source: ReaderSource | null;
  /** True while an ffmpeg playback copy is being prepared (exotic codec fallback). */
  preparing: boolean;
  /** Why there's no player (shown in the placeholder) when source is null. */
  note: string | null;
  /** App's reader player ref — shared with the keyboard + single-clock gate. */
  playerRef: RefObject<PlayerHandle>;
  floating: boolean;
  /** True while the reader is the active view (gates the playhead-driven clock). */
  active: boolean;
  onToggleFloat: () => void;
  onCollapse: () => void;
  onTimeUpdate?: (seconds: number) => void;
  onPlayStateChange: (playing: boolean) => void;
  /** A native/WebCodecs load failure → App transcodes the original and retries. */
  onError: (message: string) => void;
  initialVolume: number;
};

/**
 * The follow-along player panel for the Transcripts reader — a compact video
 * viewport with a real transport (rewind 10s · play/pause · forward 10s · a
 * clickable position bar + clock). "A time, not a timeline": it follows the
 * reading, it isn't the NLE. Docks far-right or floats when popped out. When a
 * transcript has no playable local source it shows an honest placeholder
 * instead of vanishing, so the panel is always a discoverable fixture.
 */
export function ReaderPlayerStage({
  source, preparing, note, playerRef, floating, active,
  onToggleFloat, onCollapse, onTimeUpdate, onPlayStateChange, onError, initialVolume,
}: Props) {
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  // Same global playhead the karaoke highlight reads — one clock, no drift.
  const cur = usePlayheadSeconds(source?.fps ?? 24, active) ?? 0;

  const handlePlayState = (p: boolean) => { setPlaying(p); onPlayStateChange(p); };
  const handleReady = (d: number) => { setDuration(d || 0); playerRef.current?.setVolume(initialVolume); };
  const toggle = () => {
    const p = playerRef.current; if (!p) return;
    if (p.isPlaying()) p.pause(); else p.play();
  };
  const skip = (delta: number) => {
    const p = playerRef.current; if (!p) return;
    const dur = p.getDuration() || duration || Number.POSITIVE_INFINITY;
    p.seekTo(Math.max(0, Math.min(dur, p.getCurrentTime() + delta)));
  };
  const seekToFraction = (e: React.MouseEvent<HTMLDivElement>) => {
    const p = playerRef.current; if (!p) return;
    const dur = p.getDuration() || duration; if (!dur) return;
    const rect = e.currentTarget.getBoundingClientRect();
    p.seekTo(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * dur);
  };

  const pct = duration ? Math.min(100, (cur / duration) * 100) : 0;
  const headTitle = source?.title ?? (preparing ? "Preparing…" : "No video");
  // Same props feed either engine — they share the PlayerHandle interface. The
  // key remounts cleanly on a path/engine swap (mediabunny original → native copy).
  const playerProps = source && {
    path: source.path,
    filename: source.title,
    hasVideo: source.hasVideo,
    initialVolume,
    onTimeUpdate,
    onPlayStateChange: handlePlayState,
    onReady: handleReady,
    onError,
  };

  return (
    <div className={"cp-reader-stage-panel" + (floating ? " floating" : "")} aria-label="Follow-along video">
      <div className="cp-reader-stage-head">
        <span className="cp-reader-stage-title" title={headTitle}>{headTitle}</span>
        {source && (
          <button
            type="button"
            className="cp-reader-stage-btn"
            onClick={onToggleFloat}
            title={floating ? "Dock the player" : "Pop out the player"}
            aria-label={floating ? "Dock the player" : "Pop out the player"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="cp-reader-stage-btn"
          onClick={onCollapse}
          title="Hide the player"
          aria-label="Hide the player"
        >
          <IconPanelRight size={15} />
        </button>
      </div>

      {source && playerProps ? (
        <>
          <div className="cp-reader-stage-video">
            {source.useWebCodecs
              ? <MediaBunnyPlayer key={"mb:" + source.path} ref={playerRef} {...playerProps} />
              : <LocalMediaPlayer key={"lm:" + source.path} ref={playerRef} {...playerProps} />}
          </div>
          <div className="cp-reader-transport">
            {/* role="presentation" ACTIVELY DELETED this from the
                accessibility tree — a seek bar announced as nothing, with no
                tab stop and no keys. It is the only way to move around a
                recording in the reader. Same slider contract the Timeline's
                playhead already carries: a real role, the position as a
                timecode rather than a raw number, and the arrow keys an editor
                expects. Reading is a keyboard activity; needing a mouse to
                skip back ten seconds is the whole problem. */}
            <div
              className="cp-reader-scrub"
              onClick={seekToFraction}
              role="slider"
              tabIndex={0}
              aria-label="Playback position"
              aria-valuemin={0}
              aria-valuemax={Math.max(0, Math.round(duration))}
              aria-valuenow={Math.round(cur)}
              aria-valuetext={secondsToHms(cur)}
              onKeyDown={(e) => {
                // Deliberately the same map as the transport: arrows step,
                // shift steps further, Home/End go to the ends.
                const step =
                  e.key === "ArrowLeft" ? (e.shiftKey ? -10 : -5)
                  : e.key === "ArrowRight" ? (e.shiftKey ? 10 : 5)
                  : null;
                if (step != null) { e.preventDefault(); skip(step); return; }
                if (e.key === "Home") { e.preventDefault(); playerRef.current?.seekTo(0); return; }
                if (e.key === "End" && duration) {
                  e.preventDefault();
                  playerRef.current?.seekTo(Math.max(0, duration - 0.1));
                }
              }}
              title="Click to jump, or focus and use the arrow keys"
            >
              <div className="cp-reader-scrub-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="cp-reader-transport-row">
              <button type="button" className="cp-reader-tbtn" onClick={() => skip(-10)} title="Back 10 seconds" aria-label="Back 10 seconds">
                <IconSkipBack size={16} />
              </button>
              <button type="button" className="cp-reader-tbtn primary" onClick={toggle} title={playing ? "Pause" : "Play"} aria-label={playing ? "Pause" : "Play"}>
                {playing ? <IconPause size={17} /> : <IconPlay size={17} />}
              </button>
              <button type="button" className="cp-reader-tbtn" onClick={() => skip(10)} title="Forward 10 seconds" aria-label="Forward 10 seconds">
                <IconSkipForward size={16} />
              </button>
              <span className="cp-reader-clock">
                {fmtClock(cur)}<span className="cp-reader-clock-sep"> / </span>{fmtClock(duration)}
              </span>
            </div>
          </div>
        </>
      ) : preparing ? (
        <div className="cp-reader-stage-empty">
          <IconSpinnerArc size={22} />
          <p>Preparing a playback copy of this source…</p>
        </div>
      ) : (
        <div className="cp-reader-stage-empty">
          <IconFilm size={22} />
          <p>{note ?? "Pick a transcript from the list to load its follow-along video."}</p>
        </div>
      )}
    </div>
  );
}
