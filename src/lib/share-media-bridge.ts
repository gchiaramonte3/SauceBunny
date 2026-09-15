/** The native share proxy already supplies H.264/AAC through MSE. This only
 * adapts its decoded output to the existing RTC program tracks; it is not a
 * second capture or transport. WebKit supports canvas capture even when it
 * does not implement HTMLMediaElement.captureStream(). */
export type ShareMediaBridge = {
  stream: MediaStream;
  track: MediaStreamTrack;
  audioTrack: MediaStreamTrack | null;
  close: () => void;
};

type CapturableVideo = HTMLVideoElement & { captureStream?: () => MediaStream };
const FRAME_RATE = 30;

export async function openShareMediaBridge(video: HTMLVideoElement, options: {
  audio: boolean;
  signal: AbortSignal;
  onDied: () => void;
}): Promise<ShareMediaBridge> {
  let closed = false;
  let frameCallback: number | null = null;
  let frameTimer: ReturnType<typeof setInterval> | null = null;
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let audioSource: MediaElementAudioSourceNode | null = null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;
  let rejectReady: (error: Error) => void = () => {};
  let rejectClosed: (error: Error) => void = () => {};
  const ended = new Promise<never>((_, reject) => { rejectClosed = reject; });
  void ended.catch(() => {});
  const cancelled = () => new DOMException("Screen sharing was cancelled", "AbortError");
  const close = () => {
    if (closed) return;
    closed = true;
    video.muted = true;
    options.signal.removeEventListener("abort", abort);
    if (frameCallback !== null) video.cancelVideoFrameCallback(frameCallback);
    if (frameTimer !== null) clearInterval(frameTimer);
    video.removeEventListener("loadeddata", paintFallback);
    const tracks = new Set([...(stream?.getTracks() ?? []), ...(audioDestination?.stream.getTracks() ?? [])]);
    tracks.forEach(track => track.stop());
    audioSource?.disconnect();
    if (context) void context.close().catch(() => {});
    rejectReady(cancelled());
    rejectClosed(cancelled());
  };
  const abort = () => close();
  options.signal.addEventListener("abort", abort, { once: true });
  // Declared before setup because abort owns every partial construction.
  let paintFallback = () => {};
  try {
    if (options.signal.aborted) throw cancelled();
    const nativeCapture = (video as CapturableVideo).captureStream;
    let paint: (() => void) | null = null;
    if (typeof nativeCapture !== "function") {
      const canvas = document.createElement("canvas");
      if (typeof canvas.captureStream !== "function") {
        throw new Error("This app runtime cannot send screen video. Canvas stream capture is unavailable.");
      }
      const draw = canvas.getContext("2d", { alpha: false });
      if (!draw) throw new Error("The screen-sharing video surface could not be created.");
      // The proxy already bounds encoded dimensions. Avoid silently accepting
      // corrupt metadata that would allocate an unbounded canvas.
      paint = () => {
        const width = video.videoWidth, height = video.videoHeight;
        if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
          throw new Error("The screen-sharing video dimensions are invalid.");
        }
        if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
        draw.drawImage(video, 0, 0, width, height);
        if (!stream) stream = canvas.captureStream(FRAME_RATE);
      };
      if (options.audio) {
        if (typeof AudioContext !== "function") throw new Error("This app runtime cannot send system audio.");
        context = new AudioContext();
        audioDestination = context.createMediaStreamDestination();
        audioSource = context.createMediaElementSource(video);
        audioSource.connect(audioDestination);
        // createMediaElementSource reroutes the element into this graph. The
        // graph has NO connection to context.destination (the speakers).
        // Element mute/volume must not silence the outgoing Web Audio track.
        video.volume = 1;
        video.muted = false;
      }
    }
    const ready = new Promise<void>((resolve, reject) => {
      rejectReady = reject;
      let paintedTime: number | null = null;
      const frame = () => {
        if (closed || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return false;
        try {
          if (paintedTime !== video.currentTime) { paint?.(); paintedTime = video.currentTime; }
          resolve(); return true;
        }
        catch (error) { reject(error); options.onDied(); close(); return false; }
      };
      if (typeof video.requestVideoFrameCallback === "function") {
        const tick = () => {
          if (closed) return;
          const presented = frame();
          if (!closed && (paint || !presented)) frameCallback = video.requestVideoFrameCallback(tick);
        };
        frameCallback = video.requestVideoFrameCallback(tick);
      }
      // A detached/hidden WebKit decoder may have pixels without compositor
      // callbacks. HAVE_CURRENT_DATA + valid dimensions + successful draw
      // proves that picture; neither metadata nor play() is enough. Sample
      // advancing source times, not a second decode or guessed black frame.
      paintFallback = () => { frame(); };
      video.addEventListener("loadeddata", paintFallback);
      frameTimer = setInterval(paintFallback, 1000 / FRAME_RATE);
      if (video.readyState >= 2) paintFallback();
    });
    // Observe readiness immediately even when play/resume fail first.
    void ready.catch(() => {});
    await Promise.race([Promise.all([video.play(), context?.resume(), ready]), ended]);
    if (closed) throw cancelled();
    if (context && context.state !== "running") throw new Error("System-audio sharing could not start its audio engine.");
    if (nativeCapture) stream = nativeCapture.call(video);
    if (!stream) throw new Error("Screen sharing produced no video stream.");
    const output: MediaStream = stream;
    const track = output.getVideoTracks()[0];
    if (!track) throw new Error("Screen sharing produced no video track.");
    if (!options.audio) {
      for (const audio of output.getAudioTracks()) { output.removeTrack(audio); audio.stop(); }
    } else if (audioDestination) {
      const audio = audioDestination.stream.getAudioTracks()[0];
      if (!audio) throw new Error("System-audio sharing produced no audio track.");
      output.addTrack(audio);
    }
    if (options.audio && !output.getAudioTracks().length) throw new Error("System-audio sharing produced no audio track.");
    try { track.contentHint = "detail"; } catch { /* Older engines ignore hints. */ }
    return { stream: output, track, audioTrack: output.getAudioTracks()[0] ?? null, close };
  } catch (error) { close(); throw error; }
}
