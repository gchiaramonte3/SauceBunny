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
/** Fired after the speaker choice changes so live audio elements re-route. */
export const SPEAKERS_CHANGED_EVENT = "saucebunny:speakers-changed-out";

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

export type AvPermission = "unknown" | "granted" | "denied";

/** Best-effort permission probe. WKWebView's Permissions API coverage for
 *  camera/microphone is inconsistent, so anything that throws or reports
 *  "prompt" collapses to "unknown" (the UI then shows the one Enable
 *  button and lets getUserMedia produce the real prompt). */
export async function queryAvPermission(): Promise<AvPermission> {
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
  const wantAudio = true; // mic-mute is track.enabled, not a missing track
  if (!wantVideo && !wantAudio) return null;
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
  if (mic) mic.enabled = !c.micMuted;
  return stream;
}

export function stopStream(s: MediaStream | null): void {
  if (!s) return;
  for (const t of s.getTracks()) {
    try { t.stop(); } catch { /* already stopped */ }
  }
}
