/**
 * The imperative ref interface shared by every video/audio player
 * component in Sauce Bunny. App.tsx threads a single ref of this type
 * through `<Monitor>` to whichever underlying player is mounted; the
 * Transport / Timeline / keyboard shortcuts call methods on it without
 * caring which concrete implementation (LocalMediaPlayer, MediaBunnyPlayer)
 * is doing the work.
 *
 * Historical note: this type used to live in `YouTubePlayer.tsx` as
 * `YouTubePlayerHandle` because the IFrame player was the first
 * implementation. The IFrame was retired in r53 (YouTube's Dec 2025
 * Referer enforcement broke embedding for WebView apps — mpv/VLC
 * pattern of "yt-dlp → direct stream → native <video>" is what we use
 * for all web sources now). The type was relocated + renamed at the
 * same time.
 */
export type PlayerHandle = {
  play: () => void;
  pause: () => void;
  seekTo: (seconds: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  isReady: () => boolean;
  isPlaying: () => boolean;
  /** Volume 0..1 (normalised across players' native scales). */
  setVolume: (v: number) => void;
  getVolume: () => number;
  setMuted: (m: boolean) => void;
  isMuted: () => boolean;
  /**
   * Variable-speed "shuttle" playback (the J-K-L editor convention):
   *   rate > 0   → fast-forward at that multiple (e.g. 2 = 2×)
   *   rate < 0   → reverse / rewind at |rate|×
   *   rate === 0 → exit shuttle, return to normal 1× playback
   *
   * Per-engine behaviour:
   *   • MediaBunnyPlayer owns its own clock + decodes any frame on demand, so
   *     it does TRUE smooth forward AND reverse.
   *   • WebKit <video> players (MSE / local) can only fast-FORWARD natively
   *     (playbackRate); they approximate reverse with a backward seek-scan
   *     (smooth on local files, limited to the buffered range on streams).
   */
  setShuttle: (rate: number) => void;
  /**
   * Optional — returns a JPEG/PNG blob of the frame at `seconds` if the
   * player can decode frames directly (MediaBunnyPlayer does, others
   * return null). Lets handleSnapshot skip the ffmpeg subprocess when
   * the file is already loaded by mediabunny.
   */
  getFrameBlob?: (seconds: number, opts?: { mimeType?: string; quality?: number }) => Promise<Blob | null>;
};
