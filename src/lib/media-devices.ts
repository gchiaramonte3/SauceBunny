import { loadJson, saveJson } from "./storage";

/**
 * THE device seam. This module is the ONLY place in the app that touches
 * `navigator.mediaDevices` (contract stated in the review-workspace pack:
 * if real hardware misbehaves, the fix is contained here). Plain typed
 * functions; ownership/lifecycle lives in hooks/use-media-capture.ts.
 */

export type DeviceChoice = {
  cameraId: string | null;
  micId: string | null;
  cameraOff: boolean;
  micMuted: boolean;
  /** Voice processing = Apple's whole voice pipeline via the ONE constraint
   *  WebKit implements (echoCancellation). noiseSuppression/autoGainControl
   *  are silently ignored by WebKit, so no separate toggles exist. */
  echoCancel: boolean;
  /** Session-voice output device (setSinkId, WebKit 18.4+ only). */
  speakerId: string | null;
};

export const DEVICE_CHOICE_KEY = "saucebunny.mediaDevices";
/** Fired after the speaker OUTPUT choice changes so live audio elements
 *  re-route. (Named apart from transcript/helpers' SPEAKERS_CHANGED_EVENT,
 *  which is diarization speakers - same word, unrelated event.) */
export const SPEAKER_OUTPUT_CHANGED_EVENT = "saucebunny:speaker-output-changed";

const CHOICE_DEFAULTS: DeviceChoice = {
  cameraId: null,
  micId: null,
  cameraOff: false,
  micMuted: false,
  echoCancel: true,
  speakerId: null,
};

export function loadDeviceChoice(): DeviceChoice {
  // Spread-merge: blobs persisted before a field existed read as defaults.
  return { ...CHOICE_DEFAULTS, ...loadJson<Partial<DeviceChoice>>(DEVICE_CHOICE_KEY, {}) };
}

export function saveDeviceChoice(c: DeviceChoice): void {
  saveJson(DEVICE_CHOICE_KEY, c);
}

// ── Session volume (r122) ───────────────────────────────────────────────
// INPUT: a GainNode between the mic and everything downstream (mesh, mic
// check, level meter), built inside openCapture so every consumer hears the
// same thing. OUTPUT: element.volume on the mesh's hidden voice elements.
// Both persist and apply live - no re-acquire, no renegotiation.

export const SESSION_VOLUME_KEY = "saucebunny.sessionVolume";
/** Fired after the session OUTPUT volume changes so live voice elements
 *  re-apply it (mirror of SPEAKER_OUTPUT_CHANGED_EVENT). */
export const SESSION_VOLUME_CHANGED_EVENT = "saucebunny:session-volume-changed";

type SessionVolume = { input: number; output: number };
const VOLUME_DEFAULTS: SessionVolume = { input: 1, output: 1 };

export function loadSessionVolume(): SessionVolume {
  const v = { ...VOLUME_DEFAULTS, ...loadJson<Partial<SessionVolume>>(SESSION_VOLUME_KEY, {}) };
  return {
    input: Math.min(2, Math.max(0, v.input)),
    output: Math.min(1, Math.max(0, v.output)),
  };
}

/** Live mic-gain handle for the CURRENT capture (null between captures). */
let inputGainNode: GainNode | null = null;

/** Set input gain (0..2, 1 = unity). Applies to the live capture instantly
 *  and persists for the next one. */
export function setSessionInputVolume(v: number): void {
  const input = Math.min(2, Math.max(0, v));
  saveJson(SESSION_VOLUME_KEY, { ...loadSessionVolume(), input });
  if (inputGainNode) inputGainNode.gain.value = input;
}

/** Set output volume (0..1). Persists and pings live voice elements. */
export function setSessionOutputVolume(v: number): void {
  const output = Math.min(1, Math.max(0, v));
  saveJson(SESSION_VOLUME_KEY, { ...loadSessionVolume(), output });
  try { window.dispatchEvent(new Event(SESSION_VOLUME_CHANGED_EVENT)); } catch { /* non-DOM */ }
}

// The processed session stream carries a WebAudio destination track, not
// the real mic - stopping it would leave the hardware (and the mic light)
// running. stopStream() consults this registry to stop the raw source too.
const RAW_SOURCE = new WeakMap<MediaStream, { raw: MediaStream; ctx: AudioContext }>();

export type AvPermission = "unknown" | "granted" | "denied";
/** Raw macOS TCC state, per device (mirrors AVAuthorizationStatus). */
export type AvAuthState = "authorized" | "denied" | "notDetermined" | "restricted";

/** THE camera+mic+screen permission, from macOS via the Rust command -
 *  authoritative, unlike WKWebView's Permissions API (which is inconsistent
 *  for capture). Returns the raw per-device state so the UI can tell
 *  "granted but relaunch needed" from "denied" from "never asked".
 *  `screen` only ever reports authorized | notDetermined: CoreGraphics can't
 *  see "denied" without prompting, so style non-authorized as neutral. */
export async function nativeAvStatus(): Promise<{ camera: AvAuthState; microphone: AvAuthState; screen: AvAuthState } | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const s = await invoke<{ camera: string; microphone: string; screen?: string }>("av_permission_status");
    const norm = (v: string): AvAuthState =>
      v === "authorized" || v === "denied" || v === "restricted" ? v : "notDetermined";
    // `screen` tolerates a stale backend (missing field → notDetermined);
    // the build-id banner already flags the mismatch loudly.
    return { camera: norm(s.camera), microphone: norm(s.microphone), screen: norm(s.screen ?? "") };
  } catch {
    return null; // non-Tauri (e2e/vitest) or old backend
  }
}

/** Best-effort permission probe. Prefers the native TCC check; falls back to
 *  WKWebView's inconsistent Permissions API (which collapses to "unknown",
 *  so the UI shows the Enable button and lets getUserMedia produce the
 *  real prompt). */
export async function queryAvPermission(): Promise<AvPermission> {
  const native = await nativeAvStatus();
  if (native) {
    // Either device denied -> denied face; both authorized -> granted;
    // anything still pending -> unknown (the Enable button prompts).
    if (native.camera === "denied" || native.camera === "restricted"
      || native.microphone === "denied" || native.microphone === "restricted") return "denied";
    if (native.camera === "authorized" && native.microphone === "authorized") return "granted";
    return "unknown";
  }
  try {
    const perms = navigator.permissions;
    if (!perms?.query) return "unknown";
    const [cam, mic] = await Promise.all([
      perms.query({ name: "camera" as PermissionName }),
      perms.query({ name: "microphone" as PermissionName }),
    ]);
    if (cam.state === "denied" || mic.state === "denied") return "denied";
    if (cam.state === "granted" && mic.state === "granted") return "granted";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export type AvDevices = { cameras: MediaDeviceInfo[]; mics: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] };

/** True when this WebKit can route audio to a chosen output (18.4+). */
export function canPickSpeakers(): boolean {
  return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
}

/** Camera + mic + speaker lists. Pre-grant, labels are empty per spec —
 *  callers render "Default" until a stream exists and labels populate.
 *  (Speakers enumerate only once mic access is granted.) */
export async function enumerateAv(): Promise<AvDevices> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    cameras: all.filter((d) => d.kind === "videoinput"),
    mics: all.filter((d) => d.kind === "audioinput"),
    speakers: canPickSpeakers() ? all.filter((d) => d.kind === "audiooutput") : [],
  };
}

/** Open the session capture for a device choice. Camera-off still requests
 *  audio (presence degrades to avatar, voice continues); both-off returns
 *  null without prompting. Throws getUserMedia errors through — the caller
 *  maps NotAllowedError to the denied UI. */
export async function openCapture(c: DeviceChoice): Promise<MediaStream | null> {
  const wantVideo = !c.cameraOff;
  // Audio is ALWAYS requested - mic-mute is track.enabled, not a missing track.
  if (!navigator.mediaDevices?.getUserMedia) {
    // WKWebView without capture support (or a non-secure context): say so
    // instead of masquerading as a permissions denial.
    throw new DOMException("Capture is unavailable in this webview", "NotSupportedError");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: wantVideo
      ? (c.cameraId ? { deviceId: { ideal: c.cameraId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } })
      : false,
    audio: {
      ...(c.micId ? { deviceId: { ideal: c.micId } } : {}),
      // Plain (non-exact) constraint: honored where implemented, ignored
      // elsewhere - never OverconstrainedError.
      echoCancellation: c.echoCancel,
    },
  });
  const mic = stream.getAudioTracks()[0];
  if (!mic) return stream;

  // Input-volume graph: mic → GainNode → destination track. Everything
  // downstream (mesh, mic check, level meter) consumes the gained track, so
  // the slider audibly changes what the room hears AND what the meter shows.
  // Any WebAudio failure falls back to the raw stream - voice must never
  // break over a volume feature.
  try {
    const ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume(); // gestureless acquire
    const src = ctx.createMediaStreamSource(new MediaStream([mic]));
    const gain = ctx.createGain();
    gain.gain.value = loadSessionVolume().input;
    const dest = ctx.createMediaStreamDestination();
    src.connect(gain);
    gain.connect(dest);
    inputGainNode = gain;
    const gained = dest.stream.getAudioTracks()[0];
    gained.enabled = !c.micMuted;
    const out = new MediaStream([...stream.getVideoTracks(), gained]);
    RAW_SOURCE.set(out, { raw: stream, ctx });
    return out;
  } catch {
    mic.enabled = !c.micMuted;
    return stream;
  }
}

export function stopStream(s: MediaStream | null): void {
  if (!s) return;
  for (const t of s.getTracks()) {
    try { t.stop(); } catch { /* already stopped */ }
  }
  // Processed capture: also stop the real mic + close its audio graph, or
  // the hardware (and the orange mic dot) outlives the session.
  const src = RAW_SOURCE.get(s);
  if (src) {
    RAW_SOURCE.delete(s);
    if (inputGainNode && inputGainNode.context === src.ctx) inputGainNode = null;
    for (const t of src.raw.getTracks()) {
      try { t.stop(); } catch { /* already stopped */ }
    }
    void src.ctx.close();
  }
}
