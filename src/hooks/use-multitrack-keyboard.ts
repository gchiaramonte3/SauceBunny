import type { FrameStore } from "../lib/frame-store";
import { useEffect, useRef } from "react";
type Controls = { frames: FrameStore; pause: () => void; toggle: () => void; shuttle: (direction: 1 | -1) => void; seek: (frame: number, track?: string, play?: boolean) => Promise<void> };
/** Avid's marking keys, as Clip and String Outs have them: I and O mark, G clears both, D clears In, F clears Out, Q and W go to the marks. */
export type MarkKeys = { markIn: () => void; markOut: () => void; clear: () => void; clearIn: () => void; clearOut: () => void; gotoIn: () => void; gotoOut: () => void };
/** The view's keys, as String Outs has them: ⌘= and ⌘− zoom, ⇧Z fits; Home and End go to the ends from anywhere. */
export type ViewKeys = { zoom: (direction: -1 | 0 | 1) => void; duration: number };
export function useMultitrackKeyboard(active: boolean, controls: Controls, onTimecode?: (digit: string) => void, marks?: MarkKeys, view?: ViewKeys) {
  const latest = useRef({ ...controls, onTimecode, marks, view }); latest.current = { ...controls, onTimecode, marks, view };
  useEffect(() => {
    if (!active) return;
    let kHeld = false;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || document.querySelector('[aria-modal="true"], [role="menu"]') ||
        target instanceof HTMLElement && (target.closest('input,textarea,select,[contenteditable]:not([contenteditable=false]),[role="tablist"]') || event.key === " " && target.closest("button,summary"))) return;
      const current = latest.current, key = event.key.toLowerCase();
      // ⌘= and ⌘− zoom; every other ⌘ chord is the app's.
      if (event.metaKey) {
        if (current.view && !event.shiftKey && (key === "=" || key === "+" || key === "-")) { event.preventDefault(); current.view.zoom(key === "-" ? -1 : 1); }
        return;
      }
      if (/^\d$/.test(key) && current.onTimecode) { kHeld = false; current.onTimecode(key); }
      else if (key === "k") { kHeld = true; current.pause(); }
      else if (key === "j" || key === "l") { const direction = key === "j" ? -1 : 1; if (kHeld) void current.seek(current.frames.get() + direction, undefined, false); else if (!event.repeat) current.shuttle(direction); }
      else if (key === " " && !event.repeat) current.toggle();
      else if (event.shiftKey && key === "z" && current.view) current.view.zoom(0);
      // Home and End from anywhere; a lane slider's own Home and End do the same.
      else if ((event.key === "Home" || event.key === "End") && current.view && !(target instanceof HTMLElement && target.closest('[role="slider"]'))) void current.seek(event.key === "Home" ? 0 : current.view.duration - 1, undefined, false);
      // Plain letters only, as String Outs reads them: ⇧I is not a mark.
      else if (current.marks && !event.shiftKey && "iogdfqw".includes(key) && key.length === 1) {
        const { markIn, markOut, clear, clearIn, clearOut, gotoIn, gotoOut } = current.marks;
        ({ i: markIn, o: markOut, g: clear, d: clearIn, f: clearOut, q: gotoIn, w: gotoOut } as Record<string, () => void>)[key]();
      }
      else if ((key === "arrowleft" || key === "arrowright") && !(target instanceof HTMLElement && target.closest('[role="slider"]'))) void current.seek(current.frames.get() + (key === "arrowleft" ? -1 : 1) * (event.shiftKey ? 10 : 1), undefined, false);
      else return;
      event.preventDefault();
    };
    const keyup = (event: KeyboardEvent) => { if (event.key.toLowerCase() === "k") kHeld = false; };
    const blur = () => { kHeld = false; latest.current.pause(); };
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur); };
  }, [active]);
}
