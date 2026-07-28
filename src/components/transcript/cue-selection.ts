/**
 * Turning a text selection into a range of cues.
 *
 * The user's ask: lasso a stretch of dialogue that the diarizer wrongly gave
 * to one person, right-click, and split it out. The lasso is a DOM Selection;
 * the thing that can actually be reassigned is a cue. This is the bridge.
 *
 * IT SNAPS TO WHOLE CUES, ALWAYS. A cue is the atom that carries a timestamp,
 * and there is no sub-cue timing to split on: word-level timings are stripped
 * at parse (`stripCaptionMarkup`) and Whisper SRT never had them. Splitting
 * mid-cue would mean inventing a boundary from a character count and rendering
 * the guess as a timecode. The Rust pipeline already faced this exact choice at
 * the layer that DID have the diarization timeline — `merge_diarization_into_srt`
 * assigns each cue to its max-overlap speaker turn and never splits one — so
 * snapping is also the consistent answer.
 *
 * The consequence a user sees is that a half-highlighted cue comes fully into
 * the range. The caller re-applies the snapped range to the live selection
 * before opening the menu, so the highlight shows exactly what will change
 * rather than leaving the user to guess.
 */

/** Inclusive cue index range. */
export type CueRange = { from: number; to: number };

/**
 * Nearest enclosing cue index for a DOM node, or null.
 *
 * Walks up from a text node to the `[data-cue-idx]` span. The selection's
 * anchor and focus are usually text nodes inside the cue, not the cue itself.
 */
export function cueIndexOfNode(node: Node | null, root: HTMLElement): number | null {
  let el: Node | null = node;
  while (el && el !== root) {
    if (el instanceof HTMLElement) {
      const raw = el.dataset.cueIdx;
      if (raw != null) {
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
      }
    }
    el = el.parentNode;
  }
  return null;
}

/**
 * The cue range a selection covers, or null when it does not resolve to one.
 *
 * `null` for a collapsed selection (a plain click is not a lasso) and for a
 * selection that touches no cue — which is how a stray drag over the speaker
 * chip or the timecode is refused rather than silently reassigning something.
 *
 * The range is normalised, so selecting bottom-to-top works the same as
 * top-to-bottom. Nobody selects in one direction only.
 */
export function selectionToCueRange(
  sel: Selection | null,
  root: HTMLElement | null,
): CueRange | null {
  if (!sel || !root || sel.isCollapsed || sel.rangeCount === 0) return null;
  const a = cueIndexOfNode(sel.anchorNode, root);
  const b = cueIndexOfNode(sel.focusNode, root);
  // One end landing outside a cue is common: a drag that overshoots the last
  // word ends on the container. Fall back to the end that DID resolve rather
  // than refusing, so an ordinary sloppy drag still works.
  if (a == null && b == null) return null;
  const from = Math.min(a ?? b!, b ?? a!);
  const to = Math.max(a ?? b!, b ?? a!);
  return { from, to };
}

/**
 * Re-apply a snapped range to the live selection, so the highlight shows what
 * will actually change.
 *
 * Without this the user lassos half a sentence, the action silently widens to
 * whole cues, and the result does not match what they saw — the single most
 * likely way this feature would feel untrustworthy.
 */
export function paintCueRange(range: CueRange, root: HTMLElement | null): void {
  if (!root) return;
  const first = root.querySelector<HTMLElement>(`[data-cue-idx="${range.from}"]`);
  const last = root.querySelector<HTMLElement>(`[data-cue-idx="${range.to}"]`);
  if (!first || !last) return;
  const sel = document.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.setStartBefore(first);
  r.setEndAfter(last);
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * A fresh speaker tag that cannot collide with the diarizer's.
 *
 * Letters only, deliberately. `speakerColorIndex` reads the first NUMBER out
 * of a tag, so a minted `SPEAKER_09` would silently take colour slot 9 and be
 * indistinguishable from the diarizer's ninth speaker — and worse, a later
 * re-detect may genuinely emit `SPEAKER_09`, at which point the name and
 * colour stored for the minted tag would be inherited by a different person.
 * `merge_diarization_into_srt` only ever emits `SPEAKER_NN`, so a letters-only
 * tag can never be produced by the pipeline.
 */
export function newSpeakerTag(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 0; i < 26 * 27; i += 1) {
    // A, B, ... Z, AA, AB, ...
    const suffix = i < 26
      ? String.fromCharCode(65 + i)
      : String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
    const tag = `CAST_${suffix}`;
    if (!used.has(tag)) return tag;
  }
  // Unreachable for any real cast; a stable fallback beats a throw.
  return `CAST_X${Date.now()}`;
}
