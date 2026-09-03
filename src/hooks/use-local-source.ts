import { useCallback, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppError, AppStatus, ClientLog, ExportOpts, LocalFileMeta, Metadata, SourceKind,
} from "../types";
import type { RecentSource } from "../lib/recent-sources";
import type { Defaults } from "../components/SettingsModal";
import { assetUrl } from "../lib/asset-url";
import { formatError, isAppError } from "../lib/error-format";
import { chosenPosterFor } from "../lib/library";
import { probeMediabunnyDecode, extractPosterBlob } from "../lib/mediabunny-helpers";
import { setPlayheadFrames as publishPlayheadFrames } from "../lib/playhead-store";

/** Enumerated by tsc from the moved block; each type read from the declaration
 *  the value still has in App.tsx. */
export type LocalSourceProps = {
  defaults: Defaults;
  sourceSeqRef: { current: number };

  // Source + player state this path writes
  setMetadata: Dispatch<SetStateAction<Metadata | null>>;
  setLocalFilePath: Dispatch<SetStateAction<string | null>>;
  setLocalFileSize: Dispatch<SetStateAction<number | null>>;
  setLocalPlayer: Dispatch<SetStateAction<"native" | "mediabunny">>;
  setSourceKind: Dispatch<SetStateAction<SourceKind>>;
  setStatus: Dispatch<SetStateAction<AppStatus>>;
  setErrorDetail: Dispatch<SetStateAction<string | null>>;
  setExportOpts: Dispatch<SetStateAction<ExportOpts>>;
  setInFrames: Dispatch<SetStateAction<number | null>>;
  setOutFrames: Dispatch<SetStateAction<number | null>>;
  setUrl: Dispatch<SetStateAction<string>>;

  // Collaborators, all declared before this hook runs
  resetForNewSource: (sourceKey: string) => void;
  tryAutoLoadTranscript: (
    input: { sourcePath?: string | null; sourceUrl?: string | null }, seq: number,
  ) => Promise<void>;
  recordRecentSource: (entry: {
    kind: RecentSource["kind"]; value: string; title: string; durationSeconds?: number;
  }) => void;
  seedFilename: (prevName: string, title: string) => string;
  runPlaybackPrep: (
    inputPath: string, hasVideo: boolean, durationSeconds: number | null, seq: number,
    /** Keep the video stream and re-encode only the audio. See the call site:
     *  it is set when the probe says the video decodes and the video codec is
     *  one the native player can open. */
    copyVideo?: boolean,
  ) => Promise<void>;
  openSourceView: () => void;
  appendLog: (tag: ClientLog["tag"], source: string, message: string) => void;
};


/**
 * The local-file load path: a picked path in, probed metadata + the right
 * player + any attached transcript out.
 *
 * Lifted from App.tsx verbatim (r157). Sibling to use-fetch-source, and
 * deliberately a SEPARATE hook: handleFetch must be declared before the
 * extractor-rot retry effect that calls it, while this depends on
 * runPlaybackPrep and openSourceView, which are declared after that effect.
 * One call site cannot satisfy both without reordering declarations, and the
 * ordering in App.tsx is load-bearing (see the comment above sessionRoomRef).
 *
 * This is also where the three-way player selection lives - native <video>,
 * mediabunny/WebCodecs, or an ffmpeg playback copy - so the codec probe and the
 * poster extraction travel with it.
 */
export function useLocalSource(p: LocalSourceProps) {
  // Destructured so the block below is byte-identical to App.tsx.
  const {
    defaults,
    sourceSeqRef,
    setMetadata,
    setLocalFilePath,
    setLocalFileSize,
    setLocalPlayer,
    setSourceKind,
    setStatus,
    setErrorDetail,
    setExportOpts,
    setInFrames,
    setOutFrames,
    setUrl,
    resetForNewSource,
    tryAutoLoadTranscript,
    recordRecentSource,
    seedFilename,
    runPlaybackPrep,
    openSourceView,
    appendLog,
  } = p;

  const loadLocalPath = useCallback(async (
    picked: string,
    // When an explicit transcript will be attached by the caller (Library
    // transcript-shelf open), skip the newest-transcript auto-loader so the
    // user's chosen entry wins the race instead of the auto-loaded one.
    skipAutoTranscript = false,
  ): Promise<{ message: string; kind: AppError["kind"] | null } | null> => {
    try {
      // Local-path purity (r112): the local pipeline must never receive a
      // web URL — web sources go through handleFetch (yt-dlp + proxy). The
      // backend guards this too (probe_local_file rejects URLs); failing
      // here as well keeps the mistake loud and immediate. AppError-shaped
      // so the catch below formats and classifies it like any backend error.
      if (/^https?:\/\//i.test(picked.trim())) {
        throw { kind: "Invalid", data: `Local import got a web URL (${picked}). This is a bug: web sources must go through Fetch.` } satisfies AppError;
      }
      // Surface the working view - Clip normally, but a live session's
      // room owns source opens (the Review workspace is sticky: loading
      // content must not bounce you out of the session).
      openSourceView();
      resetForNewSource(picked);
      // BEFORE the probe, not after it. resetForNewSource hardcodes
      // setSourceKind("youtube"), and this used to be set once the probe had
      // returned - so for the whole probe window a LOCAL file open rendered
      // the web copy: "RESOLVING SOURCE STREAM..." over "yt-dlp - probing
      // manifests" in the Monitor, "Resolving..." in the sidebar, "RESOLVING"
      // in the logs panel. Reported as "loading a local file routed first to
      // yt-dlp", which is not a misreading of anything: the app said so.
      // Monitor.tsx already carries a comment explaining that this copy was
      // corrected once because it lied about local opens. The copy was fine;
      // the ORDERING defeated it.
      setSourceKind("file");
      const seq = ++sourceSeqRef.current;
      setStatus("fetching");
      appendLog("info", "local", `Opening local file: ${picked}`);

      const lf = await invoke<LocalFileMeta>("probe_local_file", { path: picked });
      if (sourceSeqRef.current !== seq) return null;

      // Adapt the local file shape to the existing Metadata so the rest of
      // the UI (sidebar, monitor, settings) can stay agnostic. webpage_url
      // is set to a file:// marker so URL-keyed paths know to bail out.
      const m: Metadata = {
        title: lf.filename,
        duration: lf.duration,
        thumbnail: null,
        uploader: lf.has_video ? "Local video" : "Local audio",
        upload_date: null,
        view_count: null,
        webpage_url: `file://${lf.path}`,
        width: lf.width,
        height: lf.height,
        fps: lf.fps,
        vcodec: lf.vcodec,
        acodec: lf.acodec,
        ext: lf.filename.split(".").pop() ?? null,
        has_subs: false, chapters: [], description: null,
      };
      setMetadata(m);

      // Fire-and-forget thumbnail extraction — fills in the blank sidebar
      // square without blocking the rest of the import.
      //
      // Two paths, mediabunny preferred (no ffmpeg subprocess):
      //   1. extractPosterBlob → object URL → set as data thumbnail (a chosen
      //      poster time, else the representative frame — never a black fade)
      //   2. generate_local_thumbnail (ffmpeg) → asset:// URL (legacy
      //      fallback for codecs WebCodecs can't decode). Has its own
      //      hash-based cache so re-imports stay instant.
      if (lf.has_video) {
        (async () => {
          // Respect a user-chosen poster; otherwise the representative frame
          // (extractPosterBlob skips black intro fades) — never frame 0.
          const chosen = chosenPosterFor(lf.path);
          try {
            // Step 1: try mediabunny if the user has it enabled.
            const blob = defaults.useWebCodecsDecoder
              ? await extractPosterBlob(lf.path, { atSeconds: chosen ?? undefined, maxWidth: 640, quality: 0.85 })
              : null;
            if (blob) {
              if (sourceSeqRef.current !== seq) return;
              // Persist into the SAME hash-keyed thumb cache the ffmpeg path
              // uses and reference it via asset://. The old session blob: URL
              // pinned the decoded JPEG for the app's lifetime AND escaped
              // into persisted recents/queue rows, where it rendered as a
              // broken image after relaunch (blob URLs die with the page).
              const posterPath = await invoke<string>(
                "save_poster_to_cache",
                new Uint8Array(await blob.arrayBuffer()),
                {
                  headers: {
                    "x-source-path": encodeURIComponent(lf.path),
                    ...(chosen != null ? { "x-time-seconds": String(chosen) } : {}),
                  },
                },
              );
              if (sourceSeqRef.current !== seq) return;
              setMetadata((prev) => (prev ? { ...prev, thumbnail: assetUrl(posterPath) } : prev));
              return;
            }
            // Step 2: ffmpeg fallback (legacy path).
            const thumbPath = await invoke<string>("generate_local_thumbnail", {
              args: { input_path: lf.path, duration_seconds: lf.duration, time_seconds: chosen ?? null },
            });
            if (sourceSeqRef.current !== seq) return;
            setMetadata((prev) => (prev ? { ...prev, thumbnail: assetUrl(thumbPath) } : prev));
          } catch (err) {
            if (sourceSeqRef.current !== seq) return;
            appendLog("warn", "local", `Thumbnail generation failed: ${formatError(err)}`);
          }
        })();
      }
      setLocalFilePath(lf.path);
      setLocalFileSize(lf.size_bytes ?? null);
      setUrl("");
      publishPlayheadFrames(0);
      setInFrames(null);
      setOutFrames(null);
      setExportOpts((prev) => ({
        ...prev,
        folder: prev.folder ?? defaults.folder,
        // Audio→1080 reset on import is intentional even though MP3
        // export now works for local files: if the user was on Audio
        // for a YouTube extraction and now imports a video file, video
        // is overwhelmingly the more likely target. They can click MP3
        // back on if they actually want audio-only.
        format: prev.format === "audio" ? "1080" : prev.format,
        filename: seedFilename(prev.filename, lf.filename.replace(/\.[^.]+$/, "")),
      }));
      appendLog(
        "ok",
        "local",
        `${lf.has_video ? `${lf.width ?? "?"}×${lf.height ?? "?"} · ${lf.fps ?? "?"} fps · ${lf.vcodec ?? "?"} · ` : ""}${
          lf.acodec ?? "no audio"
        } · ${lf.duration?.toFixed(1) ?? "?"}s`
      );
      // Auto-load any prior transcript we generated for this exact file
      // path. Silent miss — first-time imports proceed normally. seq-guarded
      // so a source switch mid-probe can't attach this file's transcript to
      // the next source. Skipped when the caller will attach an explicit one.
      if (!skipAutoTranscript) void tryAutoLoadTranscript({ sourcePath: picked }, seq);
      setStatus("loaded");
      // Probe succeeded → the import is a successful load; record it.
      recordRecentSource({
        kind: "file",
        value: lf.path,
        title: lf.filename,
        durationSeconds: lf.duration ?? undefined,
      });

      // ─── Playback prep ─────────────────────────────────────────────
      // WKWebView often can't decode arbitrary MP4s (HEVC, High-10, missing
      // faststart, etc.) — symptom is a black canvas while the transport
      // counter ticks. We always normalise through ffmpeg into a known-good
      // H.264 baseline-equivalent + yuv420p + faststart file. Original is
      // kept for transcribe/export.
      //
      // ─── Smart playback path selection ─────────────────────────────
      // Pick the cheapest viable strategy based on the codecs we just
      // probed. The expensive option (full transcode) is reserved for
      // codecs WKWebView genuinely can't handle.
      //
      // What Safari/WKWebView decodes natively in <video> (2026):
      //   • Video: H.264 (all Macs), HEVC (most modern Macs), AV1 (M3+ only)
      //   • Audio: AAC, MP3 in MP4 container; Opus in WebM/Ogg ONLY
      // See: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
      //
      // Strategy (revised r107): MEDIABUNNY-FIRST for local files. The old
      // r93 native-first short-circuit (h264/aac → play the original via a
      // native <video src="asset://…">) proved UNRELIABLE — WKWebView's media
      // element hangs on large local originals ("duration 0.0s", black canvas,
      // never loads) and often doesn't even fire an `error` event, so it can't
      // be caught and recovered. MediaBunnyPlayer instead reads the file via
      // a CustomSource (native byte-range reads, r107) and decodes with
      // WebCodecs — which on Safari 26 covers h264/hevc/av1/vp9 + aac/mp3/opus
      // and works regardless of file size. So we probe mediabunny FIRST; only
      // when WebCodecs genuinely can't decode do we ffmpeg-transcode to a
      // small normalised cache copy and play THAT via native <video> (small
      // copies load fine over asset://).
      //
      // What WKWebView/WebCodecs decodes (2026): H.264 (all Macs), HEVC (most),
      // AV1 (M3+); AAC/MP3/Opus audio (Safari 26 has the WebCodecs AudioDecoder).
      const vc = (lf.vcodec ?? "").toLowerCase();
      const ac = (lf.acodec ?? "").toLowerCase();
      const videoNative = !lf.has_video || vc.startsWith("h264") || vc.startsWith("avc");
      const audioNative = !lf.has_audio || ac.startsWith("aac") || ac.startsWith("mp3");
      const ext = (lf.filename.split(".").pop() ?? "").toLowerCase();
      const containerOk = lf.has_video
        ? ["mp4", "m4v", "mov"].includes(ext)
        : ["mp3", "m4a", "aac", "wav", "mp4", "m4v", "mov"].includes(ext);

      // Probe whether WebCodecs (+ our registered WASM decoders) can decode
      // this file IN-APP. If so, play the original directly via MediaBunnyPlayer
      // with NO ffmpeg transcode — the reliable path for any local file.
      //
      // The Settings toggle is an OPT-OUT, not an opt-in. It defaults to true,
      // so mediabunny-first is still the path everyone gets without touching
      // anything — but a user who turns it off gets the ffmpeg-prep + <video>
      // path, which is exactly what its description has always promised
      // ("Disable if local files won't play"). It used to promise that and do
      // nothing: this hook read the flag only for POSTER extraction, so the
      // one control the UI offers for a misbehaving decoder changed the
      // thumbnail and not the playback.
      //
      // That gap matters because the automatic fallback cannot cover it.
      // `webCodecsFallbackForImport` reroutes an import when MediaBunnyPlayer
      // REPORTS an undecodable codec — but a track that decodes and is
      // inaudible reports nothing, so nothing reroutes. A file that plays with
      // a perfect picture and no sound is the case with no automatic way out,
      // and therefore the case the manual one has to actually work for.
      const probe = defaults.useWebCodecsDecoder
        ? await probeMediabunnyDecode(lf.path)
        : { video: "undecodable" as const, audio: "undecodable" as const };
      const canMb = defaults.useWebCodecsDecoder
        && !(probe.video === "absent" && probe.audio === "absent")
        && probe.video !== "undecodable" && probe.audio !== "undecodable";
      if (sourceSeqRef.current !== seq) return null;
      if (canMb) {
        setLocalPlayer("mediabunny");
        appendLog("ok", "local",
          `Decoding via mediabunny (${vc || "?"} / ${ac || "?"}); no transcode.`);
        return null;
      }

      // Mediabunny can't decode this file here (e.g. a codec WebCodecs lacks
      // and we don't polyfill). Fall back to the ffmpeg-prep + <video> path.
      setLocalPlayer("native");

      // Surface what we're transcoding and why so the user understands the wait.
      const reasonParts: string[] = [];
      if (!videoNative) reasonParts.push(`video ${vc || "?"} → h264`);
      if (!audioNative) reasonParts.push(`audio ${ac || "?"} → aac`);
      if (!containerOk)  reasonParts.push(`container .${ext} → .mp4`);
      // A file whose codecs are ALL native still gets here when the toggle is
      // off, and then there is nothing to list — the old line rendered as
      // "Transcoding for playback: ." and told the user the wait had no cause.
      // The toggle IS the cause, so name it, and name it first when both apply.
      if (!defaults.useWebCodecsDecoder) {
        reasonParts.unshift("WebCodecs decoder off in Settings");
      }
      appendLog("info", "local",
        `Transcoding for playback: ${reasonParts.join(", ")}.`);
      /* ONLY THE AUDIO IS BROKEN? Then only fix the audio.
         The probe is an AND, so a file with good H.264 video and one
         undecodable audio track failed the whole check and was sent here to
         have EVERY FRAME re-encoded through h264_videotoolbox - minutes of
         work to solve a problem in the sound. The comment above names that as
         the common case (AAC in WKWebView, which has no AudioDecoder before
         Safari 26), so the expensive path was the usual one.
         The video codec must be one the NATIVE player can open, because that
         is what plays the prep output. mediabunny decodes ProRes through
         turbores, so "video is fine" does not imply "native can open it" -
         copying a ProRes stream into an MP4 would produce exactly the black
         canvas this path exists to avoid. h264/hevc only. */
      const copyVideo = probe.video === "ok"
        && probe.audio === "undecodable"
        && /^(h264|avc1?|hevc|h265|hvc1)/i.test(vc ?? "");
      if (copyVideo) {
        appendLog("info", "local",
          `Video is fine; remuxing and re-encoding audio only (no video transcode).`);
      }
      await runPlaybackPrep(lf.path, lf.has_video, lf.duration, seq, copyVideo);
      return null;
    } catch (err) {
      const msg = formatError(err);
      setErrorDetail(msg);
      appendLog("err", "local", msg);
      setStatus("error");
      return { message: msg, kind: isAppError(err) ? err.kind : null };
    }
  }, [appendLog, defaults.folder, defaults.useWebCodecsDecoder, resetForNewSource, runPlaybackPrep, recordRecentSource,
      openSourceView, seedFilename, tryAutoLoadTranscript, setErrorDetail, setExportOpts, setInFrames, setLocalFilePath, setLocalFileSize, setLocalPlayer, setMetadata, setOutFrames, setSourceKind, setStatus, setUrl, sourceSeqRef]);

  return { loadLocalPath };
}
