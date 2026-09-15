import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ObsDisplayChoice } from "../bindings/ObsDisplayChoice";
import type { CaptureDisplayThumbnail } from "../bindings/CaptureDisplayThumbnail";
import { formatError } from "../lib/error-format";
import { requestCaptureThumbnail } from "../lib/capture-thumbnail-queue";
import type { WindowThumbnail } from "./use-capture-window-thumbnails";

/** The observed desktop geometry is part of the selection, not just its ID. */
export const captureDisplayKey = (display: Pick<ObsDisplayChoice, "displayUuid" | "displayId" | "geometry">) => {
  const { geometry } = display;
  return JSON.stringify([display.displayUuid, display.displayId, geometry.x, geometry.y,
    geometry.width, geometry.height, geometry.pixelWidth, geometry.pixelHeight]);
};

/** Separate, bounded, memory-only snapshots; no continuous capture or audio. */
export function useCaptureDisplayThumbnails(displays: ObsDisplayChoice[], enabled: boolean, refresh: number) {
  const [thumbnails, setThumbnails] = useState<Record<string, WindowThumbnail>>({});
  useEffect(() => {
    const controller = new AbortController();
    let next = 0;
    const targets = enabled ? displays : [];
    if (enabled) setThumbnails(previous => Object.fromEntries(targets.map(display => [captureDisplayKey(display), {
      phase: "loading" as const, image: previous[captureDisplayKey(display)]?.image ?? null, error: null,
    }])));
    const worker = async () => {
      while (!controller.signal.aborted && next < targets.length) {
        const display = targets[next++], key = captureDisplayKey(display);
        let result: WindowThumbnail;
        try {
          const data = await requestCaptureThumbnail(controller.signal, () => invoke<CaptureDisplayThumbnail>("capture_display_thumbnail", { selection: {
            kind: "display", displayUuid: display.displayUuid, displayId: display.displayId,
            geometry: { ...display.geometry }, crop: { x: 0, y: 0, width: 1, height: 1 }, audio: false,
          } }));
          if (captureDisplayKey(data) !== key || !data.thumb || data.thumb.length > 180_000
            || !data.thumb.startsWith("/9j/") || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.thumb)) {
            throw new Error("The display changed. Refresh its preview.");
          }
          result = { phase: "ready", image: `data:image/jpeg;base64,${data.thumb}`, error: null };
        } catch (cause) { result = { phase: "error", image: null, error: formatError(cause) }; }
        if (!controller.signal.aborted) setThumbnails(previous => ({ ...previous, [key]: result }));
      }
    };
    void worker(); void worker();
    return () => { controller.abort(); };
  }, [displays, enabled, refresh]);
  return enabled ? thumbnails : {};
}
