import { useCallback, useEffect, useState } from "react";
import {
  type AvDevices, type AvPermission, type DeviceChoice,
  enumerateAv, loadDeviceChoice, openCapture, queryAvPermission,
  saveDeviceChoice, stopStream,
} from "../lib/media-devices";

/**
 * Ownership of THE session capture: exactly one getUserMedia stream per
 * session, held in a module-level singleton so the green room, the room's
 * self tile, and (next build) the RTC mesh all hand around the same
 * MediaStream. Tracks stop on release (leave/end), on a fresh acquire,
 * and on app quit (pagehide) - the camera light must never outlive the
 * session.
 */

let activeStream: MediaStream | null = null;
const listeners = new Set<(s: MediaStream | null) => void>();

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
  const [devices, setDevices] = useState<AvDevices>({ cameras: [], mics: [] });
  const [choice, setChoiceState] = useState<DeviceChoice>(() => loadDeviceChoice());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const l = (s: MediaStream | null) => setStream(s);
    listeners.add(l);
    void queryAvPermission().then(setPermission);
    return () => { listeners.delete(l); };
  }, []);

  const refreshDevices = useCallback(async () => {
    try { setDevices(await enumerateAv()); } catch { /* seam unavailable */ }
  }, []);

  /** Open (or reopen) the capture for a choice. Persists the choice; maps
   *  a user decline to the denied UI instead of throwing. */
  const acquire = useCallback(async (c: DeviceChoice): Promise<boolean> => {
    setError(null);
    saveDeviceChoice(c);
    setChoiceState(c);
    try {
      const s = await openCapture(c);
      setActive(s);
      setPermission("granted");
      await refreshDevices(); // labels populate post-grant
      return true;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPermission("denied");
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      return false;
    }
  }, [refreshDevices]);

  /** Stop the capture and release the hardware (leave/end). */
  const release = useCallback(() => { setActive(null); }, []);

  /** Flip a track's enabled bit without re-prompting (mute / camera-off of
   *  a LIVE stream; a camera turned off before acquire never opens video). */
  const setEnabled = useCallback((kind: "audio" | "video", enabled: boolean) => {
    const c = { ...loadDeviceChoice(), ...(kind === "audio" ? { micMuted: !enabled } : { cameraOff: !enabled }) };
    saveDeviceChoice(c);
    setChoiceState(c);
    const s = activeStream;
    if (!s) return;
    const tracks = kind === "audio" ? s.getAudioTracks() : s.getVideoTracks();
    for (const t of tracks) t.enabled = enabled;
  }, []);

  return { stream, permission, devices, choice, error, acquire, release, refreshDevices, setEnabled };
}
