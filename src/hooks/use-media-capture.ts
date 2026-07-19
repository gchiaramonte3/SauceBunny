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

function commitChoice(c: DeviceChoice) {
  currentChoice = c;
  saveDeviceChoice(c);
  for (const l of [...choiceListeners]) l(c);
}

function setActive(s: MediaStream | null) {
  if (activeStream && activeStream !== s) stopStream(activeStream);
  activeStream = s;
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
  const [permission, setPermission] = useState<AvPermission>("unknown");
  const [devices, setDevices] = useState<AvDevices>({ cameras: [], mics: [], speakers: [] });
  const [choice, setChoiceState] = useState<DeviceChoice>(currentChoice);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const l = (s: MediaStream | null) => setStream(s);
    listeners.add(l);
    choiceListeners.add(setChoiceState);
    // Late-mount sync: another instance may have changed either while this
    // component wasn't mounted.
    setStream(activeStream);
    setChoiceState(currentChoice);
    void queryAvPermission().then(setPermission);
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
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
    };
  }, []);

  const refreshDevices = useCallback(async () => {
    try { setDevices(await enumerateAv()); } catch { /* seam unavailable */ }
  }, []);

  /** Open (or reopen) the capture for a choice. Persists the choice; maps
   *  a user decline to the denied UI instead of throwing. */
  const acquire = useCallback(async (c: DeviceChoice): Promise<boolean> => {
    setError(null);
    commitChoice(c);
    const gen = ++captureGen;
    try {
      const s = await openCapture(c);
      if (gen !== captureGen) {
        // Released (or superseded) while getUserMedia was pending: this
        // stream must never go live, or the camera light outlives the leave.
        stopStream(s);
        return false;
      }
      setActive(s);
      setPermission("granted");
      await refreshDevices(); // labels populate post-grant
      return true;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPermission("denied");
      } else {
        // Every other failure (no device, unsupported webview, hardware in
        // use) surfaces with its real name - a wrong "blocked" message sent
        // people to System Settings for nothing.
        setError(`${name || "CaptureError"}: ${err instanceof Error ? err.message : String(err)}`);
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
   *  a LIVE stream). One exception: a stream acquired with the camera OFF
   *  has no video track at all (openCapture never requested one), so
   *  camera-ON must re-acquire to actually open the camera — flipping
   *  enabled on zero tracks would silently do nothing. */
  const setEnabled = useCallback((kind: "audio" | "video", enabled: boolean) => {
    commitChoice({ ...currentChoice, ...(kind === "audio" ? { micMuted: !enabled } : { cameraOff: !enabled }) });
    const s = activeStream;
    if (!s) return;
    const tracks = kind === "audio" ? s.getAudioTracks() : s.getVideoTracks();
    if (kind === "video" && enabled && tracks.length === 0) {
      void acquire(currentChoice);
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
