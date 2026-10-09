import { doubledLane, extractProgram, layerClips, liftLayers, overwrite, spliceIn, type LayerClip, type Layering, type Placement, type Timeline } from "./edit-model";

/**
 * Trimming and moving clips on String Outs' record tracks, after Neo's trim
 * engine and Avid's rules (docs: Neo's AVID_TRIM_MODES_RESEARCH.md, re-made
 * here on String Outs' own model rather than copied). Every trim is a set of
 * ROLLERS moved by one shared number of frames:
 *
 * - A roller is a record track's cut and a side: A (the clip ending there),
 *   B (the clip starting there), or both, which is a ROLL: the cut moves and
 *   nothing else does.
 * - One side alone RIPPLES (Avid's yellow roller): the clip gets longer or
 *   shorter and everything after moves, on every track, so nothing slips out
 *   of sync. Lengthening puts filler on the other tracks; shortening takes the
 *   same frames from them, and is refused when another track has a clip there.
 * - One side alone with ripple off is an OVERWRITE trim (Avid's red roller):
 *   lengthening covers the neighbour on that track, shortening leaves filler,
 *   and nothing moves.
 *
 * A trim stops at the source's media, at one frame of clip, and at the next
 * clip on the track, and says which. All of it is positional edits on the
 * existing model (overwrite, lift, splice, extract), so the record's cut list
 * and every track's sync are kept by construction.
 */

/** A trim roller: a record track (1 for A1), a cut on it in program seconds, and the side that trims. */
export type Roller = { layer: number; at: number; side: "a" | "b" | "both" };
/** A clip picked on a record track, by where it starts. */
export type ClipPick = { layer: number; from: number };
/** What the trims need to know beyond the edit: who sits where, how long each source is, the frame rate, and (for refusals) people's names. */
export type TrimContext = { layering: Layering; durationOf: (source: string) => number; fps: number; nameOf?: (lane: string) => string };
export type TrimDone = { edit: Timeline; frames: number; limited: string | null; rollers: Roller[] };
export type Refused = { refusal: string };

const EPS = 1e-6;
const name = (layer: number) => `A${layer}`;

/** The refusal for putting someone on a track over a stretch where they already play on another one (doubledLane), or null. */
function doubled(edit: Timeline, program: number, length: number, placements: Placement[], ctx: TrimContext): Refused | null {
  const hit = doubledLane(edit, program, length, placements, ctx.layering);
  if (!hit) return null;
  return { refusal: `${ctx.nameOf?.(hit.lane) ?? hit.lane} already plays on ${name(hit.layer)} there, and a string out holds each person on one track at a time.` };
}

/** The clips either side of a cut on a track: A ends there, B starts there. Either may be filler (null). */
export function cutSides(clips: LayerClip[], at: number) {
  return { a: clips.find((clip) => Math.abs(clip.to - at) < EPS) ?? null, b: clips.find((clip) => Math.abs(clip.from - at) < EPS) ?? null };
}

/** Every cut on a track: wherever a clip starts or ends. */
export function cutsOn(clips: LayerClip[]): number[] {
  const out: number[] = [];
  for (const clip of clips) for (const at of [clip.from, clip.to]) if (!out.some((other) => Math.abs(other - at) < EPS)) out.push(at);
  return out.sort((a, b) => a - b);
}

/** The cut nearest `at` on any of these tracks, as rollers on both sides (Avid's U, Enter Trim). */
export function nearestCut(edit: Timeline, layers: number[], at: number, layering: Layering): Roller[] {
  let best: { layer: number; at: number } | null = null;
  for (const layer of layers) for (const cut of cutsOn(layerClips(edit, layer, layering))) {
    if (!best || Math.abs(cut - at) < Math.abs(best.at - at) - EPS) best = { layer, at: cut };
  }
  if (!best) return [];
  const chosen = best;
  // Every selected track with a cut at the same frame trims with it.
  return layers.filter((layer) => cutsOn(layerClips(edit, layer, layering)).some((cut) => Math.abs(cut - chosen.at) < EPS))
    .map((layer) => ({ layer, at: chosen.at, side: "both" as const }));
}

/** Where the next clip on the track starts after `at` (or never), and where the one before ends. */
const nextStart = (clips: LayerClip[], at: number) => clips.filter((clip) => clip.from > at - EPS).reduce((first, clip) => Math.min(first, clip.from), Infinity);
const previousEnd = (clips: LayerClip[], at: number) => clips.filter((clip) => clip.to < at + EPS).reduce((last, clip) => Math.max(last, clip.to), 0);

type Limit = { seconds: number; why: string };
const least = (limits: Limit[]): Limit => limits.reduce((low, limit) => limit.seconds < low.seconds ? limit : low, { seconds: Infinity, why: "" });

/**
 * How far one roller can move each way, in seconds, and what stops it:
 * `later` is room to move the cut right, `earlier` to move it left.
 */
function reach(roller: Roller, clips: LayerClip[], ripple: boolean, ctx: TrimContext): { later: Limit; earlier: Limit } | Refused {
  const frame = 1 / ctx.fps;
  const { a, b } = cutSides(clips, roller.at);
  if (!a && !b) return { refusal: `There is no edit on ${name(roller.layer)} there.` };
  const media = (clip: LayerClip, before: boolean): Limit => ({ seconds: before ? clip.srcIn : ctx.durationOf(clip.source) - clip.srcOut, why: "no more source media" });
  const keepOne = (clip: LayerClip): Limit => ({ seconds: clip.to - clip.from - frame, why: "one frame of clip" });
  const next: Limit = { seconds: (b ? b.to - frame : nextStart(clips, roller.at + EPS)) - roller.at, why: `the next clip on ${name(roller.layer)}` };
  const previous: Limit = { seconds: roller.at - (a ? a.from + frame : previousEnd(clips, roller.at - EPS)), why: `the clip before on ${name(roller.layer)}` };
  if (roller.side === "both" || (!ripple && roller.side === "a" && a) || (!ripple && roller.side === "b" && b)) {
    // Positional: the side that grows uses its media and covers the neighbour; the side that shrinks keeps a frame.
    const right = roller.side === "b" ? b ? [keepOne(b)] : [] : a ? [media(a, false), next] : b ? [keepOne(b)] : [];
    const left = roller.side === "a" ? a ? [keepOne(a)] : [] : b ? [media(b, true), previous] : a ? [keepOne(a)] : [];
    return { later: least(right), earlier: least(left) };
  }
  if (roller.side === "a") {
    if (!a) return { refusal: `There is no clip before this edit on ${name(roller.layer)} to trim.` };
    return { later: media(a, false), earlier: keepOne(a) };
  }
  if (!b) return { refusal: `There is no clip after this edit on ${name(roller.layer)} to trim.` };
  return { later: keepOne(b), earlier: media(b, true) };
}

/** A clip on a track overlapping (from, to), other than on `except`'s tracks. */
function clipIn(edit: Timeline, from: number, to: number, except: number[], ctx: TrimContext, layers: number) {
  for (let layer = 1; layer <= layers; layer++) {
    if (except.includes(layer)) continue;
    const hit = layerClips(edit, layer, ctx.layering).find((clip) => clip.from < to - EPS && clip.to > from + EPS);
    if (hit) return { layer, clip: hit };
  }
  return null;
}

/**
 * Trim: move every roller by `frames` (positive is right), as one trim.
 * Rollers are all rolls, or all one side; anything else is refused, as an
 * asymmetric set Avid would also have to be told how to read.
 */
export function trim(edit: Timeline, rollers: Roller[], frames: number, ripple: boolean, ctx: TrimContext, layers: number): TrimDone | Refused {
  if (!rollers.length) return { refusal: "Nothing to trim. Click an edit on a track, or press U." };
  const sides = new Set(rollers.map((roller) => roller.side));
  if (sides.size > 1) return { refusal: "These rollers do not make one trim. Put them all on the A side, the B side, or both." };
  const side = rollers[0].side;
  if (!frames) return { edit, frames: 0, limited: null, rollers };
  // One shared delta, clamped by every roller's room.
  const wanted = frames / ctx.fps;
  let room: Limit = { seconds: Infinity, why: "" };
  for (const roller of rollers) {
    const found = reach(roller, layerClips(edit, roller.layer, ctx.layering), ripple, ctx);
    if ("refusal" in found) return found;
    const limit = wanted > 0 ? found.later : found.earlier;
    if (limit.seconds < room.seconds) room = limit;
  }
  const allowed = Math.max(0, Math.floor(room.seconds * ctx.fps + 1e-6));
  const moved = Math.sign(frames) * Math.min(Math.abs(frames), allowed);
  if (!moved) return { refusal: `It cannot trim that way: ${room.why}.` };
  const limited = Math.abs(moved) < Math.abs(frames) ? room.why : null;
  const d = moved / ctx.fps;
  const ripples = ripple && side !== "both";
  // Ripple trims shorten every track: refused where another track has a clip there.
  if (ripples && ((side === "a" && d < 0) || (side === "b" && d > 0))) {
    const trimmed = rollers.map((roller) => roller.layer);
    for (const roller of rollers) {
      const [from, to] = side === "a" ? [roller.at + d, roller.at] : [roller.at, roller.at + d];
      const hit = clipIn(edit, from, to, trimmed, ctx, layers);
      if (hit) return { refusal: `That would take ${Math.abs(moved)} frames from ${name(hit.layer)} too, which is not in this trim. Add a roller on ${name(hit.layer)}, or trim without ripple.` };
    }
  }
  let next = edit;
  if (!ripples) {
    for (const roller of rollers) {
      const done = shift(next, roller, d, ctx);
      if ("refusal" in done) return done;
      next = done;
    }
  } else {
    // By cut, last first, so earlier cuts keep their place: a cut's tracks share one insertion.
    const cuts = [...new Set(rollers.map((roller) => roller.at))].sort((x, y) => y - x);
    for (const at of cuts) {
      const done = rippleAt(next, rollers.filter((roller) => Math.abs(roller.at - at) < EPS), d, ctx);
      if ("refusal" in done) return done;
      next = done;
    }
  }
  // Where the rollers are now: the cut moves with the trim, except a B-side ripple, whose cut stays put.
  const after = rollers.map((roller) => ({ ...roller, at: ripples && side === "b" ? roller.at : roller.at + d }));
  return { edit: next, frames: moved, limited, rollers: after };
}

/** A positional trim on one track: the growing side covers what is there, the shrinking side leaves filler. */
function shift(edit: Timeline, roller: Roller, d: number, ctx: TrimContext): Timeline | Refused {
  const { a, b } = cutSides(layerClips(edit, roller.layer, ctx.layering), roller.at);
  const at = roller.at, layer = roller.layer;
  const grows = d > 0 ? roller.side !== "b" && a : roller.side !== "a" && b;
  if (d > 0) {
    if (grows && a) return doubled(edit, at, d, [{ lane: a.lane, layer }], ctx) ?? overwrite(edit, a.source, a.srcOut, a.srcOut + d, at, [{ lane: a.lane, layer }], ctx.layering);
    return liftLayers(edit, at, at + d, [layer], ctx.layering);
  }
  if (grows && b) return doubled(edit, at + d, -d, [{ lane: b.lane, layer }], ctx) ?? overwrite(edit, b.source, b.srcIn + d, b.srcIn, at + d, [{ lane: b.lane, layer }], ctx.layering);
  return liftLayers(edit, at + d, at, [layer], ctx.layering);
}

/** A ripple trim at one cut, for every roller there: time opens or closes on every track. */
function rippleAt(edit: Timeline, rollers: Roller[], d: number, ctx: TrimContext): Timeline | Refused {
  const at = rollers[0].at, side = rollers[0].side;
  const closes = (side === "a" && d < 0) || (side === "b" && d > 0);
  if (closes) return side === "a" ? extractProgram(edit, at + d, at).edit : extractProgram(edit, at, at + d).edit;
  // Opening: each roller's clip goes on for |d| (A from its end, B from before its start); other tracks get filler.
  const length = Math.abs(d);
  let next = edit, opened = false;
  for (const roller of rollers) {
    const { a, b } = cutSides(layerClips(edit, roller.layer, ctx.layering), at);
    const clip = side === "a" ? a : b;
    if (!clip) continue;
    const srcIn = side === "a" ? clip.srcOut : clip.srcIn - length;
    const placement = [{ lane: clip.lane, layer: roller.layer }];
    if (!opened) { next = spliceIn(next, clip.source, srcIn, srcIn + length, at, placement); opened = true; continue; }
    const refused = doubled(next, at, length, placement, ctx);
    if (refused) return refused;
    next = overwrite(next, clip.source, srcIn, srcIn + length, at, placement, ctx.layering);
  }
  return next;
}

/** The clip a pick names, on the current edit. */
export function pickedClip(edit: Timeline, pick: ClipPick, layering: Layering): LayerClip | null {
  return layerClips(edit, pick.layer, layering).find((clip) => Math.abs(clip.from - pick.from) < EPS) ?? null;
}

/** Slip: the clip keeps its place and length on its track and plays `frames` later (or earlier) in its source. */
export function slip(edit: Timeline, pick: ClipPick, frames: number, ctx: TrimContext): TrimDone | Refused {
  const clip = pickedClip(edit, pick, ctx.layering);
  if (!clip) return { refusal: "Select a clip to slip." };
  const room = frames > 0 ? ctx.durationOf(clip.source) - clip.srcOut : clip.srcIn;
  const moved = Math.sign(frames) * Math.min(Math.abs(frames), Math.floor(room * ctx.fps + 1e-6));
  if (!moved) return { refusal: "It cannot slip that way: no more source media." };
  const d = moved / ctx.fps;
  const next = overwrite(edit, clip.source, clip.srcIn + d, clip.srcOut + d, clip.from, [{ lane: clip.lane, layer: pick.layer }], ctx.layering);
  return { edit: next, frames: moved, limited: Math.abs(moved) < Math.abs(frames) ? "no more source media" : null, rollers: [] };
}

/**
 * Slide: the clip keeps its content and moves along its track; the clip before
 * it grows into the space it leaves and the one after gives way (filler where
 * there is none).
 */
export function slide(edit: Timeline, pick: ClipPick, frames: number, ctx: TrimContext): (TrimDone & { pick: ClipPick }) | Refused {
  const clips = layerClips(edit, pick.layer, ctx.layering);
  const clip = clips.find((item) => Math.abs(item.from - pick.from) < EPS);
  if (!clip) return { refusal: "Select a clip to slide." };
  const frame = 1 / ctx.fps;
  const { a: before } = cutSides(clips, clip.from), { b: after } = cutSides(clips, clip.to);
  const room = frames > 0
    ? least([{ seconds: after ? after.to - frame - clip.to : nextStart(clips, clip.to + EPS) - clip.to, why: `the next clip on ${name(pick.layer)}` },
      ...(before ? [{ seconds: ctx.durationOf(before.source) - before.srcOut, why: "no more source media" }] : [])])
    : least([{ seconds: before ? clip.from - before.from - frame : clip.from - previousEnd(clips, clip.from - EPS), why: `the clip before on ${name(pick.layer)}` },
      ...(after ? [{ seconds: after.srcIn, why: "no more source media" }] : [])]);
  const moved = Math.sign(frames) * Math.min(Math.abs(frames), Math.floor(room.seconds * ctx.fps + 1e-6));
  if (!moved) return { refusal: `It cannot slide that way: ${room.why}.` };
  const d = moved / ctx.fps, layer = pick.layer;
  // The clip at its new place, over whatever is there on its track.
  const landing = doubled(edit, clip.from + d, clip.to - clip.from, [{ lane: clip.lane, layer }], ctx);
  if (landing) return landing;
  let next = overwrite(edit, clip.source, clip.srcIn, clip.srcOut, clip.from + d, [{ lane: clip.lane, layer }], ctx.layering);
  // The space it left: the neighbour on that side carries on into it, or it is filler.
  const [gapFrom, gapTo] = d > 0 ? [clip.from, clip.from + d] : [clip.to + d, clip.to];
  const fill = d > 0 ? before : after;
  const filling = fill && doubled(next, gapFrom, gapTo - gapFrom, [{ lane: fill.lane, layer }], ctx);
  if (filling) return filling;
  next = fill ? overwrite(next, fill.source, d > 0 ? fill.srcOut : fill.srcIn + d, d > 0 ? fill.srcOut + d : fill.srcIn, gapFrom, [{ lane: fill.lane, layer }], ctx.layering)
    : liftLayers(next, gapFrom, gapTo, [layer], ctx.layering);
  return { edit: next, frames: moved, limited: Math.abs(moved) < Math.abs(frames) ? room.why : null, rollers: [], pick: { layer, from: clip.from + d } };
}

/**
 * Move clips (a nudge, a drag, a step to another track), as Avid's red
 * segment arrow: each leaves filler where it was and overwrites where it lands.
 * A copy (⌥-drag, as in Media Composer) leaves the originals where they are.
 * Returns where the picks are now.
 */
export function moveClips(edit: Timeline, picks: ClipPick[], frames: number, tracks: number, ctx: TrimContext, copy = false): { edit: Timeline; picks: ClipPick[] } | Refused {
  const clips = picks.map((pick) => ({ pick, clip: pickedClip(edit, pick, ctx.layering) }));
  if (!clips.length || clips.some((item) => !item.clip)) return { refusal: "Select a clip to move." };
  const d = frames / ctx.fps;
  for (const { pick, clip } of clips) {
    if (clip!.from + d < -EPS) return { refusal: "That would move a clip before the start of the string out." };
    if (pick.layer + tracks < 1) return { refusal: "There is no track above A1." };
    if (pick.layer + tracks > 64) return { refusal: "Media Composer takes 64 audio tracks." };
  }
  if (copy && !frames && !tracks) return { refusal: "Drag the copy somewhere else first." };
  let next = edit;
  if (!copy) for (const { pick, clip } of clips) next = liftLayers(next, clip!.from, clip!.to, [pick.layer], ctx.layering);
  for (const { pick, clip } of clips) {
    const placement = [{ lane: clip!.lane, layer: pick.layer + tracks }];
    const refused = doubled(next, clip!.from + d, clip!.to - clip!.from, placement, ctx);
    if (refused) return refused;
    next = overwrite(next, clip!.source, clip!.srcIn, clip!.srcOut, clip!.from + d, placement, ctx.layering);
  }
  return { edit: next, picks: clips.map(({ pick, clip }) => ({ layer: pick.layer + tracks, from: clip!.from + d })) };
}

/** Clips held by Copy or Cut: what each plays, on which track, and how far after the first it starts. */
export type ClipCopy = { layer: number; lane: string; source: string; srcIn: number; srcOut: number; offset: number };

/** Copy (⌘C): the picked clips as they are now, measured from the earliest. */
export function copyClips(edit: Timeline, picks: ClipPick[], layering: Layering): ClipCopy[] {
  const clips = picks.flatMap((pick) => { const clip = pickedClip(edit, pick, layering); return clip ? [{ pick, clip }] : []; });
  const first = Math.min(...clips.map(({ clip }) => clip.from));
  return clips.map(({ pick, clip }) => ({ layer: pick.layer, lane: clip.lane, source: clip.source, srcIn: clip.srcIn, srcOut: clip.srcOut, offset: clip.from - first }));
}

/**
 * Paste (⌘V): copied clips laid over the record at `at`, each on the track it
 * was copied from and as far after the first as it was, overwriting what is
 * there (Avid's Overwrite of a clipboard, Premiere's paste). Returns where
 * they landed, as picks.
 */
export function pasteClips(edit: Timeline, copied: ClipCopy[], at: number, ctx: TrimContext): { edit: Timeline; picks: ClipPick[] } | Refused {
  if (!copied.length) return { refusal: "Nothing is copied. Select clips and press ⌘C first." };
  let next = edit;
  for (const clip of copied) {
    const placement = [{ lane: clip.lane, layer: clip.layer }], from = at + clip.offset;
    const refused = doubled(next, from, clip.srcOut - clip.srcIn, placement, ctx);
    if (refused) return refused;
    next = overwrite(next, clip.source, clip.srcIn, clip.srcOut, from, placement, ctx.layering);
  }
  return { edit: next, picks: copied.map((clip) => ({ layer: clip.layer, from: at + clip.offset })) };
}

/** Lift clips (Delete): filler where each was, on its own track; nothing moves. */
export function liftClips(edit: Timeline, picks: ClipPick[], layering: Layering): Timeline {
  let next = edit;
  for (const pick of picks) {
    const clip = pickedClip(next, pick, layering);
    if (clip) next = liftLayers(next, clip.from, clip.to, [pick.layer], layering);
  }
  return next;
}

/**
 * Extract clips (⇧Delete): each clip's time comes out of every track, so
 * nothing slips out of sync. `caught` names other tracks' clips the same time
 * would take, for the caller to ask about first.
 */
export function extractClips(edit: Timeline, picks: ClipPick[], ctx: TrimContext, layers: number): { edit: Timeline; caught: number[] } {
  const spans = picks.flatMap((pick) => { const clip = pickedClip(edit, pick, ctx.layering); return clip ? [{ layer: pick.layer, from: clip.from, to: clip.to }] : []; });
  const mine = spans.map((span) => span.layer);
  const caught = [...new Set(spans.flatMap((span) => { const hit = clipIn(edit, span.from, span.to, mine, ctx, layers); return hit ? [hit.layer] : []; }))];
  let next = edit;
  // Last first, merged where spans overlap, so earlier spans keep their place.
  const merged: [number, number][] = [];
  for (const span of [...spans].sort((x, y) => x.from - y.from)) {
    const last = merged[merged.length - 1];
    if (last && span.from <= last[1] + EPS) last[1] = Math.max(last[1], span.to); else merged.push([span.from, span.to]);
  }
  for (const [from, to] of merged.reverse()) next = extractProgram(next, from, to).edit;
  return { edit: next, caught };
}
