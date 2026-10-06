/**
 * A value that changes on every animation frame, held outside React state so
 * that only what draws it re-renders.
 *
 * String Outs' playback used to publish its frame into the editor's state, so
 * every frame re-rendered the record text, the source text, the timeline and
 * the Inspector: measured on a 146k-word string out, 65 ms of script per
 * frame, so playback ran at about 16 frames a second
 * (docs/UI-CORRECTIONS-2026-10-05.md, item 19). Now the timecode, the
 * scrubbers and the playhead line read the frame as it moves, the texts redraw
 * only when the word under the playhead changes, and an action that needs the
 * playhead (mark, add an edit, step) reads it when it runs.
 */
export type FrameStore = { get: () => number; set: (frame: number) => void; subscribe: (listener: () => void) => () => void };

export function createFrameStore(initial = 0): FrameStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
