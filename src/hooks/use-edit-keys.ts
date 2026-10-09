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
  previous: () => void; next: () => void; insert: () => void; overwrite: () => void;
  /** ⇧T: Avid's Toggle Source/Record in Timeline. */
  mode: () => void;
  /** ⌘C, ⌘X and ⌘V on the record's clips; each says false when it has nothing to act on, and the key does what it does in text instead. */
  copyClips: (cut: boolean) => boolean; pasteClips: () => boolean;
  /** ⇧F: Match Frame, the record clip under the playhead loaded into the source at the same frame (Premiere's F; F alone clears the Out here, as in Avid). */
  matchFrame: () => void;
  /**
   * The record tracks' trim and segment tools, after Neo's: U enters or leaves
   * Trim, ⇧R switches one-sided trims between ripple and overwrite. Each that
   * returns a boolean answers whether it acted, so the key can mean its usual
   * thing when there is nothing selected (M is still a marker, `,` and `.`
   * still nudge a clip when no roller is seated).
   */
  enterTrim: () => void; toggleRipple: () => void; selectAll: () => void;
  /** Neo's tool keys: ⇧A Selection, C Blade, N Roll, Y Slip, R Slide. */
  tool: (tool: "select" | "blade" | "roll" | "slip" | "slide") => void;
  trimBy: (frames: number) => boolean; nudgeClips: (frames: number) => boolean; clipTrack: (delta: -1 | 1) => boolean;
  deleteClips: (extract: boolean) => boolean; slip: (frames: number) => boolean; slide: (frames: number) => boolean;
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
      // Focus on the editor, on <body>, or on the view around it (the app
      // focuses the view when String Outs opens, and a click on the timeline,
      // which takes no focus itself, leaves it there) is the editor's.
      const editor = root.current;
      if (target !== document.body && !(editor && (editor.contains(target) || target.contains(editor)))) return;
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
      // Copy, cut and paste clips, outside text: the transcript and fields keep ⌘C, ⌘X and ⌘V for words,
      // and so does any text selected elsewhere (an Ask answer), which ⌘C copied clips over.
      if (on === "timeline" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && !target.closest(".cp-te-doc, input, textarea, [contenteditable=true]")
        && !(key !== "v" && window.getSelection()?.toString())) {
        if ((key === "c" || key === "x") && run.copyClips(key === "x")) return event.preventDefault();
        if (key === "v" && run.pasteClips()) return event.preventDefault();
      }
      if (on === "timeline" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        const chord = ({ b: run.cutHere, l: run.loop, "=": run.zoomIn, "-": run.zoomOut } as Record<string, () => void>)[key];
        if (chord) return act(chord);
      }
      // ⌥X was this editor's Clear Marks before G; kept so a habit still works.
      if (event.altKey && !event.metaKey && event.code === "KeyX") return act(() => run.clear("both", on));
      if (event.key === "Escape" && run.escape()) return event.preventDefault();
      // The record tracks' clips and rollers, from anywhere but the transcript's own text (which has its own Delete and arrows).
      if (on === "timeline" && !target.closest(".cp-te-doc")) {
        const by = event.shiftKey ? 10 : 1, plain = !event.metaKey && !event.ctrlKey && !event.altKey;
        if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && key === "a") return act(run.selectAll);
        // ⌥← ⌥→ trim; ⌥⌘← ⌥⌘→ slip the selected clip. ⇧ is ten frames.
        if (event.altKey && !event.ctrlKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          const sign = event.key === "ArrowLeft" ? -1 : 1;
          if (event.metaKey ? run.slip(sign * by) : run.trimBy(sign * by)) return event.preventDefault();
        }
        // , and . trim a frame (Avid's trim keys), or nudge the selected clips; ⌥ slides the selected clip.
        if (!event.metaKey && !event.ctrlKey && (event.code === "Comma" || event.code === "Period")) {
          const sign = event.code === "Comma" ? -1 : 1;
          if (event.altKey ? run.slide(sign * by) : run.trimBy(sign * by) || run.nudgeClips(sign * by)) return event.preventDefault();
        }
        // M and / trim ten frames while rollers are seated, as Avid's trim keys; otherwise M is a marker.
        if (plain && (event.code === "KeyM" || event.code === "Slash") && run.trimBy(event.code === "KeyM" ? -10 : 10)) return event.preventDefault();
        if (plain && (event.key === "Delete" || event.key === "Backspace") && run.deleteClips(event.shiftKey)) return event.preventDefault();
        if (plain && !event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && run.clipTrack(event.key === "ArrowUp" ? -1 : 1)) return event.preventDefault();
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (key === "v" && !event.shiftKey) return act(run.insert);
      if (key === "b" && !event.shiftKey) return act(run.overwrite);
      if (!event.shiftKey && MARKS[key]) return act(() => MARKS[key](run, on));
      if (on === "pane") return;
      // A divider's Home puts the divider back; everywhere else Home goes to the start.
      if (event.key === "Home" && !target.closest("[role=separator]")) return act(run.start);
      if (event.key === "End") return act(run.end);
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !target.closest(".cp-te-doc, [role=slider], [role=tablist], [role=separator], [role=radiogroup]")) {
        return act(() => run.step((event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1)));
      }
      if (event.shiftKey) { if (key === "z") act(run.zoomFit); if (key === "t") act(run.mode); if (key === "f") act(run.matchFrame); if (key === "r") act(run.toggleRipple); if (key === "a") act(() => run.tool("select")); return; }
      const letter = ({ z: run.lift, x: run.extract, m: run.marker, t: run.markClip, a: run.previous, s: run.next, u: run.enterTrim,
        c: () => run.tool("blade"), n: () => run.tool("roll"), y: () => run.tool("slip"), r: () => run.tool("slide") } as Record<string, () => void>)[key];
      if (letter) act(letter);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [active, root]);
}
