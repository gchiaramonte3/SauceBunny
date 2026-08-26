/**
 * What a seek rebuild says about itself.
 *
 * Pure, because the thing that went wrong here was a SENTENCE, and a sentence
 * is testable in a way that a ref inside a media component is not.
 *
 * The web player logs `seek req` once per gesture, not once per seek: a drag
 * emits one seek per animation frame and every log line is App state, so
 * logging each one re-rendered the whole app per vsync. The rebuild that
 * follows a gesture is debounced, so it reports where the gesture ENDED.
 *
 * Those two lines land next to each other in the Pipeline log, and nothing
 * said they were different moments:
 *
 *     seek req 2666.0 → target 2666.0
 *     seek out-of-buffer → rebuilding from 3855.5s
 *
 * Read cold that is a seek that missed by twenty minutes. It is not. It is a
 * drag that began at 2666 and was released at 3855, and the player did exactly
 * what it was told at both ends. The log was the only defect, and it cost a
 * full investigation of a player that turned out to be behaving.
 */

/** Below this, two positions are the same place and the gesture did not move. */
const MOVED_EPSILON_S = 0.05;

export function rebuildLogLine(
  /** Where the rebuild will open the pipeline: the gesture's resting place. */
  target: number,
  /** Where the gesture's first seek asked for, or null if unknown. */
  gestureFrom: number | null,
  /** How many seeks the gesture emitted. One means a click. */
  seeks: number,
): string {
  const head = `seek out-of-buffer → rebuilding from ${target.toFixed(1)}s`;
  if (gestureFrom == null) return head;
  if (Math.abs(target - gestureFrom) <= MOVED_EPSILON_S) {
    return `${head} (click, landed as asked)`;
  }
  return `${head} (drag: began ${gestureFrom.toFixed(1)}s, ${seeks} seeks, released ${target.toFixed(1)}s)`;
}
