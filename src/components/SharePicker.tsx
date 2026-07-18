import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DisplayInfo } from "../bindings/DisplayInfo";

/**
 * Display picker popover for the room control bar's Share Screen button
 * (sibling component; the bar stays under the size rule). Owns the TCC
 * dance: preflight, the one OS prompt, and the denied path's System
 * Settings deep link - including macOS's restart-after-grant quirk, stated
 * honestly in one line.
 */
export function SharePicker({ onPick, onClose }: {
  onPick: (displayIndex: number) => void;
  onClose: () => void;
}) {
  const [access, setAccess] = useState<"checking" | "granted" | "denied">("checking");
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);

  useEffect(() => {
    void (async () => {
      let state = await invoke<string>("screen_capture_access", { request: false }).catch(() => "denied");
      if (state === "undetermined") {
        // One OS prompt, definitive answer.
        state = await invoke<string>("screen_capture_access", { request: true }).catch(() => "denied");
      }
      if (state === "granted") {
        setAccess("granted");
        setDisplays(await invoke<DisplayInfo[]>("list_displays").catch(() => []));
      } else {
        setAccess("denied");
      }
    })();
  }, []);

  return (
    <div className="cp-share-pick" role="dialog" aria-label="Share a display">
      {access === "checking" && <p className="cp-share-pick-line">Checking screen access…</p>}
      {access === "denied" && (
        <>
          <p className="cp-share-pick-line">Screen recording is blocked for Sauce Bunny.</p>
          <p className="cp-share-pick-line dim">After allowing it, quit and reopen the app. macOS requires it.</p>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => { void invoke("open_privacy_pane", { anchor: "Privacy_ScreenCapture" }).catch(() => {}); }}
          >
            Open System Settings
          </button>
        </>
      )}
      {access === "granted" && displays.map((d) => (
        <button
          key={d.id}
          type="button"
          className="cp-share-pick-row"
          onClick={() => { onPick(d.index); onClose(); }}
        >
          <span className="cp-share-pick-name">{d.name}</span>
          <span className="cp-share-pick-res">{d.width}×{d.height}</span>
        </button>
      ))}
      <button type="button" className="btn btn-ghost btn-compact cp-share-pick-cancel" onClick={onClose}>
        Cancel
      </button>
    </div>
  );
}
