import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ObsWindow } from "../bindings/ObsWindow";
import type { CaptureWindowThumbnail } from "../bindings/CaptureWindowThumbnail";
import { formatError } from "../lib/error-format";
import { requestCaptureThumbnail } from "../lib/capture-thumbnail-queue";

export type WindowThumbnail = { phase: "loading" | "ready" | "error"; image: string | null; error: string | null };
export const captureWindowKey = (window: Pick<ObsWindow, "app" | "pid" | "id">) =>
  JSON.stringify([window.app, window.pid, window.id]);

/** Explicit, memory-only picker snapshots. Metadata discovery remains separate.
 * Two bounded native requests at a time; closing/changing the page stops the
 * queue, and late responses can never populate a replacement application's UI. */
export function useCaptureWindowThumbnails(windows: ObsWindow[], enabled: boolean, refresh: number) {
  const [thumbnails, setThumbnails] = useState<Record<string, WindowThumbnail>>({});
  useEffect(() => {
    const controller = new AbortController();
    let next = 0;
    const targets = enabled ? windows : [];
    if (enabled) setThumbnails(previous => Object.fromEntries(targets.map(window => [captureWindowKey(window), {
      phase: "loading" as const, image: previous[captureWindowKey(window)]?.image ?? null, error: null,
    }])));
    const worker = async () => {
      while (!controller.signal.aborted && next < targets.length) {
        const window = targets[next++];
        const key = captureWindowKey(window);
        let result: WindowThumbnail;
        try {
          const data = await requestCaptureThumbnail(controller.signal, () => invoke<CaptureWindowThumbnail>("capture_window_thumbnail", {
            application: window.app, process: window.pid, window: window.id,
          }));
          if (data.application !== window.app || data.process !== window.pid || data.window !== window.id
            || !data.thumb || data.thumb.length > 180_000 || !data.thumb.startsWith("/9j/") || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.thumb)) {
            throw new Error("The window changed. Refresh its preview.");
          }
          result = { phase: "ready", image: `data:image/jpeg;base64,${data.thumb}`, error: null };
        } catch (cause) {
          result = { phase: "error", image: null, error: formatError(cause) };
        }
        if (!controller.signal.aborted) setThumbnails(previous => ({ ...previous, [key]: result }));
      }
    };
    void worker(); void worker();
    return () => { controller.abort(); };
  }, [windows, enabled, refresh]);
  return enabled ? thumbnails : {};
}
