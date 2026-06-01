// Audio-master clock for web streaming (the fix for streaming caption drift).
//
// The problem: WKWebView's MSE <video> timeline ticks at its OWN rate, which
// drifts from the audio you actually hear — so captions tied to the video clock
// slide out of sync (worse the longer you watch). We cannot read the audio
// render position from a <video>, and there's no native way to slave it.
//
// The fix (what the LOCAL MediaBunnyPlayer already does, and why local files
// are dead-on): decode the full audio track ourselves and PLAY it on a
// Web Audio AudioContext. The AudioContext exposes a sample-accurate clock —
//   mediaTime = startMedia + (audioCtx.currentTime − startContext)
// — and since the user hears THAT audio, captions read from THAT clock can't
// drift from the words. The streamed <video> is muted and used for picture
// only, softly slaved to this clock.
//
// Why decodeAudioData (not WebCodecs / mediabunny's AudioBufferSink): the
// WebCodecs `AudioDecoder` is absent in older WKWebView, which is why the
// streaming path muxes audio through MSE in the first place. `decodeAudioData`
// is a SEPARATE, long-available Web Audio API that decodes a COMPLETE AAC/MP3/
// WAV file — exactly what we have once the audio-only track is on disk.

export type AudioTwin = {
  /** Decode complete audio bytes (AAC/m4a/mp3/wav). Returns duration (s). */
  load: (bytes: ArrayBuffer) => Promise<number>;
  play: (atSec?: number) => void;
  pause: () => void;
  /** Resume a suspended AudioContext (WebKit needs a user gesture). Safe to
   *  call repeatedly; no-op once running. */
  resume: () => void;
  /** Reposition the clock; restarts audio playback if currently playing. */
  seek: (toSec: number) => void;
  getTime: () => number;
  getDuration: () => number;
  isPlaying: () => boolean;
  isReady: () => boolean;
  setVolume: (v: number) => void;
  getVolume: () => number;
  setMuted: (m: boolean) => void;
  isMuted: () => boolean;
  dispose: () => void;
};

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export function createAudioTwin(): AudioTwin {
  let ctx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let buffer: AudioBuffer | null = null;
  let source: AudioBufferSourceNode | null = null;
  let playing = false;
  let startMedia = 0; // media time captured at the last (re)start / freeze
  let startCtx = 0; // audioCtx.currentTime captured at the last (re)start
  let volume = 1;
  let muted = false;

  const ensureCtx = (): AudioContext => {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      ctx = new Ctor();
      gain = ctx.createGain();
      gain.gain.value = muted ? 0 : volume;
      gain.connect(ctx.destination);
    }
    return ctx;
  };

  // Sample-accurate clock — the whole point. When paused, the frozen
  // startMedia IS the position; when playing, advance by the context delta.
  const clock = (): number => {
    if (!ctx || !playing) return startMedia;
    return startMedia + (ctx.currentTime - startCtx);
  };

  const stopSource = () => {
    if (source) {
      try { source.onended = null; source.stop(); } catch { /* already stopped */ }
      try { source.disconnect(); } catch { /* ignore */ }
      source = null;
    }
  };

  const startSource = (atSec: number) => {
    const c = ensureCtx();
    if (!buffer || !gain) return;
    stopSource();
    const at = Math.max(0, Math.min(buffer.duration, atSec));
    const s = c.createBufferSource();
    s.buffer = buffer;
    s.connect(gain);
    startMedia = at;
    startCtx = c.currentTime;
    s.start(0, at);
    s.onended = () => {
      // Natural end (not a manual stop/seek): settle paused at the end.
      if (s === source) { playing = false; source = null; if (buffer) startMedia = buffer.duration; }
    };
    source = s;
  };

  // decodeAudioData has both promise and callback forms; the callback form is
  // universally supported in WebKit, so use it and wrap in a Promise.
  const decode = (c: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> =>
    new Promise((resolve, reject) => {
      try { c.decodeAudioData(bytes, resolve, reject); }
      catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });

  return {
    load: async (bytes) => {
      const c = ensureCtx();
      buffer = await decode(c, bytes);
      startMedia = 0;
      startCtx = c.currentTime;
      return buffer.duration;
    },
    play: (atSec) => {
      if (!buffer) return;
      const c = ensureCtx();
      // AudioContext starts suspended; resume on the user gesture that calls play().
      if (c.state === "suspended") void c.resume();
      startSource(atSec ?? clock());
      playing = true;
    },
    pause: () => {
      if (!playing) return;
      startMedia = clock(); // freeze the clock at the current position
      playing = false;
      stopSource();
    },
    resume: () => { if (ctx && ctx.state === "suspended") void ctx.resume(); },
    seek: (toSec) => {
      const at = Math.max(0, Math.min(buffer?.duration ?? toSec, toSec));
      if (playing) startSource(at);
      else startMedia = at;
    },
    getTime: () => clock(),
    getDuration: () => buffer?.duration ?? 0,
    isPlaying: () => playing,
    isReady: () => !!buffer,
    setVolume: (v) => { volume = Math.max(0, Math.min(1, v)); if (gain && !muted) gain.gain.value = volume; },
    getVolume: () => volume,
    setMuted: (m) => { muted = m; if (gain) gain.gain.value = m ? 0 : volume; },
    isMuted: () => muted,
    dispose: () => {
      stopSource();
      try { void ctx?.close(); } catch { /* ignore */ }
      ctx = null; gain = null; buffer = null; playing = false;
    },
  };
}
