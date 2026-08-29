import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconCamera, IconCheck, IconFolder, IconMic, IconScreenShare } from "./Icons";
import { nativeAvStatus, type AvAuthState } from "../lib/media-devices";
import { useModalFocus } from "../hooks/use-modal-focus";

/**
 * The permissions step of first run.
 *
 * macOS prompts for camera, microphone and screen recording ONCE, at the
 * moment the app first reaches for each. Left to happen organically, that
 * moment is always the worst one: half way into joining a live session,
 * with a peer waiting. And the prompt only ever appears once, so a user who
 * dismissed it while distracted has no way back except System Settings, with
 * nothing in the app telling them that is where they now have to go.
 *
 * So it is asked here instead, up front, where a "no" costs nothing.
 *
 * Two things this screen must not do:
 *
 *  - **It must not imply any of this is required.** Importing, transcribing,
 *    diarizing, clipping and reviewing local files need NONE of these. Every
 *    one is for a live session, plus the optional cookie read. Skip is a
 *    first-class answer and is worded as one.
 *  - **It must not fake the prompt.** "Allow" performs the real request, so
 *    macOS's own dialog appears. Once a permission is DENIED no prompt can
 *    ever be shown again, so the button becomes "Open Settings" - the only
 *    honest action left.
 *
 * State is re-read on window focus because granting happens in System
 * Settings, in another process: without that the row would still say "Not
 * asked yet" after the user had just allowed it.
 */

type RowKey = "microphone" | "camera" | "screen" | "disk";

export function PermissionsOnboarding({ onDone }: { onDone: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialogRef);

  const [tcc, setTcc] = useState<{ camera: AvAuthState; microphone: AvAuthState; screen: AvAuthState } | null>(null);
  const [disk, setDisk] = useState<boolean | null>(null);
  // `screen_capture_access` RETURNS the answer ("granted" / "denied" /
  // "undetermined") and this screen used to throw it away, re-reading state
  // from av_permission_status instead. That reads CGPreflightScreenCaptureAccess,
  // which commonly keeps saying no until the app is relaunched - so a user who
  // had just granted screen recording watched the row sit on "Allow" forever
  // and had no way to tell it had worked.
  const [screenGrant, setScreenGrant] = useState<AvAuthState | null>(null);
  const [busy, setBusy] = useState<RowKey | null>(null);

  const refresh = useCallback(() => {
    void nativeAvStatus().then(setTcc);
    void invoke<boolean>("full_disk_access_status").then(setDisk).catch(() => setDisk(null));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // Granting happens in another process. Without this the row keeps claiming
  // "Not asked yet" after the user has just allowed it.
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onDone(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDone]);

  /** Ask macOS for real. Releasing the tracks immediately keeps the grant
   *  without leaving the camera light on behind a first-run screen. */
  const askCapture = async (kind: "camera" | "microphone") => {
    setBusy(kind);
    try {
      const s = await navigator.mediaDevices.getUserMedia(
        kind === "camera" ? { video: true } : { audio: true },
      );
      for (const t of s.getTracks()) t.stop();
    } catch { /* a refusal is an answer; refresh reads the real state */ }
    setBusy(null);
    refresh();
  };

  const askScreen = async () => {
    setBusy("screen");
    try {
      const r = await invoke<string>("screen_capture_access", { request: true });
      setScreenGrant(r === "granted" ? "authorized" : r === "denied" ? "denied" : null);
    } catch { /* ditto */ }
    setBusy(null);
    refresh();
  };

  const openPane = (anchor: string) => {
    void invoke("open_privacy_pane", { anchor }).catch(() => { /* best effort */ });
  };

  const rows = [
    {
      key: "microphone" as const, name: "Microphone", icon: <IconMic size={14} />,
      why: "Dictate review comments, and be heard in a live session.",
      state: tcc?.microphone, ask: () => askCapture("microphone"), anchor: "Privacy_Microphone",
    },
    {
      key: "camera" as const, name: "Camera", icon: <IconCamera size={14} />,
      why: "Show your face in a live session.",
      state: tcc?.camera, ask: () => askCapture("camera"), anchor: "Privacy_Camera",
    },
    {
      key: "screen" as const, name: "Screen Recording", icon: <IconScreenShare size={14} />,
      why: "Share a screen in a live session.",
      // Prefer what the request itself reported; the preflight behind
      // tcc.screen lags a fresh grant until relaunch.
      state: screenGrant ?? tcc?.screen, ask: askScreen, anchor: "Privacy_ScreenCapture",
      note: "macOS may not apply this until Sauce Bunny is restarted.",
    },
  ];

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="cp-perms"
      role="dialog"
      aria-modal="true"
      aria-label="Permissions"
    >
      <div className="cp-perms-stage">
        <h1 className="cp-perms-title">A few permissions</h1>
        <p className="cp-perms-sub">
          Every one of these is for watching together with someone. Importing,
          transcribing and editing on your own need none of them, so skipping
          is a perfectly good answer.
        </p>

        <ul className="cp-perms-rows">
          {rows.map((r) => {
            const granted = r.state === "authorized";
            // Screen recording cannot report "denied": CGPreflight cannot tell
            // it apart from never-asked without prompting. So it stays neutral
            // and keeps offering to ask, which is the truthful affordance.
            const blocked = r.state === "denied" || r.state === "restricted";
            return (
              <li key={r.key} className={"cp-perms-row" + (granted ? " granted" : "")}>
                <span className="cp-perms-row-icon">{r.icon}</span>
                <span className="cp-perms-row-text">
                  <strong>{r.name}</strong>
                  <span>{r.why}{granted && r.note ? ` ${r.note}` : ""}</span>
                </span>
                {granted ? (
                  <span className="cp-perms-ok"><IconCheck size={13} /> Allowed</span>
                ) : blocked ? (
                  <button type="button" className="btn btn-ghost btn-compact"
                    onClick={() => openPane(r.anchor)}>
                    Open Settings
                  </button>
                ) : (
                  <button type="button" className="btn btn-ghost btn-compact"
                    disabled={busy === r.key} onClick={() => void r.ask()}>
                    {busy === r.key ? "Asking…" : "Allow"}
                  </button>
                )}
              </li>
            );
          })}

          {/* Full Disk Access has no prompt of any kind: it is granted only by
              hand in System Settings, so there is nothing to "Allow" here. It
              also sits apart from the three above because it is not about live
              sessions at all. */}
          <li className={"cp-perms-row" + (disk ? " granted" : "")}>
            <span className="cp-perms-row-icon"><IconFolder size={14} /></span>
            <span className="cp-perms-row-text">
              <strong>Full Disk Access <em className="cp-perms-opt">optional</em></strong>
              <span>Lets downloads borrow your browser sign-in for videos that need it.</span>
            </span>
            {disk ? (
              <span className="cp-perms-ok"><IconCheck size={13} /> Allowed</span>
            ) : (
              <button type="button" className="btn btn-ghost btn-compact"
                onClick={() => { void invoke("open_full_disk_access").catch(() => {}); }}>
                Open Settings
              </button>
            )}
          </li>
        </ul>

        <div className="cp-perms-foot">
          <button type="button" className="btn cp-perms-cta" onClick={onDone} autoFocus>
            Continue
          </button>
          <p className="cp-perms-note">You can change any of this later in Settings, under Camera &amp; Mic.</p>
        </div>
      </div>
    </div>
  );
}
