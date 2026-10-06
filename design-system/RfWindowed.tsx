import type { ReactNode } from "react";
import { IconFullscreen } from "../src/components/Icons";
import type { RfSource } from "./review-fullscreen-fixture";

/**
 * The way back from full screen, in outline: the app's rail and the session
 * bar return around the same picture, with today's status line. A sketch to
 * show where Escape lands and how to return, not a copy of the room.
 */
export function RfWindowed({ source, title, stage, onEnter }: { source: RfSource; title: string; stage: ReactNode; onEnter: () => void }) {
  return <div className="cp-rf-window" data-testid="rf-windowed">
    <nav className="cp-rf-rail" aria-label="App">{["Home", "Library", "Clip", "Review", "Transcripts"].map((name) => <span key={name} className="cp-rf-rail-item">{name}</span>)}</nav>
    <div className="cp-rf-window-main">
      <header className="cp-rf-room-head"><span className="cp-rf-live">Live</span><strong>{title}</strong><span>{source.detail} · {source.live ? "Live" : "Shared"}</span></header>
      <div className="cp-rf-window-stage">{stage}</div>
      <div className="cp-rf-window-transport">
        {source.live && <span className="cp-rf-window-status">Live · Timeline timecode unavailable · Playback controlled at source</span>}
        <button type="button" className="cp-rf-text-btn cp-rf-enter" onClick={onEnter}><IconFullscreen size={14} />Enter full screen</button>
      </div>
    </div>
  </div>;
}
