/**
 * Mounts the REAL src/components/MSEStreamPlayer.tsx against a mini
 * stream-proxy that serves the same two routes the Rust one does:
 * `/v1/<b64>` raw with Range, and `/fmp4/v1/<b64>?start=N` remuxed by the
 * bundled ffmpeg.
 *
 * Harness only. Nothing here is app code. It exists because "seeking and
 * scrubbing is broken" was reported twice and answered once from reasoning
 * rather than from a running player, which was wrong. This makes the claim
 * checkable: it drives real seeks through the real component and reports what
 * the app itself says happened.
 */
import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { MSEStreamPlayer } from "../src/components/MSEStreamPlayer";
import type { PlayerHandle } from "../src/components/player-handle";

type Line = { tag: string; msg: string };
const diag: Line[] = [];
const ref = createRef<PlayerHandle>();

const q = new URLSearchParams(location.search);
const B64 = btoa("http://127.0.0.1:5199/" + (q.get("f") ?? "sample-600s.mp4")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const PATH = `http://127.0.0.1:5199/t/harness/v1/${B64}`;

declare global { interface Window { __probe: Record<string, unknown> } }

window.__probe = {
  diag,
  ready: false,
  seekTo: (s: number) => ref.current?.seekTo(s),
  currentTime: () => ref.current?.getCurrentTime() ?? -1,
  /** Is the scrub overlay actually covering the video right now? */
  overlayShown: () => !!document.querySelector(".cp-scrub-preview")?.classList.contains("show"),
  /** Mean luminance of the overlay canvas — 0 when it is painting its own
   *  near-black background, well above 0 once a real frame lands. */
  overlayLuma: () => {
    const c = document.querySelector(".cp-scrub-preview") as HTMLCanvasElement | null;
    if (!c || !c.width) return -1;
    const d = c.getContext("2d")?.getImageData(0, 0, c.width, c.height).data;
    if (!d) return -1;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  },
  /** Mean luminance of the <video> itself, so "the picture moved" is checkable. */
  videoLuma: () => {
    const v = document.querySelector(".cp-local-video") as HTMLVideoElement | null;
    if (!v || !v.videoWidth) return -1;
    const c = document.createElement("canvas");
    c.width = 64; c.height = 36;
    const ctx = c.getContext("2d");
    if (!ctx) return -1;
    ctx.drawImage(v, 0, 0, 64, 36);
    const d = ctx.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return sum / (d.length / 4);
  },
};

createRoot(document.getElementById("root")!).render(
  <MSEStreamPlayer
    ref={ref}
    path={PATH}
    hasVideo
    initialVolume={0}
    knownDuration={Number(q.get("dur") ?? "600")}
    videoCodec={q.get("vc") ?? "avc1.64001E"}
    audioCodec="mp4a.40.2"
    onReady={() => { window.__probe.ready = true; }}
    onDiag={(tag, msg) => { diag.push({ tag, msg }); }}
    onError={(e) => { diag.push({ tag: "error", msg: String(e) }); }}
  />,
);
