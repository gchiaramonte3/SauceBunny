import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeepAction } from "../lib/stream-keep";
import { IconAlert, IconHistory } from "./Icons";
import { BunnyLoader } from "./BunnyLoader";
import { CanvasToast, type ToastKind } from "./CanvasToast";
import { CaptionOverlay, type CaptionStyle } from "./CaptionOverlay";
import { AnnotationOverlay } from "./AnnotationOverlay";
import { usePlayheadSeconds } from "../lib/playhead-store";
import { annotationsNear, shouldReleasePin } from "../lib/annotation-proximity";
import type { AnnotationStrokes } from "../lib/review";
import type { OnboardingStep, OnboardingStepId } from "../lib/onboarding";
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
  /**
   * Stale-yt-dlp recovery for the error overlay. When the surfaced error
   * matches a known extractor-rot signature (lib/validation.ts
   * looksLikeExtractorRot), App passes "offer" → the overlay renders a
   * primary "Update yt-dlp & retry" action ("busy" while the update runs).
   * "spent" — that URL already used its one update+retry cycle — renders
   * an engine-is-current hint under the plain error instead.
   */
  extractorRot?:
    | { phase: "offer" | "busy"; onUpdateAndRetry: () => void }
    | { phase: "spent"; version: string }
    | null;
  /** Most-recent recent-source title — renders a one-click "Resume last
   *  session" button in the empty state. Null hides the affordance. */
  resumeTitle?: string | null;
  onResume?: () => void;
  /** First-run "getting started" checklist for the empty state. Null hides it
   *  (dismissed, or every step already completed once — see lib/onboarding). */
  onboarding?: {
    steps: OnboardingStep[];
    /** Pending step clicked — App routes it (focus URL bar, open Settings…). */
    onStep: (id: OnboardingStepId) => void;
    onDismiss: () => void;
  } | null;
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
  /** r122: when webStreamUrl is a LOCAL cached copy (download fallback),
   *  decode it with MediaBunnyPlayer instead of native <video>. Large cached
   *  files hang WKWebView's media element over asset:// (black canvas, no
   *  error) — the same failure that made local imports mediabunny-first. */
  webCachedUseMediabunny?: boolean;
  /** Seconds the MSE pipeline should start from (fresh-retry resume). */
  streamStartAt?: number;
  /** Tier B peer stream: no random access on the raw route, so the MSE
   *  player's frame-accurate scrub overlay stays off. */
  disableScrubPreview?: boolean;
  /** Tier B quality rung to request, or null for passthrough / non-peer. */
  streamRung?: number | null;
  /** The <video> ran out of buffered media — feeds the rung policy. */
  onStreamStall?: () => void;
  /** What the presenter actually served (rung + relay path). */
  onStreamInfo?: (info: { rung: number | null; relayed: boolean }) => void;
  /** Short status for the streaming-quality chip. Empty means nothing worth
   *  saying — auto sitting at the default rung, or not a peer stream at all. */
  streamRungBadge?: string;
  /** Tooltip for the chip — explains whichever state it is reporting. */
  streamRungBadgeTitle?: string;
  /** S.5: one quiet line about the copy being kept under a live stream. Its
   *  own chip rather than folded into the quality one: they answer different
   *  questions ("how good is this picture" vs "will I still have this after"),
   *  and a chip that means two things gets read as neither. */
  streamKeepBadge?: string | null;
  /** What the keep chip does when clicked, or null when it is only a label.
   *  Drives whether it renders as a button at all — a chip that looks
   *  clickable and does nothing is worse than a plain label. */
  /** The shape is IMPORTED, not retyped. It was spelled out here and in
   *  use-co-review as well as declared in stream-keep, so adding a third kind
   *  broke two copies that had no reason to know about it. */
  streamKeepAction?: KeepAction;
  onStreamKeepAction?: () => void;
  /** Pipeline/seek diagnostics → the Pipeline log (channel "seek"). */
  onDiag?: (tag: string, message: string) => void;
  /** Audio-pipeline diagnostics from MediaBunnyPlayer. Separate from
   *  `onDiag` so the streaming player's lines keep their own log source
   *  instead of both engines reporting under one label. */
  onAudioDiag?: (tag: string, message: string) => void;
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
  /** NLE-style audio blips while scrubbing (MediaBunnyPlayer only). */
  scrubAudio?: boolean;
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
  /** Source frame rate — the captions + annotation-fade overlays convert the
   *  store's frame playhead to seconds with it (same clock everywhere). */
  fps: number;
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
  /** Review drawing annotation to render over the frame — the live draft
   *  while drawing, or a comment's drawing pinned via click. Always full
   *  opacity. Null → the proximity fade (below) takes over. */
  annotation?: AnnotationStrokes | null;
  /** True while the Review panel is in draw mode (overlay captures input). */
  annotationDrawing?: boolean;
  /** Saved drawings for the playhead-proximity fade — when no draft/pinned
   *  `annotation` is up, the nearest drawing appears then fades as the
   *  playhead passes its time. Rendered by a store-subscribing leaf so the
   *  60Hz fade never re-renders App (or the rest of the Monitor). `color`
   *  is the author's reviewer tint for the drawing's label chips. */
  proximityAnnotations?: { time: number; strokes: AnnotationStrokes; color?: string }[];
  onAnnotationChange?: (a: AnnotationStrokes) => void;
  onAnnotationDismiss?: () => void;
  /** True while the Review label tool is active (clicks place text labels). */
  annotationLabelMode?: boolean;
  /** Reviewer colour for annotation label chips. */
  annotationLabelColor?: string;
  /** Source time a PINNED drawing belongs to. Scrubbing well away from it
   *  releases the pin via onAnnotationDismiss, so an opened drawing stops
   *  being painted over the whole timeline. Absent = no automatic release. */
  annotationTime?: number | null;
};

/**
 * Seconds on either side of a drawing's time that the proximity fade spans.
 *
 * Was 0.6, which is fourteen frames at 24fps. A drawing therefore existed for
 * about a third of a second of timeline and was effectively invisible unless
 * you parked on it: scrub past the note somebody left you and you would never
 * know it was there. Reported as wanting "maybe a 5-second interval where it
 * was drawn, and it kind of fades away" - so 2.5 either side, and the fade is
 * linear with distance, which it already was.
 */
const ANNOT_PROX_WINDOW = 2.5;

/**
 * How far the playhead has to travel before a PINNED drawing lets go.
 *
 * Clicking a comment seeks to its time and pins its drawing, which is right:
 * you asked to look at it, and it must not dissolve while you study the
 * frame. But the pin had no release at all, so from then on the drawing was
 * painted over every frame in the source - "the drawing is persistent across
 * all frames". Wider than the proximity window on purpose: nudging a frame or
 * two must not throw away something you deliberately opened.
 */
const ANNOT_PIN_RELEASE = 6;

/**
 * Lets a pinned drawing go once you have scrubbed away from it.
 *
 * A private leaf that subscribes to the playhead so the OWNER of the pin
 * (App) does not have to. That is the same fence TimelineGhosts uses and for
 * the same reason: this reads at up to 60Hz, and a subscription one story up
 * re-renders the whole keep-alive tree on every tick.
 */
function PinnedAnnotationRelease({ time, fps, onRelease }: {
  time: number;
  fps: number;
  onRelease: () => void;
}) {
  const playheadSec = usePlayheadSeconds(fps) ?? 0;
  const firedRef = useRef(false);
  const far = shouldReleasePin(playheadSec, time, ANNOT_PIN_RELEASE);
  useEffect(() => {
    if (far && !firedRef.current) { firedRef.current = true; onRelease(); }
    if (!far) firedRef.current = false;
  }, [far, onRelease]);
  return null;
}

/** Proximity fade — the nearest saved drawing as the playhead passes it,
 *  opacity ramping with distance so it appears then fades while scrubbing.
 *  Subscribes to the playhead store at up to 60Hz; everything it re-renders
 *  is one read-only AnnotationOverlay (opacity is CSS-only there). */
function ProximityAnnotation({ annotations, fps }: {
  annotations: { time: number; strokes: AnnotationStrokes; color?: string }[];
  fps: number;
}) {
  const playheadSec = usePlayheadSeconds(fps) ?? 0;
  // EVERY drawing in the window, not the nearest one. This kept a single
  // best match, so two people annotating the same moment meant one was
  // silently invisible - tie broken by document order. The rule itself lives
  // in lib/annotation-proximity so it can be tested without a canvas.
  const near = annotationsNear(annotations, playheadSec, ANNOT_PROX_WINDOW);
  if (near.length === 0) return null;
  return (
    <>
      {near.map((a) => (
        <AnnotationOverlay
          key={`${a.time}:${a.color ?? ""}`}
          annotation={a.strokes}
          drawing={false}
          opacity={a.opacity}
          onChange={() => {}}
          labelColor={a.color}
        />
      ))}
    </>
  );
}

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
    errorDetail, extractorRot,
    resumeTitle, onResume, onboarding,
    aspect,
    sourceKind, localFilePath, webStreamUrl, webCachedUseMediabunny, streamStartAt, disableScrubPreview, onDiag, onAudioDiag, audioStreamUrl, streamVideoCodec, streamAudioCodec, initialVolume, onMediaError,
    streamRung, onStreamStall, onStreamInfo, streamRungBadge, streamRungBadgeTitle, streamKeepBadge, streamKeepAction, onStreamKeepAction,
    playbackPrepBusy, playbackPrepProgress, onCancelPlaybackPrep, useWebCodecs, scrubAudio,
    streamLoadingPhase,
    toast, onToastDismiss,
    onPlayerTimeUpdate, onPlayerStateChange, onPlayerReady, onSurfaceClick,
    transcriptPath, transcriptReloadToken, fps, captionsOn, captionStyle, tcOverlay,
    shuttleRate, playbackRateHud,
    annotation, annotationDrawing, proximityAnnotations, onAnnotationChange, onAnnotationDismiss,
    annotationLabelMode, annotationLabelColor, annotationTime,
  } = props;

  const natural = metadata?.width && metadata?.height ? metadata.width / metadata.height : 16 / 9;
  const ratio: number = aspect === "off"  ? natural
                      : aspect === "16:9" ? 16 / 9
                      : aspect === "9:16" ? 9 / 16
                      : aspect === "1:1"  ? 1
                      : aspect === "2.39" ? 2.39
                      : natural;
  const { ref: monitorRef, dims } = useContainSize(ratio);
  /* How tall the prep banner actually is, published to CSS so the toast can
     clear it. The lift used to be a hardcoded 72px guessing that height, and
     the guess was low: the banner is a 44px loader plus padding and border,
     and its subtitle wraps, so the centered toast still clipped its top-right
     corner. A magic number tracking another element's box cannot stay
     correct - measure it instead. */
  const prepRef = useRef<HTMLDivElement>(null);
  const [prepH, setPrepH] = useState(0);
  useEffect(() => {
    const el = prepRef.current;
    if (!playbackPrepBusy || !el) { setPrepH(0); return; }
    const ro = new ResizeObserver(() => setPrepH(el.offsetHeight));
    ro.observe(el);
    setPrepH(el.offsetHeight);
    return () => ro.disconnect();
  }, [playbackPrepBusy]);

  const monitorStyle = {
    ...(dims ? { width: `${dims.w}px`, height: `${dims.h}px` } : {}),
    ["--prep-h" as string]: `${prepH}px`,
  };

  /* Floating toast — hoisted above the status early-returns so feedback that
     fires with NO source loaded (a rejected drag-and-drop, a transcript that
     failed to open) is still visible instead of only ticking the bell. */
  const toastEl = toast && (
    <CanvasToast
      /* Keyed on the monotonic id: replacing a visible toast remounts
         with a FRESH countdown instead of inheriting the old timer. */
      key={toast.id}
      kind={toast.kind}
      title={toast.title}
      body={toast.body}
      /* When the bottom-left prep banner is up (e.g. a transcode), lift the
         centered toast clear of it. The distance comes from --prep-h, which
         is measured above, not from a constant. */
      className={playbackPrepBusy ? "cp-canvas-toast--above-banner" : undefined}
      onDismiss={onToastDismiss}
    />
  );

  if (status === "empty") {
    return (
      <div className="cp-monitor-area">
        <div className="cp-monitor" ref={monitorRef} style={monitorStyle}>
          <div className="cp-empty">
            <h3>Paste a URL or drop a file.</h3>
            {resumeTitle && onResume && (
              <button
                type="button"
                className="btn btn-ghost cp-empty-resume"
                onClick={onResume}
                title="Reopen the most recent source"
              >
                <IconHistory size={13} />
                <span>Resume <strong>{resumeTitle}</strong></span>
              </button>
            )}
            {/* First-run checklist — a compact card, not a wizard. Steps derive
                from existing signals (lib/onboarding.ts); done steps are inert. */}
            {onboarding && (
              <div className="cp-getting-started">
                <div className="cp-getting-started-head">
                  <span>Getting started</span>
                  <button
                    type="button"
                    className="cp-getting-started-dismiss"
                    onClick={onboarding.onDismiss}
                    title="Hide this checklist permanently"
                  >
                    Don't show again
                  </button>
                </div>
                {onboarding.steps.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={"cp-getting-started-step" + (s.done ? " done" : "")}
                    disabled={s.done}
                    onClick={() => onboarding.onStep(s.id)}
                  >
                    <span className="cp-getting-started-check" aria-hidden>{s.done ? "✓" : ""}</span>
                    <span className="cp-getting-started-text">
                      <strong>{s.label}</strong>
                      <em>{s.hint}</em>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {toastEl}
        </div>
      </div>
    );
  }

  if (status === "fetching") {
    return (
      <div className="cp-monitor-area">
        <div className="cp-monitor" ref={monitorRef} style={monitorStyle}>
          {/* The copy has to match the source.
              This block was hardcoded to "RESOLVING SOURCE STREAM… yt-dlp ·
              probing manifests" for EVERY fetching state, including opening a
              local file - which never goes near yt-dlp. A local open runs
              probe_local_file (ffmpeg reading headers), so on a long file the
              user watched a yt-dlp message sit there and reasonably concluded
              the app was hanging on yt-dlp. It was not: the label was lying.
              A progress message that names the wrong subsystem does not just
              fail to inform, it actively sends you to debug the wrong thing. */}
          <div className="cp-fetching">
            <div className="cp-scanline" />
            <div className="status">
              {sourceKind === "file" ? "READING FILE…" : "RESOLVING SOURCE STREAM…"}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-5)", letterSpacing: "0.06em" }}>
              {sourceKind === "file" ? "ffmpeg · reading headers" : "yt-dlp · probing manifests"}
            </div>
          </div>
          {toastEl}
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
            {/* Stale-yt-dlp recovery. Sites change their players constantly;
                yt-dlp ships fixes within days — so when the error matches a
                known extractor-breakage signature, the fix is one click, not
                a bug report. Same command as Settings → Web sources. */}
            {extractorRot && extractorRot.phase !== "spent" && (
              <>
                <div className="cp-error-hint">
                  The video engine (yt-dlp) is likely out of date for this
                  site. Updating takes a few seconds.
                </div>
                <button
                  type="button"
                  className="btn btn-primary cp-error-update"
                  onClick={extractorRot.onUpdateAndRetry}
                  disabled={extractorRot.phase === "busy"}
                >
                  {extractorRot.phase === "busy" ? "Updating yt-dlp…" : "Update yt-dlp & retry"}
                </button>
              </>
            )}
            {extractorRot?.phase === "spent" && (
              <div className="cp-error-hint">
                yt-dlp is up to date ({extractorRot.version}). The site may
                have changed; check for an app update.
              </div>
            )}
          </div>
          {toastEl}
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
              scrubAudio={scrubAudio}
              onTimeUpdate={onPlayerTimeUpdate}
              onPlayStateChange={onPlayerStateChange}
              onReady={onPlayerReady}
              onError={onMediaError}
              onSurfaceClick={onSurfaceClick}
              onDiag={onAudioDiag}
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
              startAtSeconds={streamStartAt}
              disableScrubPreview={disableScrubPreview}
              /* Tier B adaptive quality. Absent for a web source, where nobody
                 is transcoding on our behalf. */
              rung={streamRung}
              onStall={onStreamStall}
              onStreamInfo={onStreamInfo}
              initialVolume={initialVolume}
              onTimeUpdate={onPlayerTimeUpdate}
              onPlayStateChange={onPlayerStateChange}
              onReady={onPlayerReady}
              onError={onMediaError}
              onSurfaceClick={onSurfaceClick}
            />
          ) : webCachedUseMediabunny ? (
            /* r122: the cached download-fallback copy decodes in-app via
               WebCodecs. Native <video> over asset:// hangs on large local
               files (black canvas, often no error event) — same reason local
               imports are mediabunny-first since r107. App swaps back to
               LocalMediaPlayer once per cache path if this player errors. */
            <MediaBunnyPlayer
              ref={ref}
              path={webStreamUrl}
              filename={metadata?.title}
              hasVideo
              initialVolume={initialVolume}
              scrubAudio={scrubAudio}
              onTimeUpdate={onPlayerTimeUpdate}
              onPlayStateChange={onPlayerStateChange}
              onReady={onPlayerReady}
              onError={onMediaError}
              onSurfaceClick={onSurfaceClick}
              onDiag={onAudioDiag}
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
          fps={fps}
          enabled={!!captionsOn}
          style={captionStyle}
        />

        {/* Review drawing annotations — draw on the frame (draft), view a
            pinned one, or let the nearest saved drawing fade in/out with the
            playhead. Pointer-transparent unless actively drawing. */}
        {/* A pinned drawing lets go once the playhead has moved well away.
            Rendered beside the overlay rather than inside it: the release
            watches the playhead at 60Hz and must not drag the overlay's
            canvas into that. */}
        {!annotationDrawing && annotation && annotationTime != null && onAnnotationDismiss && (
          <PinnedAnnotationRelease time={annotationTime} fps={fps} onRelease={onAnnotationDismiss} />
        )}
        {annotationDrawing || annotation || !proximityAnnotations?.length ? (
          <AnnotationOverlay
            annotation={annotation ?? null}
            drawing={!!annotationDrawing}
            opacity={1}
            onChange={onAnnotationChange ?? (() => {})}
            onDismiss={onAnnotationDismiss}
            labelMode={!!annotationLabelMode}
            labelColor={annotationLabelColor}
          />
        ) : (
          <ProximityAnnotation annotations={proximityAnnotations} fps={fps} />
        )}

        {/* Streaming-quality chip. Present only when there is something the
            viewer could not otherwise know: that the picture has been reduced,
            or — the case that actually matters — that their host's file is
            crossing a public relay rather than a direct link between the two
            Macs. Silent when auto is sitting at its default rung, because a
            badge that is always on screen stops being read. */}
        {streamRungBadge && (
          <div className="cp-stream-rung" title={streamRungBadgeTitle}>
            {streamRungBadge}
          </div>
        )}

        {/* The background copy. Same chip language as the quality one, stacked
            under it, and deliberately understated: nobody asked for this, so it
            reports and never interrupts. */}
        {streamKeepBadge && (
          streamKeepAction ? (
            /* The chip is the only place the copy is visible, so it is also
               the only sane place to stop one. Stopping is NOT the Settings
               toggle: that is a standing preference, and making it stand in
               for "not this file" would force someone with one huge file to
               disable the feature and remember to turn it back on. */
            <button
              type="button"
              className="cp-stream-rung cp-stream-keep is-action"
              title={streamKeepAction.title}
              onClick={onStreamKeepAction}
            >
              {streamKeepBadge}
            </button>
          ) : (
            <div
              className="cp-stream-rung cp-stream-keep"
              title="While you watch, the host's file is being saved to this Mac. When it finishes, playback switches to your own copy and you can scrub the whole thing."
            >
              {streamKeepBadge}
            </div>
          )
        )}

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
          <div className="cp-prep-banner" ref={prepRef}>
            <BunnyLoader size={44} label="Preparing" />
            <div className="cp-prep-text">
              <div className="cp-prep-title">
                {sourceKind === "file" ? "Preparing playback copy…" : "Downloading preview…"}
              </div>
              <div className="cp-prep-sub">
                {sourceKind === "file"
                  ? "Transcoding via ffmpeg for in-app compatibility"
                  : "CDN blocked in-app streaming. Fetching via yt-dlp so you can scrub."}
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
              <BunnyLoader size={96} label={streamLoadingPhase} />
              <div className="cp-stream-loading-title">{streamLoadingPhase}</div>
              <div className="cp-stream-loading-sub">
                This can take a few seconds.
              </div>
            </div>
          </div>
        )}

        {/* Completion is announced via the floating toast + the notification
            bell up in the toolbar — the canvas stays clean. */}
        {toastEl}
      </div>
    </div>
  );
});
