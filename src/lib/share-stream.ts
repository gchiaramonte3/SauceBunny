/**
 * Play the share proxy stream in a HIDDEN muted <video> and captureStream()
 * it into a MediaStream the mesh can send (WKWebView has no getDisplayMedia;
 * this is the delivery half of the native pipeline). MSE, matching the
 * codebase's proven web-playback path - a live fragmented stream over a
 * plain <video src> is exactly what WKWebView refuses.
 *
 * DOM-only by design: the state machine around it (share-machine.ts) is
 * pure and unit-tested; this file is the injected `open` seam.
 */
export async function openShareStream(
  url: string,
  onDied: () => void,
): Promise<{ stream: MediaStream; track: MediaStreamTrack; audioTrack: MediaStreamTrack | null; close: () => void }> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  video.src = objectUrl;

  let closed = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const died = () => { if (!closed) onDied(); };

  /** The ONE teardown, shared by the returned close() and every throw path
   *  below. The caller's state machine records the handle only after this
   *  function resolves, so its own cleanup can't reach a pipeline that
   *  failed mid-open — without this, every failed start (TCC denied is a
   *  designed path) left a detached playing <video>, an open MediaSource
   *  and a live fetch read loop behind for the rest of the session.
   *  `closed = true` must precede reader.cancel(): the cancelled read
   *  rejects the loop, whose catch calls died() — a SECOND cleanup — and
   *  the flag is what makes that a no-op. */
  const teardown = () => {
    closed = true;
    try { void reader?.cancel(); } catch { /* already done */ }
    try { if (ms.readyState === "open") ms.endOfStream(); } catch { /* torn */ }
    video.pause();
    video.src = "";
    URL.revokeObjectURL(objectUrl); // no-op if the happy path already did
  };

  try {
    await new Promise<void>((resolve, reject) => {
      ms.addEventListener("sourceopen", () => resolve(), { once: true });
      video.addEventListener("error", () => reject(new Error("share video failed to open")), { once: true });
    });
    URL.revokeObjectURL(objectUrl);
    // ultrafast/high yuv420p out of the proxy's libx264 line; AAC rides
    // along when system audio is shared (declaring it for a video-only
    // stream is harmless - it is a capability list, not a requirement).
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.640028, mp4a.40.2"');
    sb.mode = "segments";

    const resp = await fetch(url);
    if (!resp.ok || !resp.body) throw new Error(`share stream HTTP ${resp.status}`);
    reader = resp.body.getReader();

    const queue: Uint8Array[] = [];
    const pump = () => {
      if (closed || sb.updating) return;
      const chunk = queue.shift();
      if (!chunk) return;
      try {
        sb.appendBuffer(chunk as BufferSource);
      } catch (err) {
        // A share appended forever with no eviction, so a long one eventually
        // hit the SourceBuffer quota - and that throw was treated as the
        // pipeline dying, killing a share that was working fine. Evict what has
        // already played and retry the same chunk (same recovery the main
        // player uses). Only a NON-quota failure is a real death.
        if ((err as DOMException)?.name === "QuotaExceededError") {
          queue.unshift(chunk);
          const keepFrom = Math.max(0, video.currentTime - 10);
          // The `return` belongs INSIDE the guard. With keepFrom === 0 - which
          // is every quota hit in the first ten seconds of playback - the old
          // shape skipped the remove and returned anyway: nothing was evicted,
          // so no updateend fired, so pump was never re-entered, and the share
          // stalled forever without ever reporting a death. A quota hit with
          // nothing evictable is a real death; only a remove we actually issued
          // earns the retry.
          if (keepFrom > 0) {
            try {
              sb.remove(0, keepFrom);
              return; // the remove's updateend re-enters pump
            } catch { /* fall through to death below */ }
          }
        }
        died();
      }
    };
    sb.addEventListener("updateend", pump);

    // gotData has to settle BOTH ways. It used to have only a resolve, so a
    // stream that ended or errored before its first byte left `await gotData`
    // waiting forever: openShareStream never settled, teardown never ran, and
    // the caller sat on a share that was already dead - with a detached playing
    // <video>, an open MediaSource and a live read loop left behind. A proxy
    // that answers 200 with an empty body is enough to reach it.
    //
    // After the first chunk the promise is already settled, so these rejections
    // become no-ops and a later death goes through onDied() as before.
    let signalFirst: () => void = () => {};
    let failFirst: (e: Error) => void = () => {};
    const gotData = new Promise<void>((resolve, reject) => {
      signalFirst = resolve;
      failFirst = reject;
    });
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            failFirst(new Error("share stream ended before sending any data"));
            died();
            return;
          }
          if (value && value.byteLength) {
            queue.push(value);
            pump();
            signalFirst();
          }
        }
      } catch (e) {
        failFirst(e instanceof Error ? e : new Error("share stream read failed"));
        died();
      }
    })();

    await gotData;
    await video.play().catch(() => { /* muted autoplay is allowed */ });
    const stream = (video as HTMLVideoElement & { captureStream(): MediaStream }).captureStream();
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("share captureStream produced no video track");
    // Screen content is text and UI, not motion: tell the encoder to spend
    // its bits on spatial detail. Pairs with the senders' maintain-resolution
    // degradation preference (rtc-mesh tuneVideoSender).
    try { track.contentHint = "detail"; } catch { /* older engines ignore it */ }

    return {
      stream,
      track,
      audioTrack: stream.getAudioTracks()[0] ?? null,
      close: teardown,
    };
  } catch (err) {
    teardown();
    throw err;
  }
}

/**
 * Mix the share's system audio with the mic into ONE outgoing track, so
 * the mesh keeps its replaceTrack-only contract (a second audio sender
 * would force renegotiation). The mic is snapshotted at share start; a
 * mid-share device switch keeps the old mic in the mix until re-share.
 */
export function mixShareAudio(
  shareTrack: MediaStreamTrack,
  micTrack: MediaStreamTrack | null,
): { track: MediaStreamTrack; close: () => void } {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(new MediaStream([shareTrack])).connect(dest);
  if (micTrack) {
    ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(dest);
  }
  return {
    track: dest.stream.getAudioTracks()[0],
    close: () => { void ctx.close(); },
  };
}
