import { forwardRef, useLayoutEffect, useRef, useState } from "react";
import { IconAlert } from "./Icons";
import { CanvasToast, type ToastKind } from "./CanvasToast";
import { CaptionOverlay, type CaptionStyle } from "./CaptionOverlay";
import { AnnotationOverlay } from "./AnnotationOverlay";
import type { AnnotationStrokes } from "../lib/review";
import { LocalMediaPlayer } from "./LocalMediaPlayer";
import { MediaBunnyPlayer } from "./MediaBunnyPlayer";
import { MSEStreamPlayer } from "./MSEStreamPlayer";
import type { PlayerHandle } from "./player-handle";
import { formatPlaybackRate } from "../lib/playback-rate";
import type { AppStatus, Metadata, SourceKind } from "../types";

export type AspectId = "off" | "16:9" | "9:16" | "1:1" | "2.39";

type Props = {
  status: AppStatus;
  metadata: Metadata | null;
  errorDetail: string | null;
  aspect: AspectId;
  /** "youtube" → web source (any host yt-dlp supports — including YouTube
   *  itself, which used to use the IFrame embed until r53 dropped it);
   *  "file" → local file rendered through HTML5 <video>/<audio>. */
  sourceKind: SourceKind;
  localFilePath: string | null;
  /**
   * For ALL web sources (including YouTube as of r53), the yt-dlp-resolved
   * direct-stream URL. Mounts a LocalMediaPlayer pointed at this URL —
   * same path Vimeo/TikTok/Twitter/Reddit use. The IFrame Player API
   * branch was removed in r53; see DISTRIBUTION.md for the rationale.
   */
  webStreamUrl?: string | null;
  /** Pipeline/seek diagnostics → the Pipeline log (channel "seek"). */
  onDiag?: (tag: string, message: string) => void;
  /** r75: RAW audio-track CDN URL for DASH-split sources (Reddit, YouTube
   *  >360p). Passed to the proxy's fMP4 route so video+audio are merged on the
   *  fly → the source streams with sound instead of downloading first. */
  audioStreamUrl?: string | null;
  /** r79: resolver codec strings forwarded to MSEStreamPlayer so it can build
   *  the MSE MIME directly and skip the fragile raw-stream probe. */
  streamVideoCodec?: string | null;
  streamAudioCodec?: string | null;
  /** Initial volume for the LocalMediaPlayer when it mounts. */
  initialVolume: number;
  /**
   * True while ffmpeg is transcoding the imported file into a
   * WKWebView-compatible MP4/MP3. Drives a translucent overlay so the user
   * knows why the canvas might be black for a few seconds.
   */
  playbackPrepBusy?: boolean;
  playbackPrepProgress?: number;
  /**
   * When set, shows a centered "working on it" overlay (spinner + this
   * message) over the poster while a web source resolves/buffers (r62).
   * Null hides it. Distinct from the download banner (playbackPrepBusy).
   */
  streamLoadingPhase?: string | null;
  /**
   * Fired when the user clicks the inline Cancel button inside the prep
   * banner (added in r55). Wired through to the same `handleStop`
   * pathway that the Pipeline-panel Stop button uses, so there's a
   * single cancel codepath regardless of where the user clicks. When
   * omitted, the banner renders without a Cancel button.
   */
  onCancelPlaybackPrep?: () => void;
  /**
   * Use mediabunny/WebCodecs for local playback instead of the ffmpeg-
   * prep + <video> path. Controlled by Settings → Local playback.
   */
  useWebCodecs?: boolean;
  onMediaError?: (msg: string) => void;
  /** Transient toast — auto-fades after a few seconds. */
  toast: { id: number; kind: ToastKind; title: string; body?: string } | null;
  onToastDismiss: () => void;
  onPlayerTimeUpdate?: (seconds: number) => void;
  onPlayerStateChange?: (playing: boolean) => void;
  onPlayerReady?: (duration: number) => void;
  onSurfaceClick?: () => void;
  /** Active transcript path (SRT/VTT) for the on-video caption overlay. */
  transcriptPath?: string | null;
  /** Bumped on every transcript arrival — forces a cue re-read when a
   *  regeneration overwrote the SAME path. */
  transcriptReloadToken?: number;
  /** Current playhead position in seconds — picks which caption cue shows. */
  currentSec?: number;
  /** Whether the transport-bar captions toggle is on. */
  captionsOn?: boolean;
  /** User-tunable caption appearance (Settings → Captions). */
  captionStyle?: CaptionStyle;
  /** Live HH:MM:SS:FF for the type-a-timecode HUD; null hides it. */
  tcOverlay?: string | null;
  /** Signed J-K-L shuttle rate (e.g. -4 = rewind 4×); 0/undefined hides the badge. */
  shuttleRate?: number;
  /** Transient playback-speed HUD — the just-chosen rate (e.g. 1.5), flashed
   *  briefly by App when the speed changes; null hides it. */
  playbackRateHud?: number | null;
  /** Review drawing annotation to render over the frame (draft or saved). */
  annotation?: AnnotationStrokes | null;
  /** True while the Review panel is in draw mode (overlay captures input). */
  annotationDrawing?: boolean;
  /** Read-only display opacity (proximity fade); 1 when drawing/pinned. */
  annotationOpacity?: number;
  onAnnotationChange?: (a: AnnotationStrokes) => void;
  onAnnotationDismiss?: () => void;
};

/**
 * Sizes the monitor element to fit its parent at a fixed aspect ratio
 * (true `object-fit: contain` semantics — pure CSS can't do this for a
 * <div> when both axes are unknown).
 *
 * ResizeObserver also fires synchronously the first time we observe, so
 * one useLayoutEffect covers both the initial measurement and any later
 * window/panel resizes.
 */
function useContainSize(aspect: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent || !aspect || !isFinite(aspect)) return;
    const measure = () => {
      const pw = parent.clientWidth;
      const ph = parent.clientHeight;
      if (pw <= 0 || ph <= 0) return;
      let w = pw, h = pw / aspect;
      if (h > ph) { h = ph; w = ph * aspect; }
      setDims({ w: Math.floor(w), h: Math.floor(h) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [aspect]);

  return { ref, dims };
}

export const Monitor = forwardRef<PlayerHandle, Props>(function Monitor(props, ref) {
  const {
    status, metadata,
    errorDetail,
    aspect,
    sourceKind, localFilePath, webStreamUrl, onDiag, audioStreamUrl, streamVideoCodec, streamAudioCodec, initialVolume, onMediaError,
    playbackPrepBusy, playbackPrepProgress, onCancelPlaybackPrep, useWebCodecs,
    streamLoadingPhase,
    toast, onToastDismiss,
    onPlayerTimeUpdate, onPlayerStateChange, onPlayerReady, onSurfaceClick,
    transcriptPath, transcriptReloadToken, currentSec, captionsOn, captionStyle, tcOverlay,
    shuttleRate, playbackRateHud,
    annotation, annotationDrawing, annotationOpacity, onAnnotationChange, onAnnotationDismiss,
  } = props;

  const natural = metadata?.width && metadata?.height ? metadata.width / metadata.height : 16 / 9;
  const ratio: number = aspect === "off"  ? natural
                      : aspect === "16:9" ? 16 / 9
                      : aspect === "9:16" ? 9 / 16
                      : aspect === "1:1"  ? 1
                      : aspect === "2.39" ? 2.39
                      : natural;
  const { ref: monitorRef, dims } = useContainSize(ratio);
  const monitorStyle = dims ? { width: `${dims.w}px`, height: `${dims.h}px` } : undefined;

  if (status === "empty") {
    return (
      <div className="cp-monitor-area">
        <div className="cp-monitor" ref={monitorRef} style={monitorStyle}>
          <div className="cp-empty">
            <div className="cp-empty-perf">
              <span /><span /><span /><span /><span /><span /><span /><span />
            </div>
            <h3>Paste a video URL</h3>
            <p>YouTube, Vimeo, TikTok, Twitter/X, Reddit, Instagram, or any page with embedded video. Sauce Bunny resolves the highest-quality stream available — no host branding, no metadata you didn't ask for.</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === "fetching") {
    return (
      <div className="cp-monitor-area">
        <div className="cp-monitor" ref={monitorRef} style={monitorStyle}>
          <div className="cp-fetching">
            <div className="cp-scanline" />
            <div className="status">RESOLVING SOURCE STREAM…</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-5)", letterSpacing: "0.06em" }}>
              yt-dlp · probing manifests
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="cp-monitor-area">
        <div className="cp-monitor" ref={monitorRef} style={monitorStyle}>
          {metadata?.thumbnail && (
            <img className="cp-monitor-img" src={metadata.thumbnail} alt=""
                 style={{ filter: "grayscale(0.6) brightness(0.4)" }} referrerPolicy="no-referrer" />
          )}
          <div className="cp-error-overlay">
            <div className="icon"><IconAlert size={20} /></div>
            <div className="label">Couldn't resolve source</div>
            <div className="detail">{errorDetail ?? "Unknown error"}</div>
          </div>
        </div>
      </div>
    );
  }

  // loaded / exporting / success — minimal overlays per design feedback.
  return (
    <div className="cp-monitor-area">
      <div className="cp-monitor" ref={monitorRef} style={monitorStyle}>
        {sourceKind === "file" && localFilePath ? (
          useWebCodecs ? (
            <MediaBunnyPlayer
              ref={ref}
              path={localFilePath}
              filename={metadata?.title}
              hasVideo={!!metadata?.vcodec}
              initialVolume={initialVolume}
              onTimeUpdate={onPlayerTimeUpdate}
              onPlayStateChange={onPlayerStateChange}
              onReady={onPlayerReady}
              onError={onMediaError}
              onSurfaceClick={onSurfaceClick}
            />
          ) : (
            <LocalMediaPlayer
              ref={ref}
              path={localFilePath}
              filename={metadata?.title}
              hasVideo={!!metadata?.vcodec}
              initialVolume={initialVolume}
              onTimeUpdate={onPlayerTimeUpdate}
              onPlayStateChange={onPlayerStateChange}
              onReady={onPlayerReady}
              onError={onMediaError}
              onDiag={onDiag}
              onSurfaceClick={onSurfaceClick}
            />
          )
        ) : webStreamUrl ? (
          // Web sources. Player choice by URL type (r61):
          //   • http(s) proxy stream URL → MSEStreamPlayer. Streams into a
          //     native <video> via Media Source Extensions: bytes fetched
          //     through the CORS proxy, remuxed to fMP4 by mediabunny, fed
          //     to a same-origin blob: MediaSource → WebKit's NATIVE decoder
          //     → FULL AUDIO + video. This is the only path that gets audio
          //     (cross-origin <video> is blocked; WebCodecs has no audio
          //     decoder < Safari 26). On any failure, onMediaError → App.tsx
          //     falls back to the download path, so it can't regress.
          //   • local cached file (download fallback) → LocalMediaPlayer
          //     (<video>/asset://), which plays AAC because it's same-origin
          //     on disk.
          /^https?:\/\//i.test(webStreamUrl) ? (
            <MSEStreamPlayer
              ref={ref}
              path={webStreamUrl}
              filename={metadata?.title}
              hasVideo
              /* r75: separate audio track → proxy merges it into the fMP4 so
                 DASH-split sources (Reddit, YouTube >360p) stream with sound. */
              onDiag={onDiag}
              audioStreamUrl={audioStreamUrl ?? undefined}
              /* r79: known codecs → MSEStreamPlayer skips the raw-stream probe. */
              videoCodec={streamVideoCodec ?? undefined}
              audioCodec={streamAudioCodec ?? undefined}
              /* Authoritative duration so far seeks don't clamp to a short
                 stream-probe value (was sending 19:40 to 15:12). */
              knownDuration={metadata?.duration ?? undefined}
              initialVolume={initialVolume}
              onTimeUpdate={onPlayerTimeUpdate}
              onPlayStateChange={onPlayerStateChange}
              onReady={onPlayerReady}
              onError={onMediaError}
              onSurfaceClick={onSurfaceClick}
            />
          ) : (
            <LocalMediaPlayer
              ref={ref}
              path={webStreamUrl}
              filename={metadata?.title}
              hasVideo
              initialVolume={initialVolume}
              onTimeUpdate={onPlayerTimeUpdate}
              onPlayStateChange={onPlayerStateChange}
              onReady={onPlayerReady}
              onError={onMediaError}
              onDiag={onDiag}
              onSurfaceClick={onSurfaceClick}
            />
          )
        ) : metadata?.thumbnail && (
          <img className="cp-monitor-img" src={metadata.thumbnail} alt={metadata.title} referrerPolicy="no-referrer" />
        )}

        {/* On-video subtitle overlay — driven by our own transcript, so it
            works for any source (web stream / local file) regardless of
            WKWebView's native <track> support. Self-contained: loads the
            cues itself when captions are toggled on. */}
        <CaptionOverlay
          path={transcriptPath ?? null}
          reloadToken={transcriptReloadToken}
          currentSec={currentSec ?? 0}
          enabled={!!captionsOn}
          style={captionStyle}
        />

        {/* Review drawing annotations — draw on the frame (draft) or view a
            saved one. Pointer-transparent unless actively drawing. */}
        <AnnotationOverlay
          annotation={annotation ?? null}
          drawing={!!annotationDrawing}
          opacity={annotationOpacity ?? 1}
          onChange={onAnnotationChange ?? (() => {})}
          onDismiss={onAnnotationDismiss}
        />

        {/* Type-a-timecode HUD — appears the moment the user types a digit
            over the player; Return snaps the playhead, Esc cancels. Driven
            entirely by App's keyboard handler + state. */}
        {tcOverlay && (
          <div className="cp-tc-hud">
            <div className="cp-tc-hud-label">Go to timecode</div>
            <div className="cp-tc-hud-value">{tcOverlay}</div>
            <div className="cp-tc-hud-hint">Return to snap · Esc to cancel</div>
          </div>
        )}

        {/* J-K-L shuttle badge — direction + speed while shuttling (App owns
            the rate; K/Space or landing on +1 clears it). Purely indicative,
            so it's pointer-transparent and hidden from the a11y tree. */}
        {typeof shuttleRate === "number" && shuttleRate !== 0 && (
          <div className="cp-shuttle-badge" aria-hidden>
            {shuttleRate < 0 ? "◀◀" : "▶▶"} {Math.abs(shuttleRate)}×
          </div>
        )}

        {/* Playback-speed HUD — same pill, flashed briefly when the user's
            persistent rate changes (speed picker / [ ] \ shortcuts). The
            shuttle badge wins while a shuttle is engaged: the shuttle rate is
            what's actually playing at that moment. */}
        {typeof playbackRateHud === "number" && !shuttleRate && (
          <div className="cp-shuttle-badge" aria-hidden>
            {formatPlaybackRate(playbackRateHud)}
          </div>
        )}

        {/* Non-blocking prep banner — sits at the bottom-left of the canvas
            so the player itself is still visible and clickable.
            r55: was gated on `sourceKind === "file"`, which meant the
            web-preview download fallback ran invisibly — the user saw a
            black canvas with no indication anything was happening and no
            on-screen cancel point (Pipeline panel defaults collapsed).
            Now shows for any prep-busy state with source-aware copy and
            an inline Cancel button. */}
        {playbackPrepBusy && (
          <div className="cp-prep-banner">
            <div className="cp-prep-spinner" />
            <div className="cp-prep-text">
              <div className="cp-prep-title">
                {sourceKind === "file" ? "Preparing playback copy…" : "Downloading preview…"}
              </div>
              <div className="cp-prep-sub">
                {sourceKind === "file"
                  ? "Transcoding via ffmpeg for in-app compatibility"
                  : "CDN blocked cross-origin playback — fetching via yt-dlp so you can scrub in-app"}
                {playbackPrepProgress != null && playbackPrepProgress > 0
                  ? ` · ${Math.round(playbackPrepProgress)}%`
                  : ""}
              </div>
            </div>
            {onCancelPlaybackPrep && (
              <button
                type="button"
                className="cp-prep-cancel"
                onClick={onCancelPlaybackPrep}
                title="Cancel the running preparation"
              >
                Cancel
              </button>
            )}
          </div>
        )}

        {/* r62: full-canvas "preparing your video" overlay for web sources.
            Covers the ~8s yt-dlp resolve + MSE buffer window with a dimmed
            poster, a spinner, and a phase message so the wait reads as
            intentional, not frozen. Cleared once the player reports ready. */}
        {streamLoadingPhase && (
          <div className="cp-stream-loading">
            {metadata?.thumbnail && (
              <img
                className="cp-stream-loading-bg"
                src={metadata.thumbnail}
                alt=""
                referrerPolicy="no-referrer"
              />
            )}
            <div className="cp-stream-loading-inner">
              <div className="cp-stream-spinner" />
              <div className="cp-stream-loading-title">{streamLoadingPhase}</div>
              <div className="cp-stream-loading-sub">
                Preparing your video — this can take a few seconds.
              </div>
            </div>
          </div>
        )}

        {/* Completion is announced via the floating toast + the notification
            bell up in the toolbar — the canvas stays clean. */}
        {toast && (
          <CanvasToast
            /* Keyed on the monotonic id: replacing a visible toast remounts
               with a FRESH countdown instead of inheriting the old timer. */
            key={toast.id}
            kind={toast.kind}
            title={toast.title}
            body={toast.body}
            /* When the bottom-left prep banner is up (e.g. the web-preview
               download), lift the centered toast above it so the two don't
               collide in the same bottom band. */
            className={playbackPrepBusy ? "cp-canvas-toast--above-banner" : undefined}
            onDismiss={onToastDismiss}
          />
        )}
      </div>
    </div>
  );
});
