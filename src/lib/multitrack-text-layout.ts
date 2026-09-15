type Cue = { id: string; text: string; startFrame: number; endFrame: number };
type Label = { id: string; text: string; title: string; summary: boolean; style: { left: string; width: string } };
/** At wide views show passage counts, never unreadable letter slivers. Work and
 * nodes are bounded by the viewport; detailed labels retain exact cue geometry. */
export function multitrackTextLayout(cues: Cue[], start: number, span: number, pixels: number): Label[] {
  const end = start + span, visible = cues.filter((cue) => cue.startFrame < end && cue.endFrame > start);
  if (!visible.length) return [];
  const width = Math.max(1, pixels), lengths = visible.map((cue) => (Math.min(end, cue.endFrame) - Math.max(start, cue.startFrame)) / span * width).sort((a, b) => a - b);
  if (lengths[Math.floor(lengths.length / 2)] >= 72) return visible.map((cue) => ({ id: cue.id, text: cue.text, title: cue.text, summary: false,
    style: { left: `${Math.max(0, (cue.startFrame - start) / span * 100)}%`, width: `${(Math.min(end, cue.endFrame) - Math.max(start, cue.startFrame)) / span * 100}%` },
  }));
  const columns = Math.max(1, Math.floor(width / 112)), buckets = new Map<number, Cue[]>();
  for (const cue of visible) {
    const column = Math.min(columns - 1, Math.max(0, Math.floor((cue.startFrame - start) / span * columns)));
    const bucket = buckets.get(column) ?? []; bucket.push(cue); buckets.set(column, bucket);
  }
  return [...buckets].map(([column, items]) => ({ id: `summary-${column}`, text: `${items.length} ${items.length === 1 ? "passage" : "passages"}`, summary: true,
    title: `${items.length} ${items.length === 1 ? "passage" : "passages"}. Zoom in to read timed text.\n${items.slice(0, 3).map((cue) => cue.text).join("\n")}`,
    style: { left: `${column / columns * 100}%`, width: `${100 / columns}%` },
  }));
}
