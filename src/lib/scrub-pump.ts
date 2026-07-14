/**
 * Latest-wins, single-flight decode pump for paused scrubbing.
 *
 * A fast timeline drag fires `seekTo` many times per second. Naively calling
 * the decoder once per seek makes decodes pile up: mediabunny seeks to the
 * nearest keyframe and decodes forward (expensive on long-GOP media), so the
 * painted frame lags well behind the cursor and scrubbing feels sluggish and
 * imprecise. This pump keeps only the NEWEST requested target and decodes one
 * at a time — any intermediate target that arrived while a decode was in
 * flight is dropped, so the player always chases the latest cursor position
 * and skips the frames in between. That is the standard responsive-scrub
 * coalescing pattern.
 *
 * The pump is deliberately I/O-agnostic: `drain(target)` performs the actual
 * decode + paint (and any staleness gating the caller needs). What lives here
 * is pure control-flow — the coalescing invariant — which keeps it unit
 * testable without a real decoder.
 */
export type ScrubPump = {
  /** Record the newest target and ensure the drain loop is running. */
  request: (target: number) => void;
  /**
   * Drop any pending (not-yet-started) target. A drain already in flight
   * still runs to completion — the caller is expected to gate its own paint
   * (e.g. by a generation counter) so a superseded in-flight frame is decoded
   * but not shown.
   */
  cancel: () => void;
  /** True while the drain loop is running. */
  isBusy: () => boolean;
};

export function createScrubPump(
  drain: (target: number) => Promise<void>,
): ScrubPump {
  let pending: number | null = null;
  let busy = false;

  const run = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      // Take-and-clear the latest target each lap. A newer request that lands
      // mid-drain overwrites `pending`, so intermediate targets are silently
      // skipped and only the freshest survives to the next iteration.
      while (pending !== null) {
        const target = pending;
        pending = null;
        await drain(target);
      }
    } finally {
      busy = false;
    }
  };

  return {
    request(target: number): void {
      pending = target;
      void run();
    },
    cancel(): void {
      pending = null;
    },
    isBusy: () => busy,
  };
}
