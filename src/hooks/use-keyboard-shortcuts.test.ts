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
  it("leaves Multitrack transport keys to its own player", () => {
    const dm = deps({ activeViewRef: { current: "multitrack" } });
    renderHook(() => useKeyboardShortcuts(dm));
    expect(press(" ").defaultPrevented).toBe(false);
    expect(dm.onPlayToggle).not.toHaveBeenCalled();
  });

  it("navigates to and focuses the separate Multitrack workspace", async () => {
    const view = document.createElement("div");
    view.tabIndex = -1;
    document.body.append(view);
    const dm = deps({ comboToAction: new Map([["mod+6", "view.multitrack"]]), multitrackViewRef: { current: view } });
    renderHook(() => useKeyboardShortcuts(dm));
    press("6", { code: "Digit6", metaKey: true });
    expect(dm.navigateView).toHaveBeenCalledWith("multitrack");
    await vi.waitFor(() => expect(document.activeElement).toBe(view));
    view.remove();
  });

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

describe("focused controls own their keys", () => {
  it.each(["button", "a", "summary"])("leaves Space and Enter activation to a native %s, including its child", (tag) => {
    const dc = deps({ comboToAction: new Map([["space", "play.toggle"], ["enter", "play.toggle"]]) });
    renderHook(() => useKeyboardShortcuts(dc));
    const control = document.createElement(tag);
    if (tag === "a") control.setAttribute("href", "#test-only");
    const child = document.createElement("span");
    control.appendChild(child); document.body.appendChild(control);
    try {
      for (const key of [" ", "Enter"]) {
        expect(press(key, {}, control).defaultPrevented).toBe(false);
        expect(press(key, {}, child).defaultPrevented).toBe(false);
      }
      expect(dc.onPlayToggle).not.toHaveBeenCalled();
      expect(press(" ").defaultPrevented).toBe(true);
      expect(dc.onPlayToggle).toHaveBeenCalledExactlyOnceWith();
    } finally { control.remove(); }
  });

  it.each(["select", "input", "textarea"])("preserves native %s navigation, type-ahead and digits", (tag) => {
    const dc = deps({ comboToAction: new Map([
      ["space", "play.toggle"], ["left", "play.frameBack"], ["right", "play.frameFwd"],
      ["home", "play.toStart"], ["end", "play.toEnd"], ["j", "play.back5"],
    ]) });
    renderHook(() => useKeyboardShortcuts(dc));
    const control = document.createElement(tag); document.body.appendChild(control);
    try {
      for (const key of [" ", "Enter", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "j", "1"]) {
        expect(press(key, {}, control).defaultPrevented, key).toBe(false);
      }
      expect(dc.onPlayToggle).not.toHaveBeenCalled(); expect(dc.onStep).not.toHaveBeenCalled();
      expect(dc.onSeek).not.toHaveBeenCalled(); expect(dc.shuttleStep).not.toHaveBeenCalled();
      expect(dc.setTcEntry).not.toHaveBeenCalled();
    } finally { control.remove(); }
  });

  it("never redispatches a key already handled by a focused widget", () => {
    renderHook(() => useKeyboardShortcuts(d));
    const control = document.createElement("div"); document.body.appendChild(control);
    control.addEventListener("keydown", e => e.preventDefault());
    try {
      press(" ", {}, control); press("k", { metaKey: true }, control); press("1", {}, control);
      expect(d.onPlayToggle).not.toHaveBeenCalled(); expect(d.setPaletteOpen).not.toHaveBeenCalled();
      expect(d.setTcEntry).not.toHaveBeenCalled(); expect(d.kHeldRef.current).toBe(false);
    } finally { control.remove(); }
  });

  it("keeps modified app navigation and fetch available from native controls and text fields", () => {
    const dc = deps({ comboToAction: new Map([["mod+1", "view.home"], ["mod+enter", "src.fetch"]]) });
    renderHook(() => useKeyboardShortcuts(dc));
    for (const tag of ["button", "select", "input", "textarea"]) {
      const control = document.createElement(tag); document.body.appendChild(control);
      try {
        expect(press("1", { metaKey: true, code: "Digit1" }, control).defaultPrevented).toBe(true);
        expect(press("Enter", { metaKey: true }, control).defaultPrevented).toBe(true);
      } finally { control.remove(); }
    }
    expect(dc.navigateView).toHaveBeenCalledTimes(4); expect(dc.navigateView).toHaveBeenCalledWith("home");
    expect(dc.handleFetch).toHaveBeenCalledTimes(4); expect(dc.setTcEntry).not.toHaveBeenCalled();
  });

  it("retains the explicit timecode HUD's Enter ownership until it closes", () => {
    const dc = deps({ tcEntryRef: { current: "00000100" } });
    renderHook(() => useKeyboardShortcuts(dc));
    const button = document.createElement("button"); document.body.appendChild(button);
    try {
      expect(press("Enter", {}, button).defaultPrevented).toBe(true);
      expect(dc.onSeek).toHaveBeenCalledWith(25); expect(dc.setTcEntry).toHaveBeenCalledWith(null);
    } finally { button.remove(); }
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
