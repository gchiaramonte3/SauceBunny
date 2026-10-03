import { useEffect, useRef, type RefObject } from "react";

/** Which monitor a key acts on: the source when focus is in the source pane, else whichever side the timeline shows. */
export type EditKeySide = "pane" | "timeline";

/**
 * One action per key. Letters are Avid's: I and O mark, G clears both marks,
 * D clears In, F clears Out, Q and W go to In and Out, T marks the clip, V
 * splices in, B overwrites, Z lifts, X extracts, J K L shuttle, A and S go to
 * the previous and next edit. ⌘ chords are the app's.
 */
export type EditKeyActions = {
  toggle: (on: EditKeySide) => void; undo: () => void; redo: () => void; history: () => void;
  cutHere: () => void; loop: () => void; zoomIn: () => void; zoomOut: () => void; zoomFit: () => void;
  escape: () => boolean;
  mark: (edge: "in" | "out", on: EditKeySide) => void;
  clear: (which: "in" | "out" | "both", on: EditKeySide) => void;
  go: (edge: "in" | "out", on: EditKeySide) => void;
  shuttle: (key: "j" | "k" | "l", on: EditKeySide) => void;
  step: (frames: number) => void; start: () => void; end: () => void;
  lift: () => void; extract: () => void; marker: () => void; markClip: () => void;
  snap: () => void; previous: () => void; next: () => void; insert: () => void; overwrite: () => void;
  /** ⇧T: Avid's Toggle Source/Record in Timeline. */
  mode: () => void;
};

/** Whether focus is drawn on an element; a browser without :focus-visible counts every focus as shown. */
const showsFocus = (element: Element) => { try { return element.matches(":focus-visible"); } catch { return true; } };

const MARKS: Record<string, (run: EditKeyActions, on: EditKeySide) => void> = {
  i: (run, on) => run.mark("in", on), o: (run, on) => run.mark("out", on),
  g: (run, on) => run.clear("both", on), d: (run, on) => run.clear("in", on), f: (run, on) => run.clear("out", on),
  q: (run, on) => run.go("in", on), w: (run, on) => run.go("out", on),
  j: (run, on) => run.shuttle("j", on), k: (run, on) => run.shuttle("k", on), l: (run, on) => run.shuttle("l", on),
};

/**
 * The editor's keyboard, while its view is showing. On the window rather than
 * the root: after a button disables itself focus falls to <body>, and ⌘Z
 * still has to reach the edit. Nothing fires inside a field or a dialog. In
 * the source pane Space, the marking keys, J K L, V and B act, on the source.
 * Arrows step a frame unless focus is in text or a control that owns them.
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
      const on: EditKeySide = target.closest("[data-source-id]") ? "pane" : "timeline";
      const act = (action: () => void) => { event.preventDefault(); event.stopPropagation(); action(); };
      // A button clicked with the mouse keeps focus without showing it; Space
      // then plays, as in every editor. Reached by keyboard, Space presses it.
      const pressable = target.closest("button, [role=separator], [role=tab], [role=slider]");
      if (event.key === " " && (!pressable || (pressable.matches("button") && !showsFocus(pressable)))) return act(() => run.toggle(on));
      if (event.metaKey && !event.ctrlKey && key === "z") return act(event.shiftKey ? run.redo : run.undo);
      if (event.metaKey && !event.ctrlKey && !event.altKey && key === "y") return act(run.history);
      if (on === "timeline" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const chord = ({ b: run.cutHere, l: run.loop, "=": run.zoomIn, "-": run.zoomOut } as Record<string, () => void>)[key];
        if (chord) return act(chord);
      }
      // ⌥X was this editor's Clear Marks before G; kept so a habit still works.
      if (event.altKey && !event.metaKey && event.code === "KeyX") return act(() => run.clear("both", on));
      if (event.key === "Escape" && run.escape()) return event.preventDefault();
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (key === "v" && !event.shiftKey) return act(run.insert);
      if (key === "b" && !event.shiftKey) return act(run.overwrite);
      if (!event.shiftKey && MARKS[key]) return act(() => MARKS[key](run, on));
      if (on === "pane") return;
      if (event.key === "Home") return act(run.start);
      if (event.key === "End") return act(run.end);
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !target.closest(".cp-te-doc, [role=slider], [role=tablist], [role=separator], [role=radiogroup]")) {
        return act(() => run.step((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1)));
      }
      if (event.shiftKey) { if (key === "z") act(run.zoomFit); if (key === "t") act(run.mode); return; }
      const letter = ({ z: run.lift, x: run.extract, m: run.marker, t: run.markClip, n: run.snap, a: run.previous, s: run.next } as Record<string, () => void>)[key];
      if (letter) act(letter);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [active, root]);
}
