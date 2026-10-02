/** Keep an exact frame boundary from truncating into the preceding frame.
 * WebKit's native media clock can convert 1.001 to 1.0009999. Moving only by
 * floating-point precision (not a frame or a microsecond) makes that conversion
 * land on the intended boundary. The command/result keep the original target;
 * only the value assigned to HTMLMediaElement.currentTime uses this correction.
 */
export function nativeSeekTarget(seconds: number, duration = Infinity): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return seconds;
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  return Math.min(limit, seconds + Number.EPSILON * Math.max(1, seconds));
}
