import { type Dispatch, type SetStateAction, type MutableRefObject } from "react";
import { useTauriListeners } from "./use-tauri-listeners";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate } from "../lib/update-check";
import type { ToastKind } from "../components/CanvasToast";
// Type-only, so it is erased at compile time and creates no runtime cycle —
// the same import NavRail.tsx already uses for this type.
import type { AppView } from "../App";

/**
 * The native menubar's ten items, bound to `menu:<id>` window events.
 *
 * Rust builds the menu and emits an event per click; nothing type-checks the
 * two halves against each other, which is what `menu-surface-contract` exists
 * for. That contract proves the IDS agree. It cannot prove that clicking
 * "Toggle Queue" toggles the queue — this hook is what makes that testable.
 *
 * UNLIKE the four listener hooks beside it, this one legitimately RE-SUBSCRIBES.
 * `transcriptLibrary` is a path string rather than a stable reference, so
 * changing the library folder rebinds all ten. That is correct — the
 * reveal_library handler closes over the path — and it is why the bind helper
 * releases a listener that resolves after teardown instead of pushing it onto
 * an array nobody will read again.
 *
 * Lifted out of App.tsx with the body captured verbatim.
 */

export type UseMenubarEventsDeps = {
  handleImportFile: () => void;
  handleImportTranscript: () => void;
  /** `defaults.transcriptLibrary` — a VALUE, so this hook re-binds on change. */
  transcriptLibrary: string | null | undefined;
  pushNotification: (kind: ToastKind, title: string, body: string, path?: string) => void;

  /** App's navigator, a plain callback rather than a raw setState. */
  setActiveView: (v: AppView) => void;
  setQueueOpenChoice: (next: boolean | ((p: boolean) => boolean)) => void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  /** App's own tab union, not `string`: widening it here would let a typo
   *  through that App itself would have rejected. */
  setSettingsInitialTab: Dispatch<SetStateAction<
    "general" | "transcription" | "ai-summary" | "commands" | "about">>;
  setLogsOpen: Dispatch<SetStateAction<boolean>>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;

  /** In a live room the URL bar IS the room's source bar; these decide that. */
  sessionRoomRef: MutableRefObject<unknown>;
  /** App keeps this as a plain string; the hook only compares it. */
  activeViewRef: MutableRefObject<string>;
};

export function useMenubarEvents(d: UseMenubarEventsDeps): void {
  const {
    handleImportFile, handleImportTranscript, transcriptLibrary, pushNotification,
    setActiveView, setQueueOpenChoice, setSettingsOpen, setSettingsInitialTab,
    setLogsOpen, setPaletteOpen, setShortcutsOpen, sessionRoomRef, activeViewRef,
  } = d;

  useTauriListeners((on) => {
    // The self-release this used to spell out by hand now lives in
    // use-tauri-listeners: a bind resolving after teardown releases itself
    // rather than joining a list nobody will read. That matters more here
    // than anywhere else, because this hook genuinely re-subscribes.
    const bind = (id: string, fn: () => void) => on(`menu:${id}`, () => fn());
    [
          bind("open_url_bar",        () => {
            // In a live room the URL bar IS the room's source bar - focus that
            // and stay put. Ejecting a presenter to the Clip view mid-session
            // (which is what an unconditional setActiveView("clip") did) breaks
            // the sticky-workspace rule.
            if (sessionRoomRef.current && activeViewRef.current === "coreview") {
              setTimeout(() => {
                const el = document.querySelector<HTMLInputElement>(".cp-room-source-field input");
                el?.focus();
                el?.select();
              }, 0);
              return;
            }
            // Otherwise the URL bar lives in the Clip view's toolbar - surface
            // that view first (a [hidden] subtree can't take focus), then focus
            // once React has committed the unhide (setTimeout lands after the
            // microtask-flushed render).
            setActiveView("clip");
            setTimeout(() => {
              const el = document.querySelector<HTMLInputElement>(".cp-url input");
              el?.focus();
              el?.select();
            }, 0);
          }),
          bind("import_local",        () => handleImportFile()),
          bind("import_transcript",   () => handleImportTranscript()),
          bind("reveal_library",      () => {
            const lib = transcriptLibrary;
            if (!lib) return;
            invoke("ensure_dir_exists", { path: lib })
              .then(() => invoke("reveal_in_finder", { path: lib }))
              .catch(() => { /* ignore */ });
          }),
          bind("open_settings",       () => setSettingsOpen(true)),
          // Help > Check for Updates used to just open a browser tab. Now it
          // asks, and either says you're current or offers the new version.
          bind("check_updates",       () => {
            void (async () => {
              const current = await getVersion().catch(() => null);
              if (!current) { setSettingsInitialTab("about"); setSettingsOpen(true); return; }
              const status = await checkForUpdate(current);
              if (status.kind === "available") {
                pushNotification("info", `Sauce Bunny ${status.version} is available`,
                  "Open Settings, About to download it.");
              } else if (status.kind === "current") {
                pushNotification("success", "You're up to date", `Version ${current}.`);
              } else {
                pushNotification("info", "Couldn't check for updates",
                  "No connection, or no release published yet.");
              }
            })();
          }),
          bind("toggle_pipeline",     () => setLogsOpen((p) => !p)),
          bind("toggle_queue",        () => setQueueOpenChoice((p) => !p)),
          bind("show_command_palette", () => setPaletteOpen(true)),
          bind("show_shortcuts",       () => setShortcutsOpen(true)),
    ];
      }, [
    handleImportFile, handleImportTranscript, transcriptLibrary, pushNotification,
    setActiveView, setQueueOpenChoice, setSettingsOpen, setSettingsInitialTab,
    setLogsOpen, setPaletteOpen, setShortcutsOpen,
    sessionRoomRef, activeViewRef,
  ]);
}
