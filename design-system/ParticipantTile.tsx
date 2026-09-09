import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconCrown, IconMic, IconMicOff, IconRecord, IconScreenShare, IconVideo, IconVideoOff, IconAlert } from "../src/components/Icons";
import { useDismiss } from "../src/hooks/use-dismiss";
import { useMenuKeys } from "../src/hooks/use-menu-keys";
import "./participants.css";

export type CatalogParticipant = {
  id: string;
  name: string;
  initials: string;
  color: string;
  self?: boolean;
  host?: boolean;
  presenting?: boolean;
  muted?: boolean;
  cameraOff?: boolean;
  sharing?: boolean;
  recording?: boolean;
  handRaised?: boolean;
  speaking?: boolean;
  connection?: "connected" | "connecting" | "disconnected";
};
export type ParticipantDensity = "expanded" | "compact" | "theater";
export type ParticipantTileProps = { participant: CatalogParticipant; density?: ParticipantDensity; onToggleMic?: () => void; onToggleCamera?: () => void };

function participantStates(p: CatalogParticipant): string[] {
  return [p.self && "You", p.host && "Host", p.presenting && "Presenting", p.muted && "Mic muted",
    (p.cameraOff ? "Camera off" : "Camera on (fixture)"), p.sharing && "Sharing screen", p.recording && "Recording camera and mic",
    p.handRaised && "Hand raised", p.connection !== "connected" && p.connection]
    .filter((s): s is string => typeof s === "string");
}

/** Same mock participant state in all densities. No capture or room dependencies. */
export function ParticipantTile({ participant: p, density = "expanded", onToggleMic, onToggleCamera }: ParticipantTileProps) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [feedback, setFeedback] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const portalTextStyle = useRef<CSSProperties>({});
  const menuId = useId();
  const close = useCallback(() => setPosition(null), []);
  useDismiss(menuRef, close, position !== null);
  useMenuKeys(menuRef, position !== null, close);
  // Measure the real menu after text wraps. A guessed height fails with long
  // names, text enlargement and additional state labels near a viewport edge.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!position || !menu || !trigger) return;
    const place = () => {
      const anchor = trigger.getBoundingClientRect();
      const bounds = menu.getBoundingClientRect();
      const preferredLeft = anchor.right + 8;
      const left = Math.max(12, Math.min(preferredLeft, window.innerWidth - bounds.width - 12));
      const top = Math.max(12, Math.min(anchor.top, window.innerHeight - bounds.height - 12));
      setPosition((current) => current && (current.left !== left || current.top !== top) ? { left, top } : current);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(menu);
    return () => observer.disconnect();
  }, [position, density, p.name]);
  useEffect(() => {
    if (!position) return;
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close();
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", onScroll, true); };
  }, [position, close]);
  function open() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    triggerRef.current?.focus();
    // A body portal must carry the trigger's text tokens, including the
    // catalog's optional 125% text fixture, rather than silently shrinking.
    const computed = getComputedStyle(triggerRef.current!);
    portalTextStyle.current = Object.fromEntries(["--text-xs", "--text-sm", "--text-base", "--text-md"].map((token) => [token, computed.getPropertyValue(token)])) as CSSProperties;
    setPosition({ left: rect.right + 8, top: rect.top });
  }
  const states = participantStates(p);
  const action = (message: string) => { setFeedback(`${message} Demo only; no session was changed.`); close(); };
  return <div className={`cp-person${p.self ? " self" : ""}${p.speaking && !p.muted ? " speaking" : ""}`} data-density={density} data-testid={`participant-${density}-${p.id}`}
    data-speaking={!!p.speaking && !p.muted} data-muted={!!p.muted} style={{ "--pr-color": p.color } as CSSProperties}>
    <button ref={triggerRef} type="button" className="cp-person-trigger"
      data-testid={`participant-trigger-${density}-${p.id}`}
      aria-label={`${p.name}, ${states.join(", ")}. Participant details`}
      aria-haspopup="menu" aria-expanded={position !== null} aria-controls={position ? menuId : undefined}
      onMouseDown={event => { if (position) event.stopPropagation(); }}
      onClick={() => position ? close() : open()}
      onContextMenu={(event) => { event.preventDefault(); open(); }}
      onKeyDown={(event) => { if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") { event.preventDefault(); open(); } }}>
      <span className="cp-person-picture" data-camera={p.cameraOff ? "off" : "on"} aria-hidden="true">
        <span className="cp-person-avatar"><span className="cp-person-initials">{p.initials}</span></span>
      </span>
      {p.presenting && <span className="cp-person-presenter-pin" aria-hidden="true"><IconScreenShare size={11} /></span>}
      <span className="cp-person-meta" aria-hidden="true">
        <span className="cp-person-identity">{p.host && <span className="cp-person-crown"><IconCrown size={10} /></span>}
          <span className="cp-person-name">{p.name}{p.self ? " (You)" : ""}</span></span>
        {p.presenting && <span className="cp-person-presenting">Presenting</span>}
      </span>
    </button>
    <div className="cp-person-signals" aria-hidden="true">
      {p.muted && !p.self && <span className="cp-person-signal cp-person-muted" title="Mic muted"><IconMicOff size={12} /><span className="cp-person-signal-label">Muted</span></span>}
      {p.cameraOff && <span className="cp-person-signal cp-person-camera" title="Camera off"><IconVideoOff size={12} /><span className="cp-person-signal-label">Camera off</span></span>}
      {p.sharing && <span className="cp-person-signal cp-person-share" title="Sharing screen"><IconScreenShare size={12} /><span className="cp-person-signal-label">Sharing</span></span>}
      {p.recording && <span className="cp-person-signal cp-person-rec" title="Recording camera and mic"><IconRecord size={12} /><span className="cp-person-signal-label">Recording</span></span>}
      {p.handRaised && <span className="cp-person-signal cp-person-hand" title="Hand raised"><span>✋</span><span className="cp-person-signal-label">Hand raised</span></span>}
      {p.connection && p.connection !== "connected" && <span className="cp-person-signal cp-person-conn" title={p.connection}><IconAlert size={12} /><span className="cp-person-signal-label">{p.connection}</span></span>}
    </div>
    {p.self && <div className="cp-person-controls self">
      <button type="button" className={`cp-person-ctl${p.cameraOff ? " off" : ""}`} aria-pressed={!p.cameraOff} aria-label={p.cameraOff ? "Turn on my camera (fixture)" : "Turn off my camera (fixture)"} onClick={onToggleCamera}>{p.cameraOff ? <IconVideoOff size={13} /> : <IconVideo size={13} />}</button>
      <button type="button" className={`cp-person-ctl${p.muted ? " off" : ""}`} aria-pressed={!p.muted} aria-label={p.muted ? "Turn on my microphone (fixture)" : "Turn off my microphone (fixture)"} onClick={onToggleMic}>{p.muted ? <IconMicOff size={13} /> : <IconMic size={13} />}</button>
    </div>}
    <span className="cp-ds-sr-only" role="status">{feedback}</span>
    {position && createPortal(<div ref={menuRef} id={menuId} role="menu" aria-label={`${p.name} participant details`}
      className="cp-person-menu" data-testid={`participant-menu-${density}-${p.id}`} style={{ ...portalTextStyle.current, ...position }}>
      <div className="cp-person-menu-head"><strong>{p.name}</strong><span>{states.join(" · ") || "Connected"}</span></div>
      <button type="button" role="menuitem" onClick={() => { onToggleMic?.(); action("Microphone action selected."); }}>{p.self ? "My microphone" : "Mute for me"}<span className="cp-person-menu-note">{p.self ? "Demo action" : "This device only"}</span></button>
      <button type="button" role="menuitem" onClick={() => { onToggleCamera?.(); action("Camera action selected."); }}>{p.self ? "My camera" : "Hide video"}<span className="cp-person-menu-note">{p.self ? "Demo action" : "This device only"}</span></button>
      {!p.self && !p.presenting && <button type="button" role="menuitem" onClick={() => action("Presenter handoff selected.")}>Let them present <span className="cp-person-menu-note">Demo action</span></button>}
      <button type="button" role="menuitem" onClick={close}>Close details</button>
    </div>, document.body)}
  </div>;
}
