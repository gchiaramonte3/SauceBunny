// Audio-master clock for web streaming (the fix for streaming caption drift).
//
// The problem: WKWebView's MSE <video> timeline ticks at its OWN rate, which
// drifts from the audio you actually hear — so captions tied to the video clock
// slide out of sync (worse the longer you watch).
//
// The fix: play the FULL cached source audio on a separate, hidden native
// <audio> element and read ITS clock. A media element's currentTime only
// advances while it's actually rendering audio, so the clock can't drift from
// the words — exactly like the local-file path (which is dead-on). The streamed
// <video> is muted and used for picture only, softly slaved to this clock.
//
// Why a native <audio> element (r82.1) — NOT a Web Audio AudioContext (the
// earlier "twin"): the AudioContext clock is just `ctx.currentTime` arithmetic,
// so it advances even when no sound reaches the speakers — in WKWebView the
// context could be running (captions tracking) while the BufferSource produced
// silence (suspend/resume races, MSE↔WebAudio quirks). A real <audio> element
// has no such decoupling: if its currentTime moves, you hear it. It also avoids
// decodeAudioData expanding the whole file to PCM in RAM (no ~70 min cap) and
// uses the same gesture/autoplay model as the <video>.
//
// The shape is unchanged from the AudioContext version so MSEStreamPlayer's
// integration is identical, except `load()` now takes a URL (asset:// from
// convertFileSrc) instead of decoded bytes, and `play()` resolves to whether
// playback actually started (false ⇒ autoplay-blocked, caller keeps the video
// audible and retries on the next gesture).

export type AudioTwin = {
  /** Point at the cached audio (asset:// URL) and wait for metadata. Returns duration (s). */
  load: (src: string) => Promise<number>;
  /** Start (optionally seeking first). Resolves true if playback actually began,
   *  false if the browser blocked it (no user activation) — caller defers. */
  play: (atSec?: number) => Promise<boolean>;
  pause: () => void;
  /** No-op (kept for interface parity with the old AudioContext twin). */
  resume: () => void;
  /** Reposition; keeps playing if it was playing. */
  seek: (toSec: number) => void;
  getTime: () => number;
  getDuration: () => number;
  isPlaying: () => boolean;
  isReady: () => boolean;
  /** True only when audio is actually advancing (playing, not blocked/ended). */
  isRunning: () => boolean;
  setVolume: (v: number) => void;
  getVolume: () => number;
  setMuted: (m: boolean) => void;
  isMuted: () => boolean;
  dispose: () => void;
};

export function createAudioTwin(): AudioTwin {
  const el = new Audio();
  el.preload = "auto";
  // Picture comes from the <video>; this element is audio-only and offscreen.
  el.muted = false;
  // Attach (hidden) to the document: WKWebView loads Tauri's `asset://` custom
  // scheme reliably for in-document media elements (matching LocalMediaPlayer);
  // a fully detached `new Audio()` can be flaky with custom protocols.
  el.style.display = "none";
  try { document.body.appendChild(el); } catch { /* SSR/no-DOM — detached still mostly works */ }
  let ready = false;
  let volume = 1;
  let muted = false;

  return {
    load: (src) =>
      new Promise<number>((resolve, reject) => {
        const cleanup = () => {
          el.removeEventListener("loadedmetadata", onMeta);
          el.removeEventListener("error", onErr);
        };
        const onMeta = () => {
          cleanup();
          ready = true;
          resolve(isFinite(el.duration) ? el.duration : 0);
        };
        const onErr = () => {
          cleanup();
          reject(el.error
            ? new Error(`audio load: ${el.error.message || el.error.code}`)
            : new Error("audio load failed"));
        };
        el.addEventListener("loadedmetadata", onMeta);
        el.addEventListener("error", onErr);
        el.src = src;
        el.load();
      }),
    play: async (atSec) => {
      if (atSec != null && isFinite(atSec)) {
        try { el.currentTime = Math.max(0, atSec); } catch { /* not seekable yet */ }
      }
      try {
        await el.play();
        return !el.paused;
      } catch {
        return false; // autoplay blocked — caller keeps the <video> audible
      }
    },
    pause: () => { try { el.pause(); } catch { /* ignore */ } },
    resume: () => { /* native element needs no context resume */ },
    seek: (toSec) => {
      try { el.currentTime = Math.max(0, isFinite(toSec) ? toSec : 0); } catch { /* ignore */ }
    },
    getTime: () => el.currentTime,
    getDuration: () => (isFinite(el.duration) ? el.duration : 0),
    isPlaying: () => !el.paused,
    isReady: () => ready,
    isRunning: () => !el.paused && !el.ended,
    setVolume: (v) => {
      volume = Math.max(0, Math.min(1, v));
      el.volume = volume;
      if (volume > 0 && muted) { muted = false; el.muted = false; }
    },
    getVolume: () => volume,
    setMuted: (m) => { muted = m; el.muted = m; },
    isMuted: () => muted,
    dispose: () => {
      try { el.pause(); } catch { /* ignore */ }
      try { el.removeAttribute("src"); el.load(); } catch { /* ignore */ }
      // Detach the body-attached element — without this, one hidden <audio>
      // node leaks per web source (and WKWebView tracks live media elements).
      try { el.remove(); } catch { /* ignore */ }
    },
  };
}
