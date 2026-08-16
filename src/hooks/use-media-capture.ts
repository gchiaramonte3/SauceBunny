import { useCallback, useEffect, useState } from "react";
import {
  type AvDevices, type AvPermission, type DeviceChoice,
  enumerateAv, loadDeviceChoice, openCapture, queryAvPermission,
  saveDeviceChoice, stopStream,
} from "../lib/media-devices";

/**
 * Ownership of THE session capture: exactly one getUserMedia stream per
 * session, held in a module-level singleton so the green room, the room's
 * self tile, and the RTC mesh all hand around the same MediaStream. The
 * DEVICE CHOICE is a singleton too - the room control bar, the in-session
 * device popover, and the Settings pane each mount their own hook instance,
 * and a switch made in one must show in all of them. Tracks stop on release
 * (leave/end), on a fresh acquire, and on app quit (pagehide) - the camera
 * light must never outlive the session.
 */

let activeStream: MediaStream | null = null;
const listeners = new Set<(s: MediaStream | null) => void>();
// Generation guard: release() invalidates any acquire still awaiting
// getUserMedia, so a slow grant can't relight the camera after leave.
let captureGen = 0;

let currentChoice: DeviceChoice = loadDeviceChoice();
const choiceListeners = new Set<(c: DeviceChoice) => void>();

// Capture FAILURES are singletons too, for the same reason the stream is: the
// room control bar, the self tile, and the Settings pane each mount their own
// hook instance, so a failure raised by one used to be invisible to every
// other - a camera that was busy or denied failed in total silence, which is
// the worst possible outcome for something the user is actively debugging.
let currentError: string | null = null;
let currentPermission: AvPermission = "unknown";
const errorListeners = new Set<(e: string | null) => void>();
const permissionListeners = new Set<(p: AvPermission) => void>();

// The capture singleton is not a React thing, so it reaches the pipeline log
// through a sink App.tsx installs at boot. Before this, the camera path
// produced no output of ANY kind - not even a console line - so "my camera
// stopped working" arrived with literally zero evidence attached.
let logSink: ((tag: "info" | "ok" | "warn" | "err", line: string) => void) | null = null;

/** Route capture lifecycle into the pipeline log. Installed once, at boot. */
export function setCaptureLogSink(
  fn: ((tag: "info" | "ok" | "warn" | "err", line: string) => void) | null,
): void {
  logSink = fn;
}

function clog(tag: "info" | "ok" | "warn" | "err", line: string) {
  logSink?.(tag, line);
}

/** What a stream actually carries, for the log. */
function describe(s: MediaStream | null): string {
  if (!s) return "none";
  const t = s.getTracks();
  if (t.length === 0) return "empty";
  return t.map((x) => `${x.kind}:${x.label || "unlabelled"}(${x.readyState})`).join(" ");
}

function publishError(e: string | null) {
  currentError = e;
  for (const l of [...errorListeners]) l(e);
}

function publishPermission(p: AvPermission) {
  currentPermission = p;
  for (const l of [...permissionListeners]) l(p);
}

/** Subscribe to capture failures raised by ANY surface (room, settings, tile).
 *  App.tsx routes these to a notification so a dead camera says why. */
export function subscribeCaptureError(cb: (e: string | null) => void): () => void {
  errorListeners.add(cb);
  return () => { errorListeners.delete(cb); };
}

function commitChoice(c: DeviceChoice) {
  currentChoice = c;
  saveDeviceChoice(c);
  for (const l of [...choiceListeners]) l(c);
}

function setActive(s: MediaStream | null) {
  if (activeStream && activeStream !== s) stopStream(activeStream);
  activeStream = s;
  clog(s ? "ok" : "info", s ? `Capture live: ${describe(s)}` : "Capture released.");
  // macOS ENDS a track when another app takes the device, on wake from sleep,
  // or when a USB camera is unplugged. Nothing listened for it, so the UI kept
  // showing a live camera that was already dead and peers saw a frozen frame.
  for (const t of s?.getTracks() ?? []) {
    t.addEventListener("ended", () => {
      clog("warn", `${t.kind} track ended (device taken by another app, unplugged, or slept).`);
      publishError(
        `Your ${t.kind === "video" ? "camera" : "microphone"} stopped. `
        + "Another app may have taken it. Turn it off and on again to reconnect.",
      );
    }, { once: true });
  }
  for (const l of [...listeners]) l(s);
}

/** The live capture, for non-React consumers (the mesh attaches senders). */
export function getSessionCapture(): MediaStream | null {
  return activeStream;
}

/** Subscribe to capture swaps (device switch, release). The mesh uses this
 *  to replaceTrack on every peer without a React dependency. */
export function subscribeSessionCapture(cb: (s: MediaStream | null) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// App quit: WKWebView fires pagehide on window close; stop the hardware.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => stopStream(activeStream));
}

export function useMediaCapture() {
  const [stream, setStream] = useState<MediaStream | null>(activeStream);
  const [permission, setPermissionState] = useState<AvPermission>(currentPermission);
  const [devices, setDevices] = useState<AvDevices>({ cameras: [], mics: [], speakers: [] });
  const [choice, setChoiceState] = useState<DeviceChoice>(currentChoice);
  const [error, setErrorState] = useState<string | null>(currentError);

  useEffect(() => {
    const l = (s: MediaStream | null) => setStream(s);
    listeners.add(l);
    choiceListeners.add(setChoiceState);
    errorListeners.add(setErrorState);
    permissionListeners.add(setPermissionState);
    // Late-mount sync: another instance may have changed any of these while
    // this component wasn't mounted.
    setStream(activeStream);
    setChoiceState(currentChoice);
    setErrorState(currentError);
    void queryAvPermission().then(publishPermission);
    // Populate the device lists immediately, and track hot-plug: powering on
    // an external camera (or a Continuity iPhone appearing) fires the
    // browser's `devicechange` — re-enumerate so the pickers show it without
    // the user having to reopen anything. Labels stay generic until a
    // getUserMedia grant; the pickers already fall back to "Camera N".
    const onDeviceChange = () => {
      void enumerateAv().then(setDevices).catch(() => { /* seam unavailable */ });
    };
    onDeviceChange();
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      listeners.delete(l);
      choiceListeners.delete(setChoiceState);
      errorListeners.delete(setErrorState);
      permissionListeners.delete(setPermissionState);
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, []);

  const refreshDevices = useCallback(async () => {
    try { setDevices(await enumerateAv()); } catch { /* seam unavailable */ }
  }, []);

  /** Open (or reopen) the capture for a choice. Persists the choice; maps
   *  a user decline to the denied UI instead of throwing. */
  const acquire = useCallback(async (c: DeviceChoice): Promise<boolean> => {
    publishError(null);
    commitChoice(c);
    const gen = ++captureGen;
    clog("info",
      `Opening capture: camera=${c.cameraOff ? "off" : (c.cameraId ?? "default")} `
      + `mic=${c.micMuted ? "muted" : (c.micId ?? "default")}`);
    try {
      const s = await openCapture(c);
      if (gen !== captureGen) {
        // Released (or superseded) while getUserMedia was pending: this
        // stream must never go live, or the camera light outlives the leave.
        stopStream(s);
        return false;
      }
      setActive(s);
      publishPermission("granted");
      await refreshDevices(); // labels populate post-grant
      return true;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        publishPermission("denied");
        clog("err", `Capture denied by macOS (${name}).`);
        publishError("Camera or microphone access is blocked. Open Settings > Camera & Mic to allow it.");
      } else {
        // Every other failure (no device, unsupported webview, hardware in
        // use) surfaces with its real name - a wrong "blocked" message sent
        // people to System Settings for nothing.
        const detail = `${name || "CaptureError"}: ${err instanceof Error ? err.message : String(err)}`;
        clog("err", `Capture failed. ${detail}`);
        publishError(detail);
      }
      return false;
    }
  }, [refreshDevices]);

  /** Stop the capture and release the hardware (leave/end). */
  const release = useCallback(() => {
    captureGen++;
    setActive(null);
  }, []);

  /** Flip a track's enabled bit without re-prompting (mute / camera-off of
   *  a LIVE stream). Turning a device ON always has to be able to OPEN one:
   *  a stream acquired with the camera off has no video track at all, and
   *  with no capture at all ("join without devices", or the hardware was
   *  released) there is nothing to flip. Both cases re-acquire — returning
   *  early left the button dead while the toolbar claimed the camera was on,
   *  with no way back short of leaving the session. */
  const setEnabled = useCallback((kind: "audio" | "video", enabled: boolean) => {
    const prev = currentChoice;
    commitChoice({ ...prev, ...(kind === "audio" ? { micMuted: !enabled } : { cameraOff: !enabled }) });
    const s = activeStream;
    const tracks = s ? (kind === "audio" ? s.getAudioTracks() : s.getVideoTracks()) : [];
    clog("info",
      `${kind} ${enabled ? "on" : "off"} (${tracks.length} track${tracks.length === 1 ? "" : "s"}`
      + `${s ? "" : ", no capture"}) -> ${enabled && tracks.length === 0 ? "reopening" : "toggling"}`);
    if (enabled && tracks.length === 0) {
      // Roll the choice back if the device never opened, so the control bar
      // can't advertise a camera that isn't running. acquire() has already
      // surfaced the reason via `permission` or `error`.
      void acquire(currentChoice).then((ok) => { if (!ok) commitChoice(prev); });
      return;
    }
    for (const t of tracks) t.enabled = enabled;
  }, [acquire]);

  /** Persist a choice change that needs no reopen (e.g. the speaker output).
   *  Every mounted instance sees it immediately. */
  const updateChoice = useCallback((patch: Partial<DeviceChoice>) => {
    commitChoice({ ...currentChoice, ...patch });
  }, []);

  return { stream, permission, devices, choice, error, acquire, release, refreshDevices, setEnabled, updateChoice };
}
