import { useCallback, useRef, useState } from "react";
import {
  IconFullscreenExit, IconMic, IconMicOff, IconPanelRight, IconPause, IconPencil, IconPlay, IconScreenShare, IconSettings, IconSmile, IconVideo, IconVideoOff,
} from "../src/components/Icons";
import { useDismiss } from "../src/hooks/use-dismiss";
import { useMenuKeys } from "../src/hooks/use-menu-keys";
import type { RfSource } from "./review-fullscreen-fixture";
import { frameTimecode } from "./review-fullscreen-model";

type RfSimpleAction = "mute" | "camera" | "share" | "draw" | "hand" | "settings" | "people" | "exit" | "play";
export type RfAction = { kind: RfSimpleAction } | { kind: "react"; emoji: string } | { kind: "seek"; frame: number };
export type RfBarState = { muted: boolean; cameraOff: boolean; drawing: boolean; handRaised: boolean; peopleOpen: boolean; playing: boolean; frame: number };

const REACTIONS = ["👏", "👍", "😂", "❤️", "🎉"];

/**
 * The one control bar, over the bottom of the picture: the source on the
 * left (a Live chip, or a file's transport), what you do in the room on the
 * right. No status prose: "timecode unavailable" is said only when someone
 * reaches for it (`notice`). It steps aside with the title when idle.
 */
export function RfControlBar({ source, shown, state, notice, onAction, onMenu }: {
  source: RfSource; shown: boolean; state: RfBarState; notice: string | null;
  onAction: (action: RfAction) => void; onMenu: (open: boolean) => void;
}) {
  const [reacting, setReacting] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = (open: boolean) => { setReacting(open); onMenu(open); };
  const close = useCallback(() => { setReacting(false); onMenu(false); }, [onMenu]);
  useDismiss(menu, close, reacting);
  useMenuKeys(menu, reacting, close);
  const button = (label: string, kind: RfSimpleAction, icon: JSX.Element, pressed?: boolean, look?: "off" | "is-on") =>
    <button type="button" className={`cp-rf-btn${look ? ` ${look}` : ""}`} aria-label={label} title={label} aria-pressed={pressed} onClick={() => onAction({ kind })}>{icon}</button>;
  return <div className={`cp-rf-bar${shown ? "" : " is-away"}`} role="group" aria-label="Session controls" data-testid="rf-bar">
    {notice && <p className="cp-rf-notice" role="status">{notice}</p>}
    <div className="cp-rf-bar-source">
      {source.live && <span className="cp-rf-live">Live</span>}
      <span className="cp-rf-bar-title">{source.title}</span>
      <span className="cp-rf-bar-detail">{source.detail}</span>
    </div>
    {!source.live && <div className="cp-rf-transport">
      {button(state.playing ? "Pause" : "Play", "play", state.playing ? <IconPause size={16} /> : <IconPlay size={16} />)}
      <span className="cp-rf-tc">{frameTimecode(state.frame)}</span>
      <input type="range" className="cp-rf-scrub" aria-label="Playhead" min={0} max={source.frames} value={state.frame}
        onChange={(event) => onAction({ kind: "seek", frame: Number(event.target.value) })} />
    </div>}
    <div className="cp-rf-actions">
      {button(state.muted ? "Unmute" : "Mute", "mute", state.muted ? <IconMicOff size={16} /> : <IconMic size={16} />, !state.muted, state.muted ? "off" : undefined)}
      {button(state.cameraOff ? "Turn camera on" : "Turn camera off", "camera", state.cameraOff ? <IconVideoOff size={16} /> : <IconVideo size={16} />, !state.cameraOff, state.cameraOff ? "off" : undefined)}
      {button("Share screen", "share", <IconScreenShare size={16} />)}
      {button("Draw", "draw", <IconPencil size={16} />, state.drawing, state.drawing ? "is-on" : undefined)}
      <span className="cp-rf-react">
        <button type="button" className={`cp-rf-btn${state.handRaised ? " is-on" : ""}`} aria-label="Reactions" title="Reactions" aria-haspopup="menu" aria-expanded={reacting}
          onMouseDown={(event) => event.stopPropagation()} onClick={() => toggle(!reacting)}><IconSmile size={16} /></button>
        {reacting && <div ref={menu} className="cp-rf-menu" role="menu" aria-label="Reactions">
          {REACTIONS.map((emoji) => <button key={emoji} type="button" role="menuitem" aria-label={`React ${emoji}`} onClick={() => { close(); onAction({ kind: "react", emoji }); }}>{emoji}</button>)}
          <button type="button" role="menuitem" className="cp-rf-menu-wide" onClick={() => { close(); onAction({ kind: "hand" }); }}>{state.handRaised ? "Lower hand" : "Raise hand"}</button>
        </div>}
      </span>
      {button("Settings", "settings", <IconSettings size={16} />)}
      <span className="cp-rf-sep" aria-hidden="true" />
      {button(state.peopleOpen ? "Hide people" : "Show people", "people", <IconPanelRight size={16} />, state.peopleOpen, state.peopleOpen ? "is-on" : undefined)}
      {button("Exit full screen", "exit", <IconFullscreenExit size={16} />)}
    </div>
  </div>;
}
