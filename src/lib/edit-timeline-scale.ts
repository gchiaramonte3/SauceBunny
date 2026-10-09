/**
 * The String Outs timeline's scale, from Neo: a record opens at 4 pixels a
 * frame and keeps whatever scale it is given, and it runs on for five minutes
 * past its end. Scaling the whole edit to the window, as it did, stretched a
 * 5 s record across the screen and rescaled every clip, the ruler and the
 * playhead with each edit, so nothing stayed where it was.
 */
export const TIMELINE_PX_PER_FRAME = 4;
export const TIMELINE_MIN_PX_PER_FRAME = 0.01;
export const TIMELINE_MAX_PX_PER_FRAME = 32;
export const TIMELINE_RUNWAY_SECONDS = 300;

/** Fit's scale: everything shown, with a tenth of the view, and at least 24 px, empty after the end. */
export const fitScale = (width: number, seconds: number, fps: number) => Math.max(1, width - Math.max(24, width * 0.1)) / Math.max(1, seconds) / fps;
