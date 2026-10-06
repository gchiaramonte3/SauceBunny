import { useEffect, type RefObject } from "react";
import type { FrameStore } from "../lib/frame-store";
import { useEditKeys, type EditKeySide } from "./use-edit-keys";
import type { EditSourceSide } from "./use-edit-source-side";
import type { useEditWorkspace } from "./use-edit-workspace";

type Playback = { frames: FrameStore; playing: boolean; toggle: () => Promise<void>; pause: () => void; seek: (frame: number, play?: boolean) => Promise<void> };
type Options = {
  root: RefObject<HTMLElement | null>; active: boolean; fps: number;
  ws: ReturnType<typeof useEditWorkspace>; side: EditSourceSide; playback: Playback;
  undo: () => void; redo: () => void; onHistory: () => void;
  loop: boolean; onLoop: () => void; onZoom: (change: (zoom: number) => number) => void; onSnap: () => void;
  /** What the source has marked, spliced in (V), appended, or laid over the record (B). */
  place: (how: "insert" | "append" | "overwrite") => void;
  /** Toggle Source/Record in Timeline (⇧T), through the same path as the corner switch. */
  onMode: (mode: "source" | "record") => void;
};

/** How far J steps back: the engine plays forward only, so J is a step back that repeats while it is held. */
const J_STEP_SECONDS = 1;

/**
 * Which monitor each key acts on, as Avid's keys follow the active monitor:
 * the source when focus is in the source pane or the timeline shows Source,
 * else the record. Record-only edits (Add Edit, Mark Clip, Lift, Extract,
 * markers, edit-to-edit) rest while the timeline shows Source, exactly as
 * their buttons do. Loop loops the side shown.
 */
export function useEditEditorKeys({ root, active, fps, ws, side, playback, undo, redo, onHistory, loop, onLoop, onZoom, onSnap, place, onMode }: Options) {
  const sourceShown = side.mode === "source";
  const onSource = (on: EditKeySide) => on === "pane" || sourceShown;
  const monitor = (on: EditKeySide) => onSource(on) ? side.playback : playback;
  const record = (action: () => void) => () => { if (!sourceShown) action(); };
  const marksOf = (on: EditKeySide) => onSource(on) ? side.marks : ws.marks;
  const length = sourceShown ? side.source?.duration ?? 0 : ws.total;

  const looped = sourceShown ? side.playback : playback;
  const [loopFrom, loopTo] = sourceShown
    ? side.marks.in != null && side.marks.out != null && side.marks.out > side.marks.in ? [side.marks.in, side.marks.out] : [0, length]
    : ws.marked ?? [0, length];
  // Loop watches the frame as it moves, rather than the editor re-rendering for every frame to ask.
  useEffect(() => {
    if (!loop || !looped.playing) return;
    const check = () => { if (looped.frames.get() / fps >= loopTo - 1 / fps) void looped.seek(Math.round(loopFrom * fps), true); };
    check();
    return looped.frames.subscribe(check);
  }, [loop, looped, loopFrom, loopTo, fps]);

  useEditKeys(root, active, {
    toggle: (on) => void monitor(on).toggle(), undo, redo, history: onHistory,
    start: () => void looped.seek(0), end: () => void looped.seek(Math.round(length * fps)),
    step: (frames) => void looped.seek(Math.max(0, looped.frames.get() + frames), false),
    cutHere: record(ws.cutHere), loop: onLoop, zoomIn: () => onZoom((zoom) => Math.min(32, zoom * 2)), zoomOut: () => onZoom((zoom) => Math.max(1, zoom / 2)), zoomFit: () => onZoom(() => 1),
    mode: () => onMode(side.mode === "source" ? "record" : "source"),
    escape: () => {
      if (ws.dead) { ws.setDead(null); return true; }
      if (ws.prompt) { ws.setPrompt(null); return true; }
      if (ws.extractGuard) { ws.setExtractGuard(null); return true; }
      return false;
    },
    mark: (edge, on) => (onSource(on) ? edge === "in" ? side.markIn : side.markOut : edge === "in" ? ws.markIn : ws.markOut)(),
    clear: (which, on) => {
      if (onSource(on)) return which === "both" ? side.clearMarks() : side.clearEdge(which);
      ws.setMarks((marks) => which === "both" ? { in: null, out: null } : { ...marks, [which]: null });
    },
    go: (edge, on) => { const to = marksOf(on)[edge]; if (to != null) void monitor(on).seek(Math.round(to * fps), false); },
    shuttle: (key, on) => {
      const engine = monitor(on);
      if (key === "l") { if (!engine.playing) void engine.toggle(); return; }
      engine.pause();
      if (key === "j") void engine.seek(Math.max(0, engine.frames.get() - Math.round(J_STEP_SECONDS * fps)), false);
    },
    lift: record(() => ws.takeMarked(false)), extract: record(() => ws.takeMarked(true)), marker: record(ws.addMarker), markClip: record(ws.markClip),
    // The edit points either side of the playhead, found when the key is pressed.
    previous: record(() => { const at = playback.frames.get() / fps, seam = [...ws.seams].reverse().find((item) => item.at < at - 1e-3); if (seam) ws.chooseSeam(seam.index); }),
    next: record(() => { const at = playback.frames.get() / fps, seam = ws.seams.find((item) => item.at > at + 1e-3); if (seam) ws.chooseSeam(seam.index); }),
    snap: onSnap, insert: () => place("insert"), overwrite: () => place("overwrite"),
  });
}
