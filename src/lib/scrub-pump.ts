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
  /** Record the newest target and ensure the drain loop is running. Resolves
   * true only when this request is still newest after its frame is painted. */
  request: (target: number) => Promise<boolean>;
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
  type Request = { target: number; id: number; resolve: (painted: boolean) => void };
  let pending: Request | null = null;
  let inFlight: Request | null = null;
  let busy = false;
  let nextId = 0;
  let latestId = 0;

  const run = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      // Take-and-clear the latest target each lap. A newer request that lands
      // mid-drain overwrites `pending`, so intermediate targets are silently
      // skipped and only the freshest survives to the next iteration.
      while (pending !== null) {
        const request = pending;
        pending = null;
        inFlight = request;
        try {
          await drain(request.target);
          request.resolve(request.id === latestId);
        } catch {
          // A single decoder miss must settle its waiter and allow the newest
          // pending target to run. The owning player reports diagnostics and
          // keeps its last successfully painted frame visible.
          request.resolve(false);
        }
        inFlight = null;
      }
    } finally {
      busy = false;
    }
  };

  return {
    request(target: number): Promise<boolean> {
      if (pending) pending.resolve(false);
      const id = ++nextId;
      latestId = id;
      const result = new Promise<boolean>((resolve) => { pending = { target, id, resolve }; });
      void run();
      return result;
    },
    cancel(): void {
      latestId = ++nextId;
      if (pending) pending.resolve(false);
      pending = null;
      // The decoder itself may not be cancellable, but its waiter can be
      // released immediately and the caller's generation gate prevents paint.
      if (inFlight) inFlight.resolve(false);
    },
    isBusy: () => busy,
  };
}
