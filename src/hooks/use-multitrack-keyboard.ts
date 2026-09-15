import { useEffect, useRef } from "react";
type Controls = { frame: number; pause: () => void; toggle: () => void; shuttle: (direction: 1 | -1) => void; seek: (frame: number, track?: string, play?: boolean) => Promise<void> };
export function useMultitrackKeyboard(active: boolean, controls: Controls) {
  const latest = useRef(controls); latest.current = controls;
  useEffect(() => {
    if (!active) return;
    let kHeld = false;
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || document.querySelector('[aria-modal="true"]') ||
        target instanceof HTMLElement && (target.closest('input,textarea,select,[contenteditable=true],[role="menu"],[role="tablist"]') || event.key === " " && target.closest("button,summary"))) return;
      const current = latest.current, key = event.key.toLowerCase();
      if (key === "k") { kHeld = true; current.pause(); }
      else if (key === "j" || key === "l") { const direction = key === "j" ? -1 : 1; if (kHeld) void current.seek(current.frame + direction, undefined, false); else if (!event.repeat) current.shuttle(direction); }
      else if (key === " " && !event.repeat) current.toggle();
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
