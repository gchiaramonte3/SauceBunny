import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RF_SOURCES, rfPeople } from "./review-fullscreen-fixture";
import { IDLE_MS, controlsShown, frameTimecode } from "./review-fullscreen-model";
import { RfControlBar, type RfAction, type RfBarState } from "./RfControlBar";
import { RfOptions, type RfOptionsState } from "./RfOptions";
import { RfPeople } from "./RfPeople";
import { RfStage } from "./RfStage";
import { RfTitleBar } from "./RfTitleBar";
import { RfWindowed } from "./RfWindowed";

const TITLE = "Cut 3 review";
const TRANSPORT_KEYS = new Set(["i", "o", "j", "k", "l", " ", "arrowleft", "arrowright"]);
const LIVE_NOTICE = "Timeline timecode isn't available here: playback is controlled at the source.";
const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest("button, input, select, textarea, summary, [role='menuitem']");

/**
 * Review in full screen, redesigned for a pick (UI corrections, item 18): the
 * picture is the page, one control bar over its bottom that steps aside with
 * a thin title while nobody is using them, the people in a film strip, and
 * no app chrome until Escape. A generated scene; nothing joins a session.
 */
export function ReviewFullscreenPrototype() {
  const [full, setFull] = useState(true);
  const [options, setOptions] = useState<RfOptionsState>({ layout: "right", source: "window", count: 4, longNames: false, handRaised: true, camerasOff: false, pinned: false });
  const [bar, setBar] = useState<RfBarState>({ muted: false, cameraOff: false, drawing: false, handRaised: false, peopleOpen: true, playing: false, frame: 0 });
  const [idle, setIdle] = useState(false), [focusInside, setFocusInside] = useState(false), [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reactions, setReactions] = useState<{ id: number; emoji: string }[]>([]);
  const source = RF_SOURCES[options.source];
  const people = useMemo(() => rfPeople(options.count, options).map((person) => person.self
    ? { ...person, muted: bar.muted, cameraOff: bar.cameraOff, handRaised: bar.handRaised } : person), [options, bar.muted, bar.cameraOff, bar.handRaised]);
  const shown = !full || controlsShown({ sinceMoveMs: idle ? IDLE_MS : 0, focusInside, menuOpen, pinned: options.pinned });
  const timer = useRef(0), reactionId = useRef(0);
  const wake = useCallback(() => { setIdle(false); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setIdle(true), IDLE_MS); }, []);
  useEffect(() => { wake(); return () => window.clearTimeout(timer.current); }, [wake]);
  const say = useCallback((text: string) => { setNotice(text); wake(); }, [wake]);
  useEffect(() => { if (!notice) return; const clear = window.setTimeout(() => setNotice(null), 4000); return () => window.clearTimeout(clear); }, [notice]);
  useEffect(() => {
    if (!bar.playing || source.live) return;
    const tick = window.setInterval(() => setBar((prior) => prior.frame >= source.frames ? { ...prior, playing: false } : { ...prior, frame: prior.frame + 1 }), 1000 / 24);
    return () => window.clearInterval(tick);
  }, [bar.playing, source]);
  const act = useCallback((action: RfAction) => {
    const flip = (key: "muted" | "cameraOff" | "drawing" | "handRaised" | "peopleOpen" | "playing") => setBar((prior) => ({ ...prior, [key]: !prior[key] }));
    if (action.kind === "mute") flip("muted"); else if (action.kind === "camera") flip("cameraOff");
    else if (action.kind === "draw") flip("drawing"); else if (action.kind === "hand") flip("handRaised");
    else if (action.kind === "people") flip("peopleOpen"); else if (action.kind === "play") flip("playing");
    else if (action.kind === "exit") setFull(false);
    else if (action.kind === "seek") setBar((prior) => ({ ...prior, frame: action.frame }));
    else if (action.kind === "share") say("Share opens the macOS picker. Demo only.");
    else if (action.kind === "settings") say("Settings opens your camera and microphone. Demo only.");
    else if (action.kind === "react") {
      const id = ++reactionId.current;
      setReactions((prior) => [...prior, { id, emoji: action.emoji }]);
      window.setTimeout(() => setReactions((prior) => prior.filter((reaction) => reaction.id !== id)), 2500);
    }
  }, [say]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The reactions menu and drawing take Escape first, as the room's own handler does.
        if (menuOpen || event.defaultPrevented) return;
        if (bar.drawing) setBar((prior) => ({ ...prior, drawing: false })); else if (full) setFull(false);
        return;
      }
      const key = event.key.toLowerCase();
      if (!full || event.metaKey || event.ctrlKey || event.altKey || !TRANSPORT_KEYS.has(key) || (interactive(event.target) && (key === " " || key.startsWith("arrow")))) return;
      event.preventDefault();
      if (source.live) say(LIVE_NOTICE);
      else if (key === " " || key === "k") act({ kind: "play" });
      else if (key === "arrowleft" || key === "arrowright") setBar((prior) => ({ ...prior, frame: Math.max(0, Math.min(source.frames, prior.frame + (key === "arrowleft" ? -1 : 1))) }));
      else if (key === "i" || key === "o") say(`Marked ${key === "i" ? "in" : "out"} at ${frameTimecode(bar.frame)}. Demo only.`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, bar.drawing, bar.frame, full, menuOpen, say, source]);
  const chrome = (target: EventTarget | null) => target instanceof Element && !!target.closest(".cp-rf-bar, .cp-rf-title");
  const stage = <RfStage source={source} frame={bar.frame} drawing={bar.drawing} reactions={reactions}>
    {full && <RfControlBar source={source} shown={shown} state={bar} notice={notice} onAction={act} onMenu={setMenuOpen} />}
  </RfStage>;
  return <div className="cp-rf" data-testid="review-fullscreen" data-chrome={shown ? "shown" : "away"} onPointerMove={wake}
    onFocusCapture={(event) => setFocusInside(chrome(event.target))} onBlurCapture={(event) => setFocusInside(chrome(event.relatedTarget))}>
    {full ? <div className={`cp-rf-full${bar.peopleOpen ? " has-people" : ""}`} data-layout={options.layout}>
      <RfTitleBar shown={shown} title={TITLE} people={people.length} onDemo={(what) => say(`${what}: demo only.`)} />
      {stage}
      {bar.peopleOpen && <RfPeople people={people} layout={options.layout} shown={shown} onToggleMic={() => act({ kind: "mute" })} onToggleCamera={() => act({ kind: "camera" })} />}
    </div> : <RfWindowed source={source} title={TITLE} stage={stage} onEnter={() => setFull(true)} />}
    <RfOptions value={options} onChange={setOptions} />
  </div>;
}
