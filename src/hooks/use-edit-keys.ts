import { useEffect, useRef, type RefObject } from "react";

/** One action per key. Letters are the Avid set; ⌘ chords are the app's. */
export type EditKeyActions = {
  toggle: () => void; undo: () => void; redo: () => void; history: () => void;
  cutHere: () => void; loop: () => void; zoomIn: () => void; zoomOut: () => void; zoomFit: () => void;
  clearMarks: () => void; escape: () => boolean;
  markIn: () => void; markOut: () => void; lift: () => void; extract: () => void; marker: () => void; markClip: () => void;
  snap: () => void; previous: () => void; next: () => void; insert: () => void; start: () => void;
};

/**
 * The editor's keyboard, while its view is showing. On the window rather than
 * the root: after a button disables itself focus falls to <body>, and ⌘Z
 * still has to reach the edit. Nothing fires inside a field or a dialog, and
 * the letter keys stay off the source pane except V (insert).
 */
export function useEditKeys(root: RefObject<HTMLElement | null>, active: boolean, actions: EditKeyActions) {
  const latest = useRef(actions);
  useEffect(() => { latest.current = actions; });
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target !== document.body && !root.current?.contains(target)) return;
      if (target.closest("input, textarea, select, [contenteditable=true], [role=alertdialog], [role=dialog]")) return;
      const run = latest.current, key = event.key.toLowerCase();
      const onSource = !!target.closest("[data-source-id]");
      const act = (action: () => void) => { event.preventDefault(); event.stopPropagation(); action(); };
      if (event.key === " " && !onSource && !target.closest("button, [role=separator], [role=tab], [role=slider]")) return act(run.toggle);
      if (event.metaKey && !event.ctrlKey && key === "z") return act(event.shiftKey ? run.redo : run.undo);
      if (event.metaKey && !event.ctrlKey && !event.altKey && key === "y") return act(run.history);
      if (!onSource && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const chord = ({ b: run.cutHere, l: run.loop, "=": run.zoomIn, "-": run.zoomOut } as Record<string, () => void>)[key];
        if (chord) return act(chord);
      }
      if (!onSource && event.altKey && !event.metaKey && event.code === "KeyX") return act(run.clearMarks);
      if (event.key === "Escape" && run.escape()) return event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (key === "v") return act(run.insert);
      if (onSource) return;
      if (event.key === "Home") return act(run.start);
      if (event.shiftKey) { if (key === "z") act(run.zoomFit); return; }
      const letter = ({ i: run.markIn, o: run.markOut, z: run.lift, x: run.extract, m: run.marker, t: run.markClip, n: run.snap, a: run.previous, s: run.next } as Record<string, () => void>)[key];
      if (letter) act(letter);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [active, root]);
}
