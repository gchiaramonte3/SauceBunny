import { useEffect, useRef, useState } from "react";
import { cutSides, cutsOn, moveClips, pickedClip, slide, slip, trim, type ClipPick, type Roller } from "../lib/edit-trim";
import { layerClips, type LayerClip, type Layering, type Timeline } from "../lib/edit-model";
import type { useEditWorkspace } from "./use-edit-workspace";

/** The record timeline's tools, after Neo's (and its keys): Selection ⇧A, Blade C, Roll N, Slip Y, Slide R. */
export type RecordTool = "select" | "blade" | "roll" | "slip" | "slide";

type Workspace = ReturnType<typeof useEditWorkspace>;
type Options = {
  ws: Workspace; tool: RecordTool; start: number; span: number; snap: boolean;
  /** The record playhead in seconds, read when a gesture needs it, and parking it. */
  playhead: () => number; seek: (seconds: number) => void;
  /** Scroll the view to start at these seconds, for a drag held at its edge. */
  pan?: (seconds: number) => void;
};
/** A held drag: where it began, on which track, at what scale, how many tracks a move has crossed, and the lane holding the pointer. */
/** A held drag: where it began (on screen, and where the view started then), on which track, at what scale, the tracks a move has crossed, and the lane holding the pointer. */
type Held = { x: number; y: number; start: number; box: DOMRect; layer: number; pxPerSecond: number; tracks: number; lane: HTMLElement; last?: string };
type Drag = (Held & { kind: "trim" | "slip" | "slide" | "move" }) | (Held & { kind: "lasso"; at: number });
/** What a press at a point on a track takes hold of. */
type Zone = { kind: "roller"; roller: Roller } | { kind: "clip"; clip: LayerClip } | { kind: "empty" };
/** The running count beside the pointer while a drag is held, as Avid's trim counter. */
export type DragReadout = { left: number; top: number; text: string };

/** How near a cut, in pixels, a press takes it: a roll within ROLL_PX, one side out to SIDE_PX (Neo's zones). */
const ROLL_PX = 4, SIDE_PX = 14;
/** How far, in pixels, a dragged edge or clip reaches for a cut or the playhead. */
const SNAP_PX = 8;
/** Within EDGE_PX of the timeline's edge a held drag scrolls it, faster the deeper it goes (Neo's edge scroll). */
const EDGE_PX = 48, EDGE_MIN_PX = 2, EDGE_MAX_PX = 14;
/** Pixels to scroll this frame for a pointer at `clientX`: negative at the left edge, positive at the right, 0 between. */
export function edgeStep(clientX: number, box: { left: number; right: number }) {
  const zone = Math.min(EDGE_PX, (box.right - box.left) / 4);
  if (!(zone > 0)) return 0;
  const left = box.left + zone - clientX, right = clientX - (box.right - zone);
  const depth = left > 0 ? -Math.min(1, left / zone) : right > 0 ? Math.min(1, right / zone) : 0;
  return depth && Math.sign(depth) * (EDGE_MIN_PX + (EDGE_MAX_PX - EDGE_MIN_PX) * Math.abs(depth));
}
const EPS = 1e-6;

/**
 * Pointer gestures on the record tracks, as Neo's timeline has them. Every
 * drag previews its result (a draft of the edit the rows draw) and commits
 * once, on release, through the same workspace action a key would use, so a
 * drag and a key cannot disagree about what an edit does.
 *
 * With the Selection tool a clip's body moves it (⌥ copies it, as Media
 * Composer's Option-drag does), its ends trim it (ripple or overwrite, as the
 * Ripple switch says), and the line between two clips rolls. The pointer
 * shows which before the press. Esc drops a drag that is under way.
 */
export function useRecordGestures({ ws, tool, start, span, snap, playhead, seek, pan }: Options) {
  const [draft, setDraft] = useState<Timeline | null>(null);
  const [lasso, setLasso] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [readout, setReadout] = useState<DragReadout | null>(null);
  const drag = useRef<Drag | null>(null), moved = useRef(0);
  const fps = ws.trimContext.fps;
  // Where the view starts now: a drag counts frames from where it began in TIME, so the view can scroll under it.
  const view = useRef(start); view.current = start;
  const edge = useRef<{ raf: number; event: React.PointerEvent<HTMLElement> | null }>({ raf: 0, event: null });
  const countOf = (event: { clientX: number }, current: Held) => Math.round(((event.clientX - current.x) / current.pxPerSecond + view.current - current.start) * fps);
  const frame = (seconds: number) => Math.round(seconds * fps) / fps;
  const timeAt = (event: React.PointerEvent<HTMLElement>, box: DOMRect) => start + ((event.clientX - box.left) / box.width) * span;

  // Each track's clips on the current edit, worked out once per edit rather than on every pointer move.
  const cache = useRef<{ edit: Timeline; layering: Layering; byLayer: Map<number, LayerClip[]> } | null>(null);
  const clipsOn = (layer: number) => {
    if (cache.current?.edit !== ws.edit || cache.current.layering !== ws.layering) cache.current = { edit: ws.edit, layering: ws.layering, byLayer: new Map() };
    let list = cache.current.byLayer.get(layer);
    if (!list) { list = layerClips(ws.edit, layer, ws.layering); cache.current.byLayer.set(layer, list); }
    return list;
  };

  // The record track under the pointer, for a drag that changes track.
  const layerUnder = (event: React.PointerEvent<HTMLElement>) => {
    const lane = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-record-layer]");
    return lane ? Number(lane.dataset.recordLayer) : null;
  };

  /**
   * What the Selection tool takes at this point: a roll within a few pixels of
   * the line between two clips, a clip's own end out to SIDE_PX inside it (a
   * third of a short clip at most, so its body stays grabbable), or the clip.
   * Just outside a clip that has filler beside it, the near pixels still take
   * that clip's end, since there is nothing on the other side to roll against.
   */
  const zoneAt = (layer: number, at: number, pxPerSecond: number): Zone => {
    const clips = clipsOn(layer);
    const hit = clips.find((clip) => clip.from - EPS <= at && at < clip.to - EPS) ?? null;
    const cut = cutsOn(clips).reduce<number | null>((best, value) => best == null || Math.abs(value - at) < Math.abs(best - at) ? value : best, null);
    if (cut != null) {
      const distance = Math.abs(cut - at) * pxPerSecond, { a, b } = cutSides(clips, cut);
      if (tool === "roll") return { kind: "roller", roller: { layer, at: cut, side: "both" } };
      const reach = hit ? Math.min(SIDE_PX, ((hit.to - hit.from) * pxPerSecond) / 3) : ROLL_PX;
      if (distance <= ROLL_PX && a && b) return { kind: "roller", roller: { layer, at: cut, side: "both" } };
      if (distance <= reach) {
        const side: Roller["side"] = hit ? (Math.abs(hit.to - cut) < EPS ? "a" : "b") : a ? "a" : "b";
        return { kind: "roller", roller: { layer, at: cut, side } };
      }
    }
    return hit ? { kind: "clip", clip: hit } : { kind: "empty" };
  };

  const down = (layer: number) => (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const lane = event.currentTarget, box = lane.getBoundingClientRect(), pxPerSecond = box.width / span;
    const at = timeAt(event, box);
    const add = event.shiftKey || event.metaKey;
    const begin = (kind: Drag["kind"]) => {
      lane.setPointerCapture(event.pointerId); moved.current = 0;
      drag.current = { kind, x: event.clientX, y: event.clientY, start, box, layer, pxPerSecond, tracks: 0, lane } as Drag;
      lane.dataset.zone = kind === "move" ? "moving" : lane.dataset.zone ?? "";
    };
    if (tool === "blade") {
      if (!clipsOn(layer).some((clip) => clip.from - EPS <= at && at < clip.to - EPS)) return;
      // Onto the playhead when the press is within a few pixels of it, as a blade snaps.
      const here = Math.abs(playhead() - at) * pxPerSecond < 6 ? playhead() : frame(at);
      ws.blade(here, layer);
      return;
    }
    const zone = zoneAt(layer, at, pxPerSecond);
    if (zone.kind === "roller") {
      ws.pickRoller(zone.roller, event.shiftKey);
      begin("trim");
      return;
    }
    if (tool === "slip" || tool === "slide") {
      if (zone.kind !== "clip") return;
      ws.pickClip({ layer, from: zone.clip.from }, false);
      begin(tool);
      return;
    }
    if (zone.kind === "clip") {
      const already = ws.picks.some((pick) => pick.layer === layer && Math.abs(pick.from - zone.clip.from) < EPS);
      if (add || !already) ws.pickClip({ layer, from: zone.clip.from }, add);
      if (!add) begin("move");
      return;
    }
    // Empty track: clear, park the playhead, and a drag from here is a lasso.
    ws.pickClip(null, false);
    seek(frame(Math.max(0, at)));
    lane.setPointerCapture(event.pointerId);
    moved.current = 0;
    drag.current = { kind: "lasso", x: event.clientX, y: event.clientY, start, box, layer, pxPerSecond, tracks: 0, lane, at };
  };

  // Before a press: the pointer says what a press there would take hold of.
  const hover = (layer: number, event: React.PointerEvent<HTMLElement>) => {
    if (tool !== "select" && tool !== "roll") return;
    const lane = event.currentTarget, box = lane.getBoundingClientRect();
    const zone = zoneAt(layer, timeAt(event, box), box.width / span);
    const name = zone.kind === "roller" ? zone.roller.side === "both" ? "roll" : "trim" : zone.kind;
    if (lane.dataset.zone !== name) lane.dataset.zone = name;
  };

  const move = (layer: number) => (event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return hover(layer, event);
    moved.current = Math.max(moved.current, Math.abs(event.clientX - current.x), Math.abs(event.clientY - current.y));
    if (moved.current < 3) return;
    if (current.kind === "lasso") return lassoTo(event, current);
    // Held at the edge, the view scrolls and the drag goes on with it.
    edge.current.event = event;
    if (pan && !edge.current.raf && edgeStep(event.clientX, current.box)) edge.current.raf = requestAnimationFrame(scroll);
    follow(event, current);
  };
  // Every frame while the pointer is in the edge band: scroll, then redo the drag at the pointer, which now means a later or earlier time.
  const latest = useRef<(event: React.PointerEvent<HTMLElement>, current: Drag) => void>(() => {});
  const scroll = () => {
    const current = drag.current, event = edge.current.event, step = current && event ? edgeStep(event.clientX, current.box) : 0;
    if (!current || !event || !step || !pan) { edge.current.raf = 0; return; }
    pan(Math.max(0, view.current + step / current.pxPerSecond));
    latest.current(event, current);
    edge.current.raf = requestAnimationFrame(scroll);
  };
  const follow = (event: React.PointerEvent<HTMLElement>, current: Drag) => {
    const count = countOf(event, current), ctx = ws.trimContext;
    // The draft only changes when the frame count, the track or ⌥ does; a pixel inside one frame redraws nothing.
    const under = current.kind === "move" ? layerUnder(event) : null;
    const key = `${count}:${under ?? ""}:${event.altKey}`;
    if (key === current.last) { setReadout((shown) => shown && { ...shown, left: event.clientX + 14, top: event.clientY - 30 }); return; }
    current.last = key;
    const show = (text: string) => setReadout({ left: event.clientX + 14, top: event.clientY - 30, text });
    if (current.kind === "trim") {
      const result = trim(ws.edit, ws.rollers, snapTrim(count), ws.rippleTrim, ctx, ws.layerTotal);
      setDraft("refusal" in result ? null : result.edit);
      show("refusal" in result ? result.refusal : counted(result.frames, result.limited));
      return;
    }
    const pick = ws.picks[0] ?? null;
    if ((current.kind === "slip" || current.kind === "slide") && pick) {
      const result = current.kind === "slip" ? slip(ws.edit, pick, -count, ctx) : slide(ws.edit, pick, count, ctx);
      setDraft("refusal" in result ? null : result.edit);
      show("refusal" in result ? result.refusal : counted(current.kind === "slip" ? -result.frames : result.frames, result.limited));
      return;
    }
    if (current.kind === "move") {
      // Over a header or past the last track, the clip stays on the track it was last over.
      if (under != null) current.tracks = under - current.layer;
      const frames = snapMove(count), copy = event.altKey;
      const result = moveClips(ws.edit, ws.picks, frames, current.tracks, ctx, copy);
      setDraft("refusal" in result ? null : result.edit);
      const to = current.tracks ? ` to A${current.layer + current.tracks}` : "";
      show("refusal" in result ? result.refusal : `${copy ? "Copy" : "Move"} ${signed(frames)}${to}`);
    }
  };

  /** A count of frames as the readout says it, and where a trim stopped. */
  const counted = (frames: number, limited: string | null) => `${signed(frames)}${limited ? `, stopped at ${limited}` : ""}`;
  const signed = (frames: number) => `${frames > 0 ? "+" : frames < 0 ? "−" : ""}${Math.abs(frames)} frame${Math.abs(frames) === 1 ? "" : "s"}`;

  // What a dragged edge or clip snaps to: every cut on every track, and the playhead.
  const targets = () => [playhead(), ...Array.from({ length: ws.layerTotal }, (_, index) => cutsOn(clipsOn(index + 1))).flat()];
  /** The nearest frame count that puts one of `edges` on a target within SNAP_PX, or the count as dragged. */
  const snapped = (edges: number[], count: number) => {
    if (!snap || !drag.current || !edges.length) return count;
    const reach = SNAP_PX / drag.current.pxPerSecond, d = count / fps, all = targets();
    let best: number | null = null;
    for (const edge of edges) for (const target of all) {
      const shift = target - edge;
      // A target at the edge's own place would hold every small drag at zero.
      if (Math.abs(shift) < EPS) continue;
      if (Math.abs(shift - d) <= reach && (best == null || Math.abs(shift - d) < Math.abs(best - d))) best = shift;
    }
    return best == null ? count : Math.round(best * fps);
  };
  // A moved clip lands its start or its end on a cut or the playhead; a trimmed edge does the same.
  const snapMove = (count: number) => snapped(ws.picks.flatMap((pick) => { const clip = pickedClip(ws.edit, pick, ws.layering); return clip ? [clip.from, clip.to] : []; }), count);
  const snapTrim = (count: number) => snapped(ws.rollers.map((roller) => roller.at), count);

  const lassoTo = (event: React.PointerEvent<HTMLElement>, current: Extract<Drag, { kind: "lasso" }>) => {
    const left = Math.min(event.clientX, current.x), right = Math.max(event.clientX, current.x);
    const top = Math.min(event.clientY, current.y), bottom = Math.max(event.clientY, current.y);
    setLasso({ left, top, width: right - left, height: bottom - top });
    const from = start + ((left - current.box.left) / current.box.width) * span, to = start + ((right - current.box.left) / current.box.width) * span;
    // The record tracks the box crosses.
    const lanes = [...document.querySelectorAll<HTMLElement>("[data-record-layer]")].filter((lane) => {
      const rect = lane.getBoundingClientRect();
      return rect.bottom > top && rect.top < bottom;
    }).map((lane) => Number(lane.dataset.recordLayer));
    // One cut inside the box on each track and no whole clip: those cuts roll (Neo's lasso). Otherwise the clips it touches.
    const cuts = lanes.map((layer) => ({ layer, cuts: cutsOn(clipsOn(layer)).filter((cut) => cut > from + EPS && cut < to - EPS) }));
    const picks: ClipPick[] = lanes.flatMap((layer) => clipsOn(layer).filter((clip) => clip.from < to - EPS && clip.to > from + EPS).map((clip) => ({ layer, from: clip.from })));
    const whole = lanes.some((layer) => clipsOn(layer).some((clip) => clip.from >= from - EPS && clip.to <= to + EPS));
    if (cuts.length && cuts.every((item) => item.cuts.length === 1) && !whole) {
      ws.setPicks([]); ws.setRollers(cuts.map((item) => ({ layer: item.layer, at: item.cuts[0], side: "both" })));
    } else { ws.setRollers([]); ws.setPicks(picks); }
  };

  latest.current = follow;
  const end = () => {
    if (drag.current) delete drag.current.lane.dataset.zone;
    cancelAnimationFrame(edge.current.raf); edge.current = { raf: 0, event: null };
    drag.current = null; setDraft(null); setLasso(null); setReadout(null);
  };
  const up = (event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current;
    end();
    if (!current || moved.current < 3) return;
    const count = countOf(event, current);
    if (current.kind === "trim") { const frames = snapTrim(count); if (frames) ws.trimBy(frames); }
    if (current.kind === "slip" && count) ws.slipBy(-count);
    if (current.kind === "slide" && count) ws.slideBy(count);
    if (current.kind === "move") {
      const under = layerUnder(event);
      if (under != null) current.tracks = under - current.layer;
      const frames = snapMove(count);
      if (frames || current.tracks) ws.shiftClips(frames, current.tracks, event.altKey);
    }
  };

  // Esc while a drag is held drops it: nothing is committed and the edit is as it was.
  const holding = draft != null || lasso != null || readout != null;
  useEffect(() => {
    if (!holding) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !drag.current) return;
      event.preventDefault(); event.stopPropagation();
      delete drag.current.lane.dataset.zone;
      cancelAnimationFrame(edge.current.raf); edge.current = { raf: 0, event: null };
      drag.current = null; setDraft(null); setLasso(null); setReadout(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [holding]);

  return {
    draft, lasso, readout,
    handlers: (layer: number) => ({ onPointerDown: down(layer), onPointerMove: move(layer), onPointerUp: up, onPointerCancel: end,
      onPointerLeave: (event: React.PointerEvent<HTMLElement>) => { if (!drag.current) delete event.currentTarget.dataset.zone; } }),
  };
}
