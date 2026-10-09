import type { EditDocument } from "../bindings/EditDocument";
import type { EditMute } from "../bindings/EditMute";

/**
 * Each clip focused on the people its markers name (owner request,
 * 2026-10-07). Ask lays a bite out with every mic that talks in it open, so a
 * reaction plays where it happened; in a crowd that is everyone. "Crowd
 * Cheers And Encouragement" opened 23 mics a bite on average for lines from
 * 1.3 people, and the line a marker named was lost under the rest.
 *
 * So in each clip with a marker on a person, everyone else in it is muted for
 * the clip: still on their track with their words struck, and Unmute (a
 * right-click on their line, or ⇧⌫) brings any of them back. A mute holds for
 * that stretch of a mic wherever it plays, so a person is never muted over
 * source that one of their own marked lines plays elsewhere. A clip with no
 * marker on a person is left as it is, and so is anyone whose track plays
 * something else in the clip. A muted stretch reaches Media Composer as its
 * muted clip, so Unmute Clip there brings the person back too.
 */
export function focusOnMarkers(document: EditDocument): { document: EditDocument; clips: number } {
  const patched = document.tracks.filter((track) => track.featured !== false).map((track) => track.id);
  const key = (source: string, lane: string) => `${source}\n${lane}`;
  const spoken = new Map<string, [number, number][]>();
  const quiet: { segment: number; source: string; lane: string; from: number; to: number }[] = [];
  let at = 0;
  document.segments.forEach((segment, index) => {
    if (segment.kind === "gap") { at += segment.frames; return; }
    const length = segment.out_frame - segment.in_frame;
    const lanes = (segment.tracks ?? patched).filter((lane) => !segment.overrides?.[lane]);
    const named = new Set(document.markers.filter((marker) => marker.track && marker.frame >= at && marker.frame < at + length).map((marker) => marker.track as string));
    const cited = lanes.filter((lane) => named.has(lane));
    at += length;
    if (!cited.length) return;
    for (const lane of cited) spoken.set(key(segment.source, lane), [...(spoken.get(key(segment.source, lane)) ?? []), [segment.in_frame, segment.out_frame]]);
    for (const lane of lanes) if (!named.has(lane)) quiet.push({ segment: index, source: segment.source, lane, from: segment.in_frame, to: segment.out_frame });
  });
  const covered = (mute: { source: string; lane: string; from: number; to: number }) => document.mutes.some((known) =>
    known.source === mute.source && known.track === mute.lane && known.in_frame <= mute.from && known.out_frame >= mute.to);
  const added: EditMute[] = [];
  const focused = new Set<number>();
  for (const item of quiet) {
    for (const [from, to] of without([item.from, item.to], spoken.get(key(item.source, item.lane)) ?? [])) {
      const piece = { source: item.source, lane: item.lane, from, to };
      if (covered(piece)) continue;
      added.push({ source: item.source, track: item.lane, in_frame: from, out_frame: to });
      focused.add(item.segment);
    }
  }
  if (!added.length) return { document, clips: 0 };
  return { document: { ...document, mutes: [...document.mutes, ...added] }, clips: focused.size };
}

/** [from, to) less every range in `holes`. */
function without([from, to]: [number, number], holes: [number, number][]): [number, number][] {
  let pieces: [number, number][] = [[from, to]];
  for (const [low, high] of holes) {
    pieces = pieces.flatMap(([a, b]): [number, number][] => high <= a || low >= b ? [[a, b]]
      : [...(low > a ? [[a, low] as [number, number]] : []), ...(high < b ? [[high, b] as [number, number]] : [])]);
  }
  return pieces.filter(([a, b]) => b > a);
}
