import { useState, type RefObject } from "react";
import { LocalMediaPlayer } from "./LocalMediaPlayer";
import type { PlayerHandle } from "./player-handle";
import {
  IconPlay, IconPause, IconSkipBack, IconSkipForward, IconPanelRight, IconFilm,
} from "./Icons";
import { usePlayheadSeconds } from "../lib/playhead-store";

/** The reader's follow-along source — a local file probed for playback. Web /
 *  source-less transcripts read text-only (source === null → a placeholder). */
export type ReaderSource = { path: string; hasVideo: boolean; fps: number; title: string };

/** HH:MM:SS (or M:SS under an hour) for the transport clock. */
function fmtClock(s: number): string {
  const t = Math.max(0, Math.floor(isFinite(s) ? s : 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(sec).padStart(2, "0")}`;
}

type Props = {
  /** The local source to play, or null for a text-only transcript. */
  source: ReaderSource | null;
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
  source, note, playerRef, floating, active,
  onToggleFloat, onCollapse, onTimeUpdate, onPlayStateChange, initialVolume,
}: Props) {
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  // Same global playhead the karaoke highlight reads — one clock, no drift.
  const cur = usePlayheadSeconds(source?.fps ?? 24, active) ?? 0;

  const handlePlayState = (p: boolean) => { setPlaying(p); onPlayStateChange(p); };
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
  return (
    <div className={"cp-reader-stage-panel" + (floating ? " floating" : "")} aria-label="Follow-along video">
      <div className="cp-reader-stage-head">
        <span className="cp-reader-stage-title" title={source?.title ?? "No video"}>
          {source?.title ?? "No video"}
        </span>
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

      {source ? (
        <>
          <div className="cp-reader-stage-video">
            <LocalMediaPlayer
              ref={playerRef}
              path={source.path}
              filename={source.title}
              hasVideo={source.hasVideo}
              initialVolume={initialVolume}
              onTimeUpdate={onTimeUpdate}
              onPlayStateChange={handlePlayState}
              onReady={(d) => { setDuration(d || 0); playerRef.current?.setVolume(initialVolume); }}
            />
          </div>
          <div className="cp-reader-transport">
            <div className="cp-reader-scrub" onClick={seekToFraction} role="presentation" title="Click to jump">
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
      ) : (
        <div className="cp-reader-stage-empty">
          <IconFilm size={22} />
          <p>{note ?? "Pick a transcript from the list to load its follow-along video."}</p>
        </div>
      )}
    </div>
  );
}
