// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { DISMISS_POPOVERS } from "./use-dismiss";

/**
 * The global keyboard dispatch, testable for the first time.
 *
 * This was 258 lines inside App.tsx with a twenty-five entry dependency array.
 * Nothing about it could be exercised without booting the entire app, so every
 * rule below — several of them fixes for real bugs, with the reasoning written
 * in the source — was held in place by nothing.
 *
 * The four that matter most, and why each exists:
 *
 *  · Playback and marking act on the CLIP player. They used to fire from Home
 *    and the Library, where that player is mounted but off screen: Space
 *    started playback nobody could see, i/o/g moved marks on a different file.
 *    Silent state corruption from a view that looks inert.
 *  · Those same keys must NOT be swallowed when they are declined, or the
 *    Library's arrow-key navigation and type-ahead stop working.
 *  · Escape inside Settings belongs to SettingsModal. App used to close it
 *    too, and that second closer beat the modal's own arm/disarm handling.
 *  · The timecode HUD swallows everything while it is open, so a stray letter
 *    cannot trigger a shortcut mid-entry.
 */

type Deps = Parameters<typeof useKeyboardShortcuts>[0];

function deps(over: Partial<Deps> = {}): Deps {
  const noop = vi.fn();
  return {
    // A binding map covering one playback-scoped action and one global one.
    comboToAction: new Map([["space", "play.toggle"], ["mod+k", "app.palette"]]),
    status: "loaded",
    fps: 25,
    readerFps: () => 25,
    durationFrames: 1000,
    settingsOpen: false,
    exportOpts: { folder: "/M" },
    activeViewRef: { current: "clip" },
    homeViewRef: { current: null }, libraryViewRef: { current: null },
    clipViewRef: { current: null }, coreviewViewRef: { current: null },
    readerViewRef: { current: null }, readerPlayerRef: { current: null },
    tcEntryRef: { current: null },
    kHeldRef: { current: false },
    reviewRangeGateRef: { current: {
      panelDetached: false, queueOpen: false, roomActive: false,
      reviewSourceKey: null, hasSource: false, clipVisible: false,
    } },
    reviewRangeKeysRef: { current: null },
    onPlayToggle: vi.fn(), shuttleStep: vi.fn(), onMarkIn: vi.fn(),
    onMarkOut: vi.fn(), onClearMarks: vi.fn(), onGotoIn: vi.fn(),
    onGotoOut: vi.fn(), onStep: vi.fn(), onSeek: vi.fn(), readerSeekRel: vi.fn(),
    handlePlaybackRateStep: vi.fn(), handlePlaybackRateChange: vi.fn(),
    handleFetch: vi.fn(), handleExport: vi.fn(), handleAddToQueue: vi.fn(),
    performUndo: vi.fn(), performRedo: vi.fn(), navigateView: vi.fn(),
    pushNotification: vi.fn(),
    setTcEntry: vi.fn(), setPaletteOpen: vi.fn(), setShortcutsOpen: vi.fn(),
    setSettingsOpen: vi.fn(), setLogsOpen: vi.fn(), setQueueOpenChoice: noop,
    ...over,
  } as unknown as Deps;
}

/**
 * Dispatch a real keydown and report whether the handler claimed it.
 *
 * `code` is REQUIRED, not decoration: `eventToCombo` resolves its token from
 * `e.code` before `e.key`, deliberately, so a keyboard layout cannot alias a
 * binding. Synthetic events carrying only `key` matched nothing — the canary
 * below caught that, which is the whole reason it is there.
 */
function codeFor(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return `Key${key.toUpperCase()}`;
  return key;   // "Escape", "Enter", "Backspace" already match
}

function press(key: string, init: KeyboardEventInit = {}, target?: EventTarget) {
  const e = new KeyboardEvent("keydown", {
    key, code: codeFor(key), bubbles: true, cancelable: true, ...init,
  });
  (target ?? window).dispatchEvent(e);
  return e;
}

let d: Deps;
beforeEach(() => { d = deps(); });
// UNMOUNT between tests, explicitly. Without this every renderHook leaves its
// window listener attached, so a later test's keypress is handled by an
// EARLIER test's hook — with that test's mocks, so the current test's "was not
// called" assertion passes while the wrong instance did the work. That is
// exactly how the view-scoping test below passed for the wrong reason until
// the defaultPrevented check disagreed with it.
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("view scoping", () => {
  it("runs a playback action on the Clip view", () => {
    // The canary: if the binding map or the dispatch stops matching, every
    // "does not fire" assertion below passes for the wrong reason.
    renderHook(() => useKeyboardShortcuts(d));
    press(" ");
    expect(d.onPlayToggle).toHaveBeenCalled();
  });

  it("declines it on a view with no player", () => {
    const dl = deps({ activeViewRef: { current: "library" } });
    renderHook(() => useKeyboardShortcuts(dl));
    press(" ");
    expect(dl.onPlayToggle).not.toHaveBeenCalled();
  });

  it("leaves the declined key usable by the view in front", () => {
    // Returning WITHOUT preventDefault is the load-bearing half. Swallow it
    // and the Library's arrow navigation and type-ahead die on the same keys.
    const dl = deps({ activeViewRef: { current: "library" } });
    renderHook(() => useKeyboardShortcuts(dl));
    const e = press(" ");
    expect(e.defaultPrevented, "the declined key was swallowed").toBe(false);
  });

  it("claims the key when it DOES act", () => {
    renderHook(() => useKeyboardShortcuts(d));
    const e = press(" ");
    expect(e.defaultPrevented).toBe(true);
  });
});

describe("Escape and Settings", () => {
  it("does not close Settings — that belongs to SettingsModal", () => {
    // App used to carry its own closer. Both listeners are window/keydown in
    // the bubble phase and App registers first, so it closed Settings out from
    // under the modal's armed-Delete confirm every time.
    const ds = deps({ settingsOpen: true });
    renderHook(() => useKeyboardShortcuts(ds));
    press("Escape");
    expect(ds.setSettingsOpen).not.toHaveBeenCalled();
  });

  it("runs no rebindable action while Settings is open", () => {
    const ds = deps({ settingsOpen: true });
    renderHook(() => useKeyboardShortcuts(ds));
    press(" ");
    expect(ds.onPlayToggle).not.toHaveBeenCalled();
  });
});

describe("the timecode HUD", () => {
  it("swallows a letter that would otherwise be a shortcut", () => {
    const dh = deps({ tcEntryRef: { current: "12" } });
    renderHook(() => useKeyboardShortcuts(dh));
    press(" ");
    expect(dh.onPlayToggle, "a shortcut fired mid timecode entry").not.toHaveBeenCalled();
  });

  it("appends digits and seeks on Enter", () => {
    const dh = deps({ tcEntryRef: { current: "0000010" } });
    renderHook(() => useKeyboardShortcuts(dh));
    press("5");
    expect(dh.setTcEntry).toHaveBeenCalled();
    press("Enter");
    expect(dh.onSeek).toHaveBeenCalled();
    expect(dh.setTcEntry).toHaveBeenCalledWith(null);
  });

  it("Escape cancels the entry rather than reaching Settings", () => {
    const dh = deps({ tcEntryRef: { current: "12" } });
    renderHook(() => useKeyboardShortcuts(dh));
    press("Escape");
    expect(dh.setTcEntry).toHaveBeenCalledWith(null);
    expect(dh.setSettingsOpen).not.toHaveBeenCalled();
  });
});

describe("typing", () => {
  it("ignores a non-global shortcut while a field has focus", () => {
    renderHook(() => useKeyboardShortcuts(d));
    const input = document.createElement("input");
    document.body.appendChild(input);
    press(" ", {}, input);
    expect(d.onPlayToggle, "Space scrubbed while the user was typing").not.toHaveBeenCalled();
    input.remove();
  });
});

describe("the palette dismisses covered popovers", () => {
  it("fires the dismiss event before opening", () => {
    // ⌘K is neither an outside mousedown nor Escape, so useDismiss cannot see
    // it. Without this the recents popover stayed live UNDER the palette and
    // one Enter loaded a recent video.
    renderHook(() => useKeyboardShortcuts(d));
    const seen = vi.fn();
    window.addEventListener(DISMISS_POPOVERS, seen);
    press("k", { metaKey: true });
    expect(seen).toHaveBeenCalled();
    expect(d.setPaletteOpen).toHaveBeenCalled();
    window.removeEventListener(DISMISS_POPOVERS, seen);
  });
});
