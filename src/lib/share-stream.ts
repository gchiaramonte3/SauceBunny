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
          try {
            if (keepFrom > 0) sb.remove(0, keepFrom);
            return; // the remove's updateend re-enters pump
          } catch { /* fall through to death below */ }
        }
        died();
      }
    };
    sb.addEventListener("updateend", pump);

    let signalFirst: () => void = () => {};
    const gotData = new Promise<void>((resolve) => { signalFirst = resolve; });
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { died(); return; }
          if (value && value.byteLength) {
            queue.push(value);
            pump();
            signalFirst();
          }
        }
      } catch {
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
