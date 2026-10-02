import { useEffect, useRef } from "react";
type Controls = { frame: number; pause: () => void; toggle: () => void; shuttle: (direction: 1 | -1) => void; seek: (frame: number, track?: string, play?: boolean) => Promise<void> };
/** Clip's marking keys: I and O mark, G clears, Q and W go to the marks. */
export type MarkKeys = { markIn: () => void; markOut: () => void; clear: () => void; gotoIn: () => void; gotoOut: () => void };
export function useMultitrackKeyboard(active: boolean, controls: Controls, onTimecode?: (digit: string) => void, marks?: MarkKeys) {
  const latest = useRef({ ...controls, onTimecode, marks }); latest.current = { ...controls, onTimecode, marks };
  useEffect(() => {
    if (!active) return;
    let kHeld = false;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('[aria-modal="true"], [role="menu"]') ||
        target instanceof HTMLElement && (target.closest('input,textarea,select,[contenteditable]:not([contenteditable=false]),[role="tablist"]') || event.key === " " && target.closest("button,summary"))) return;
      const current = latest.current, key = event.key.toLowerCase();
      if (/^\d$/.test(key) && current.onTimecode) { kHeld = false; current.onTimecode(key); }
      else if (key === "k") { kHeld = true; current.pause(); }
      else if (key === "j" || key === "l") { const direction = key === "j" ? -1 : 1; if (kHeld) void current.seek(current.frame + direction, undefined, false); else if (!event.repeat) current.shuttle(direction); }
      else if (key === " " && !event.repeat) current.toggle();
      else if (current.marks && (key === "i" || key === "o" || key === "g" || key === "q" || key === "w")) {
        const { markIn, markOut, clear, gotoIn, gotoOut } = current.marks;
        ({ i: markIn, o: markOut, g: clear, q: gotoIn, w: gotoOut } as Record<string, () => void>)[key]();
      }
      else if ((key === "arrowleft" || key === "arrowright") && !(target instanceof HTMLElement && target.closest('[role="slider"]'))) void current.seek(current.frame + (key === "arrowleft" ? -1 : 1) * (event.shiftKey ? 10 : 1), undefined, false);
      else return;
      event.preventDefault();
    };
    const keyup = (event: KeyboardEvent) => { if (event.key.toLowerCase() === "k") kHeld = false; };
    const blur = () => { kHeld = false; latest.current.pause(); };
    window.addEventListener("keydown", keydown); window.addEventListener("keyup", keyup); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur); };
  }, [active]);
}
