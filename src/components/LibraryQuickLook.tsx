import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { assetUrl } from "../lib/asset-url";
import { formatError } from "../lib/error-format";
import type { LocalFileMeta } from "../bindings/LocalFileMeta";

/**
 * Quick Look for the Library: press Space on a file, watch it, press Esc.
 *
 * DELIBERATELY THE NATIVE PATH, NOT A SECOND CLIP PLAYER. The Clip view's
 * player stack exists for frame-accurate scrubbing, marks and export; a
 * preview exists to answer "is this the take?" and nothing else. So this is
 * the same tech the Clip section's smart selection tries FIRST — a native
 * `<video>` on an `asset://` URL — with none of the transport machinery, and
 * a format WKWebView cannot decode degrades to one honest line and an Open in
 * Clip button (where the ffmpeg fallback lives). Building a mediabunny canvas
 * pipeline into a popup would duplicate the hardest code in the app to make a
 * preview marginally better at the exact formats previews matter least for.
 *
 * PROBE FIRST, ALWAYS. The asset scope grants files ONE AT A TIME through
 * `probe_local_file` (see asset-url.ts); skipping it gives a black video with
 * HTTP 403 behind it and no error anywhere. The probe also returns the meta
 * for the caption line, so the roundtrip buys two things.
 */
export function LibraryQuickLook({
  path, name, onClose, onOpenInClip,
}: {
  path: string;
  name: string;
  onClose: () => void;
  onOpenInClip: () => void;
}) {
  const [meta, setMeta] = useState<LocalFileMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);

  useEffect(() => {
    let stale = false;
    invoke<LocalFileMeta>("probe_local_file", { path })
      .then((m) => { if (!stale) setMeta(m); })
      .catch((err) => { if (!stale) setError(formatError(err)); });
    return () => { stale = true; };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc closes. Space also closes IF the media element does not have
      // focus — Finder's quick look toggle — but when the player is focused,
      // space is play/pause and belongs to it.
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === " " && document.activeElement !== mediaRef.current) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const caption = meta
    ? [
        meta.width && meta.height ? `${meta.width}×${meta.height}` : null,
        meta.duration != null ? fmtDuration(meta.duration) : null,
      ].filter(Boolean).join(" · ")
    : "";

  return createPortal(
    <div className="cp-modal-scrim cp-ql-scrim" onMouseDown={onClose}>
      <div className="cp-ql" role="dialog" aria-label={`Preview of ${name}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="cp-ql-head">
          <span className="cp-ql-name" title={path}>{name}</span>
          {caption && <span className="cp-ql-meta">{caption}</span>}
          <button className="cp-ql-close" aria-label="Close preview" onClick={onClose}>✕</button>
        </div>

        {error != null ? (
          <div className="cp-ql-fallback">
            <p>This file needs the full player.</p>
            <button className="btn btn-primary" onClick={() => { onOpenInClip(); onClose(); }}>
              Open in Clip
            </button>
          </div>
        ) : meta == null ? (
          <div className="cp-ql-fallback"><p>Opening…</p></div>
        ) : meta.has_video ? (
          <video
            ref={(el) => { mediaRef.current = el; }}
            className="cp-ql-video"
            src={assetUrl(path)}
            controls
            autoPlay
            playsInline
            // WKWebView refusing the codec is not an error event you can read
            // anything useful from; degrade to the honest fallback.
            onError={() => setError("Format not natively playable")}
          />
        ) : (
          <audio
            ref={(el) => { mediaRef.current = el; }}
            className="cp-ql-audio"
            src={assetUrl(path)}
            controls
            autoPlay
            onError={() => setError("Format not natively playable")}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
