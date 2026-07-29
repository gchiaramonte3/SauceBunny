import { useEffect, useRef, useState } from "react";
// The ONE byte formatter. The local copy this replaces had no KB tier, so a
// 4 KB sidecar rendered as "0.0 MB" - a real size shown as nothing at all.
import { formatBytes } from "../lib/library";
import { invoke } from "@tauri-apps/api/core";
import { useModalFocus } from "../hooks/use-modal-focus";
import type { MediaInfo } from "../bindings/MediaInfo";
import type { MediaInfoVideo } from "../bindings/MediaInfoVideo";
import { formatError } from "../lib/error-format";

/**
 * Deep media inspector — a compact modal over the ffprobe-backed
 * `probe_media_info` command. Reports the TRUE source file in editor terms
 * (Rec. 709 vs HDR, snapped editorial frame rates, scan type, drop-frame
 * timecode) with the raw ffprobe values demoted to muted secondary lines.
 * Every row and badge carries a toggleable plain-English hint (the ⓘ
 * affordance). Reuses the Settings modal chrome (.cp-modal-*) with a
 * compact sizing override.
 */

type Props = {
  /** Absolute path of the file to probe (the original source, not the
   *  ffmpeg-normalised playback copy). */
  path: string;
  onClose: () => void;
};

/** seconds → H:MM:SS */
function fmtDuration(s: number): string {
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

const fmtMbps = (bps: number) => `${(bps / 1_000_000).toFixed(1)} Mb/s`;
const fmtKbps = (bps: number) => `${Math.round(bps / 1000)} kb/s`;

/** "VBR (±23%)" / "CBR" from the sampled bitrate analysis. */
function fmtBitrateMode(vbr: boolean, cv: number | null): string {
  const spread = cv != null ? ` (±${Math.round(cv * 100)}%)` : "";
  return (vbr ? "VBR" : "CBR") + spread;
}

// ── Editor-friendly value mapping ─────────────────────────────────────────

/** ffprobe primaries/matrix → the name an editor actually uses. */
const GAMUT_NAMES: Record<string, string> = {
  bt709: "Rec. 709",
  bt2020: "Rec. 2020",
  bt2020nc: "Rec. 2020",
  bt2020c: "Rec. 2020",
  smpte170m: "Rec. 601",
  bt470bg: "Rec. 601",
  smpte432: "Display P3",
  "display-p3": "Display P3",
  p3: "Display P3",
  srgb: "sRGB",
};

/** ffprobe transfer → dynamic-range label. */
const TRANSFER_NAMES: Record<string, string> = {
  bt709: "SDR",
  smpte170m: "SDR",
  "arib-std-b67": "HLG (HDR)",
  smpte2084: "PQ / HDR10",
  srgb: "sRGB",
};

/** "Rec. 2020 · HLG (HDR)" primary + the raw ffprobe triple as secondary. */
function colorLines(
  v: MediaInfoVideo,
): { primary: string; secondary: string | null } | null {
  const raw = [v.color_space, v.color_transfer, v.color_primaries]
    .filter((c): c is string => c != null);
  if (raw.length === 0) return null;
  const gamutSrc = v.color_primaries ?? v.color_space;
  const gamut = gamutSrc != null ? GAMUT_NAMES[gamutSrc] ?? gamutSrc : null;
  let range = v.color_transfer != null
    ? TRANSFER_NAMES[v.color_transfer] ?? v.color_transfer
    : null;
  if (range === gamut) range = null; // avoid "sRGB · sRGB"
  let primary = gamut != null && range === "SDR"
    ? `${gamut} (SDR)`
    : [gamut, range].filter((p): p is string => p != null).join(" · ");
  // The matrix is usually redundant with the primaries — fold it in only
  // when it maps to a *different* standard (e.g. a Rec. 601 matrix on 709).
  const matrix = v.color_space != null && v.color_primaries != null
    ? GAMUT_NAMES[v.color_space]
    : undefined;
  if (matrix != null && matrix !== gamut) primary += ` · ${matrix} matrix`;
  if (primary === "") return { primary: raw.join(" · "), secondary: null };
  return { primary, secondary: raw.join(" · ") };
}

/** Standard editorial rates — measured fps within 0.05 snaps to these. */
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];

/** Trim trailing zeros, max 3dp: 30 → "30", 29.97 → "29.97". */
const trimFps = (n: number) => n.toFixed(3).replace(/\.?0+$/, "");

/** Snapped editorial rate as primary; exact measurement demoted below. */
function fpsLines(
  fps: number,
  exact: string | null,
): { primary: string; secondary: string | null } {
  const snapped = STANDARD_RATES.reduce<number | null>(
    (best, r) =>
      Math.abs(fps - r) <= 0.05 && (best == null || Math.abs(fps - r) < Math.abs(fps - best))
        ? r
        : best,
    null,
  );
  if (snapped == null) return { primary: `${trimFps(fps)} fps`, secondary: exact };
  const measured = trimFps(fps) === trimFps(snapped) ? null : `measured ${trimFps(fps)}`;
  return {
    primary: `${trimFps(snapped)} fps`,
    secondary: [measured, exact].filter((s): s is string => s != null).join(" · ") || null,
  };
}

/** Strip ffprobe noise — "(iCodec Pro)" vendor junk, "A / B / C" alias runs —
 *  then fold the profile in unless the name already implies it. */
function cleanCodec(longName: string, profile?: string | null): string {
  let name = (longName.replace(/\s*\([^)]*\)/g, "").split(" / ")[0] ?? "").trim();
  if (name === "") name = longName;
  if (profile == null || name.toLowerCase().includes(profile.toLowerCase())) return name;
  return `${name} ${profile}`;
}

/** ffprobe field_order → row + badge labels; null when unknown/absent. */
function scanInfo(fieldOrder: string | null): { row: string; badge: string } | null {
  if (fieldOrder === "progressive") return { row: "Progressive", badge: "Progressive" };
  if (fieldOrder === "tt" || fieldOrder === "tb")
    return { row: "Interlaced (top field first)", badge: "Interlaced" };
  if (fieldOrder === "bb" || fieldOrder === "bt")
    return { row: "Interlaced (bottom field first)", badge: "Interlaced" };
  return null;
}

// ── "What is this?" hint copy — plain-English, editor-oriented ────────────

const HINTS = {
  allIntra:
    "Every frame is a complete image (no inter-frame compression). Scrubbing and cutting are frame-accurate with no penalty.",
  gop:
    "Most frames store only what changed since the last keyframe, so files are small but scrubbing must decode from the nearest keyframe. Long-GOP footage benefits from proxies or an all-intra transcode for heavy timeline work.",
  vbr:
    "Bitrate rises and falls with scene complexity. Normal for ProRes and most camera codecs.",
  cbr:
    "Bitrate stays flat regardless of scene complexity. Predictable for broadcast and streaming pipelines, slightly less efficient than VBR.",
  vfr:
    "Frame timing varies across the file, typical of screen recordings and phone footage. Conform or transcode to a constant rate before precision editing, or audio can drift out of sync.",
  progressive:
    "Every frame is one complete picture, the modern standard. No deinterlacing needed.",
  interlaced:
    "Each frame is two half-resolution fields captured at slightly different moments. Deinterlace before delivering to modern screens, and preserve field order when transcoding.",
  container:
    "The file wrapper that holds the video and audio streams. It affects compatibility, not quality; the same codec can live in MOV, MP4, or MKV.",
  duration:
    "Total runtime, with the container's reported frame count beneath. Frames ≈ duration × frame rate; a mismatch can flag VFR or a damaged index.",
  size:
    "Size on disk. Divided by duration it should roughly match the overall bitrate.",
  overallBitrate:
    "Total data rate of the whole file: video, audio, and container overhead combined. Higher generally means less compression per frame.",
  timecode:
    "The start timecode embedded by the camera or recorder. Drop-frame is a counting style for 29.97 fps material that skips numbers to stay in sync with the clock; it doesn't drop actual frames.",
  videoCodec:
    "How the picture is compressed. Acquisition codecs (ProRes, DNx) scrub smoothly in an editor; delivery codecs (H.264/HEVC) are far smaller but heavier to edit.",
  fourcc:
    "The four-character code that identifies the exact codec variant inside the container, e.g. apch is ProRes 422 HQ. Useful when two files claim the same codec but behave differently.",
  dimensions:
    "Stored frame size in pixels. Anamorphic footage displays wider than it's stored, so check the display aspect if this looks narrower than expected.",
  frameRate:
    "How many frames play per second. Match your timeline to this rate to avoid pulldown, blended frames, or audio drift.",
  scan:
    "Progressive frames are one complete picture; interlaced frames are two fields captured at different moments. Interlaced material needs deinterlacing for modern delivery.",
  pixelFormat:
    "Chroma subsampling and bit depth: how much color detail each frame keeps. 4:2:0 8-bit is delivery-grade; 4:2:2 10-bit and up holds up to grading and keying.",
  color:
    "The color standard the footage was mastered in. Rec. 709 is standard HD; Rec. 2020 with HLG or PQ means HDR.",
  videoBitrate:
    "Data rate of the video stream alone. At the same codec and frame size, more bits generally means fewer compression artifacts.",
  audioCodec:
    "How the audio is compressed. PCM is uncompressed and safe to cut anywhere; AAC and MP3 are lossy delivery formats best re-encoded as little as possible.",
  channels:
    "Channel count and layout. Stereo is standard delivery; higher counts on camera files are often discrete mic inputs rather than true surround.",
  sampleRate:
    "Audio samples per second. 48 kHz is the video-production standard; 44.1 kHz material gets resampled when conformed.",
  sampleFormat:
    "The numeric format of each audio sample; more bits means more headroom before quantization noise. \"fltp\" is 32-bit float, plenty for post.",
  audioBitrate:
    "Data rate of the audio stream. For lossy codecs, stereo AAC at 192 kb/s and up is generally transparent.",
} as const;

type Row = { label: string; value: string; secondary?: string | null; hint: string };
type Badge = { key: string; label: string; tone?: "warn"; hint: string };

export function MediaInfoModal({ path, onClose }: Props) {
  const [info, setInfo] = useState<MediaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Single open-hint state — one explanation visible at a time, keyed
  // "section:label" for rows and "badge:key" for badges.
  const [openHint, setOpenHint] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    invoke<MediaInfo>("probe_media_info", { path })
      .then((mi) => { if (alive) setInfo(mi); })
      .catch((e) => { if (alive) setError(formatError(e)); });
    return () => { alive = false; };
  }, [path]);

  // Trap Tab inside the dialog + restore focus on close (mounted = open).
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialogRef);

  // Close on Esc — same pattern as SettingsModal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filename = path.split("/").pop() ?? path;
  const v = info?.video ?? null;
  const a = info?.audio ?? null;
  const scan = v ? scanInfo(v.field_order) : null;
  const fps = v?.fps != null ? fpsLines(v.fps, v.fps_exact) : null;
  const color = v ? colorLines(v) : null;
  const vCodec = v ? cleanCodec(v.codec, v.profile) : null;
  const aCodec = a ? cleanCodec(a.codec) : null;

  const toggleHint = (key: string) =>
    setOpenHint((prev) => (prev === key ? null : key));

  // Verdict badges — the "what kind of file is this, really" summary line.
  const badges: Badge[] = [];
  if (v) {
    if (v.all_intra) {
      badges.push({ key: "intra", label: "All-intra", hint: HINTS.allIntra });
    } else if (v.keyframe_ratio != null && v.keyframe_ratio > 0) {
      badges.push({
        key: "gop",
        label: `GOP (keyframe every ~${Math.round(1 / v.keyframe_ratio)})`,
        hint: HINTS.gop,
      });
    }
    if (v.vbr != null) {
      badges.push({
        key: "brmode",
        label: fmtBitrateMode(v.vbr, v.bitrate_cv),
        hint: v.vbr ? HINTS.vbr : HINTS.cbr,
      });
    }
    if (v.vfr) badges.push({ key: "vfr", label: "VFR", tone: "warn", hint: HINTS.vfr });
    if (scan) {
      badges.push({
        key: "scan",
        label: scan.badge,
        hint: scan.badge === "Progressive" ? HINTS.progressive : HINTS.interlaced,
      });
    }
  }
  const openBadge = badges.find((b) => openHint === `badge:${b.key}`) ?? null;

  /** Definition rows — null entries drop the row entirely. */
  const renderRows = (section: string, items: (Row | null)[]) =>
    items
      .filter((r): r is Row => r != null)
      .map((r) => {
        const key = `${section}:${r.label}`;
        const open = openHint === key;
        return (
          <div className="cp-mediainfo-row has-hint" key={key}>
            <div className="k" onClick={() => toggleHint(key)}>
              {r.label}
              <button
                className={"cp-mediainfo-info" + (open ? " open" : "")}
                aria-label={`What is ${r.label}?`}
                aria-expanded={open}
                onClick={(e) => { e.stopPropagation(); toggleHint(key); }}
              >
                i
              </button>
            </div>
            <div className="v">
              <div className="v-primary">{r.value}</div>
              {r.secondary != null && <div className="v-secondary">{r.secondary}</div>}
            </div>
            {open && <div className="cp-mediainfo-hint">{r.hint}</div>}
          </div>
        );
      });

  return (
    <div className="cp-modal-backdrop" onClick={onClose}>
      <div
        className="cp-modal cp-mediainfo"
        role="dialog"
        aria-modal="true"
        aria-label="Media info"
        ref={dialogRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cp-modal-header">
          <h2>Media info</h2>
          <span className="crumb" title={path}>{filename}</span>
          <div className="filler" />
          <button className="cp-modal-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="cp-mediainfo-body">
          {error ? (
            <div className="cp-mediainfo-error">Couldn't probe this file: {error}</div>
          ) : !info ? (
            <div className="cp-mediainfo-loading">Probing…</div>
          ) : (
            <>
              {badges.length > 0 && (
                <div className="cp-mediainfo-badgebar">
                  <div className="cp-mediainfo-badges">
                    {badges.map((b) => {
                      const key = `badge:${b.key}`;
                      const open = openHint === key;
                      return (
                        <button
                          key={b.key}
                          className={
                            "cp-mediainfo-badge" +
                            (b.tone ? ` ${b.tone}` : "") +
                            (open ? " open" : "")
                          }
                          aria-expanded={open}
                          onClick={() => toggleHint(key)}
                        >
                          {b.label}
                        </button>
                      );
                    })}
                  </div>
                  {openBadge && <div className="cp-mediainfo-hint">{openBadge.hint}</div>}
                </div>
              )}

              <div className="cp-mediainfo-section">
                <h3>Container</h3>
                {renderRows("container", [
                  { label: "Format", value: info.container, hint: HINTS.container },
                  info.duration_s != null
                    ? {
                        label: "Duration",
                        value: fmtDuration(info.duration_s),
                        secondary: v?.nb_frames != null ? `${v.nb_frames} frames` : null,
                        hint: HINTS.duration,
                      }
                    : null,
                  { label: "Size", value: formatBytes(info.size_bytes), hint: HINTS.size },
                  info.overall_bitrate_bps != null
                    ? {
                        label: "Overall bitrate",
                        value: fmtMbps(info.overall_bitrate_bps),
                        hint: HINTS.overallBitrate,
                      }
                    : null,
                  info.timecode != null
                    ? {
                        label: "Timecode",
                        value: `${info.timecode} · ${
                          info.timecode.includes(";") ? "Drop-frame" : "Non-drop frame"
                        }`,
                        hint: HINTS.timecode,
                      }
                    : null,
                ])}
              </div>

              {v && (
                <div className="cp-mediainfo-section">
                  <h3>Video</h3>
                  {renderRows("video", [
                    vCodec != null
                      ? {
                          label: "Codec",
                          value: vCodec,
                          secondary: vCodec !== v.codec ? v.codec : null,
                          hint: HINTS.videoCodec,
                        }
                      : null,
                    v.codec_tag != null
                      ? { label: "FourCC", value: v.codec_tag, hint: HINTS.fourcc }
                      : null,
                    {
                      label: "Dimensions",
                      value: `${v.width}×${v.height}`,
                      hint: HINTS.dimensions,
                    },
                    fps != null
                      ? {
                          label: "Frame rate",
                          value: fps.primary,
                          secondary: fps.secondary,
                          hint: HINTS.frameRate,
                        }
                      : null,
                    scan != null ? { label: "Scan", value: scan.row, hint: HINTS.scan } : null,
                    v.pix_fmt != null || v.bit_depth != null
                      ? {
                          label: "Pixel format",
                          value: [v.pix_fmt, v.bit_depth != null ? `${v.bit_depth}-bit` : null]
                            .filter((x): x is string => x != null)
                            .join(" · "),
                          hint: HINTS.pixelFormat,
                        }
                      : null,
                    color != null
                      ? {
                          label: "Color",
                          value: color.primary,
                          secondary: color.secondary,
                          hint: HINTS.color,
                        }
                      : null,
                    v.bitrate_bps != null
                      ? { label: "Bitrate", value: fmtMbps(v.bitrate_bps), hint: HINTS.videoBitrate }
                      : null,
                    v.vbr != null
                      ? {
                          label: "Bitrate mode",
                          value: fmtBitrateMode(v.vbr, v.bitrate_cv),
                          hint: v.vbr ? HINTS.vbr : HINTS.cbr,
                        }
                      : null,
                  ])}
                </div>
              )}

              {a && (
                <div className="cp-mediainfo-section">
                  <h3>Audio</h3>
                  {renderRows("audio", [
                    aCodec != null
                      ? {
                          label: "Codec",
                          value: aCodec,
                          secondary: aCodec !== a.codec ? a.codec : null,
                          hint: HINTS.audioCodec,
                        }
                      : null,
                    {
                      label: "Channels",
                      value: `${a.channels}${a.channel_layout ? ` (${a.channel_layout})` : ""}`,
                      hint: HINTS.channels,
                    },
                    a.sample_rate != null
                      ? {
                          label: "Sample rate",
                          value: `${a.sample_rate / 1000} kHz`,
                          hint: HINTS.sampleRate,
                        }
                      : null,
                    a.sample_fmt != null
                      ? { label: "Sample format", value: a.sample_fmt, hint: HINTS.sampleFormat }
                      : null,
                    a.bitrate_bps != null
                      ? { label: "Bitrate", value: fmtKbps(a.bitrate_bps), hint: HINTS.audioBitrate }
                      : null,
                    a.vbr != null
                      ? {
                          label: "Bitrate mode",
                          value: fmtBitrateMode(a.vbr, a.bitrate_cv),
                          hint: a.vbr ? HINTS.vbr : HINTS.cbr,
                        }
                      : null,
                  ])}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
