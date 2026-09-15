// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMenubarEvents } from "./use-menubar-events";

/**
 * What `menu-surface-contract` cannot check.
 *
 * That contract compares the ids Rust emits against the ids React binds, and
 * it is the right test for the thing it checks: neither side names the other,
 * so an id that exists once is invisible to the compiler. What it cannot see
 * is whether "Toggle Queue" toggles the queue. Ten menu items, and until this
 * hook came out of App.tsx none of their BEHAVIOUR was reachable from a test.
 *
 * The URL-bar item is the one with a real decision in it: in a live room the
 * URL bar IS the room's source bar, so focusing it must not eject a presenter
 * to the Clip view mid-session. That is a sticky-workspace rule the app cares
 * about, expressed as an early return, and it is easy to delete by accident.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlistened: 0,
  invoked: [] as Array<{ cmd: string; args: unknown }>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return () => { h.unlistened += 1; };
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => { h.invoked.push({ cmd, args }); },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.0" }));
vi.mock("../lib/update-check", () => ({
  checkForUpdate: async () => ({ kind: "current" as const }),
}));

function deps(over: Record<string, unknown> = {}) {
  return {
    handleImportFile: vi.fn(),
    handleImportTranscript: vi.fn(),
    transcriptLibrary: "/Docs/Sauce Bunny/Transcripts",
    pushNotification: vi.fn(),
    setActiveView: vi.fn(),
    setQueueOpenChoice: vi.fn(),
    setSettingsOpen: vi.fn(),
    setSettingsInitialTab: vi.fn(),
    setLogsOpen: vi.fn(),
    setPaletteOpen: vi.fn(),
    setShortcutsOpen: vi.fn(),
    sessionRoomRef: { current: null },
    activeViewRef: { current: "clip" },
    ...over,
  } as unknown as Parameters<typeof useMenubarEvents>[0];
}

async function mount(over: Record<string, unknown> = {}) {
  const d = deps(over);
  const r = renderHook(() => useMenubarEvents(d));
  await waitFor(() => expect(h.handlers.size).toBe(10));
  return { d, ...r };
}
// Tauri hands a handler an EVENT object, not bare args. The first version of
// this helper called the listener with nothing, which worked only because the
// hook's own listener ignored its argument — and broke the moment the shared
// primitive started reading `e.payload`. Emulating the real contract is the
// point of a mock.
const click = (id: string) => h.handlers.get(`menu:${id}`)!({ payload: null });

beforeEach(() => { h.handlers.clear(); h.unlistened = 0; h.invoked.length = 0; });
afterEach(() => vi.clearAllMocks());

describe("binding", () => {
  it("binds all ten items and releases them on unmount", async () => {
    const { unmount } = await mount();
    expect([...h.handlers.keys()].sort()).toEqual([
      "menu:check_updates", "menu:import_local", "menu:import_transcript",
      "menu:open_settings", "menu:open_url_bar", "menu:reveal_library",
      "menu:show_command_palette", "menu:show_shortcuts",
      "menu:toggle_pipeline", "menu:toggle_queue",
    ]);
    unmount();
    await waitFor(() => expect(h.unlistened).toBe(10));
  });
});

describe("each item does its job", () => {
  it("routes the simple ones", async () => {
    const { d } = await mount();
    click("import_local");        expect(d.handleImportFile).toHaveBeenCalled();
    click("import_transcript");   expect(d.handleImportTranscript).toHaveBeenCalled();
    click("open_settings");       expect(d.setSettingsOpen).toHaveBeenCalledWith(true);
    click("show_command_palette"); expect(d.setPaletteOpen).toHaveBeenCalledWith(true);
    click("show_shortcuts");      expect(d.setShortcutsOpen).toHaveBeenCalledWith(true);
  });

  it("toggles rather than forces the two toggles", async () => {
    // `setLogsOpen(true)` would make the menu item one-way — it has to flip.
    const { d } = await mount();
    click("toggle_pipeline");
    click("toggle_queue");
    const logs = (d.setLogsOpen as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as (p: boolean) => boolean;
    const queue = (d.setQueueOpenChoice as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as (p: boolean) => boolean;
    expect(typeof logs).toBe("function");
    expect(logs(true)).toBe(false);
    expect(queue(false)).toBe(true);
  });

  it("creates the library folder before revealing it", async () => {
    // Reveal on a folder that does not exist yet is a no-op in Finder, so the
    // ensure has to come first and its failure must not throw.
    await mount();
    click("reveal_library");
    await waitFor(() => expect(h.invoked.map((i) => i.cmd)).toEqual(["ensure_dir_exists", "reveal_in_finder"]));
  });

  it("does nothing when no library folder is configured", async () => {
    await mount({ transcriptLibrary: null });
    click("reveal_library");
    expect(h.invoked).toHaveLength(0);
  });
});

describe("Check for Updates", () => {
  it("says you are current rather than opening a browser", async () => {
    const { d } = await mount();
    click("check_updates");
    await waitFor(() => expect(d.pushNotification).toHaveBeenCalledWith(
      "success", "You're up to date", "Version 0.2.0."));
  });
});

describe("the URL bar item respects a live room", () => {
  let fields: HTMLDivElement;

  beforeEach(() => {
    fields = document.createElement("div");
    document.body.append(fields);
  });

  afterEach(() => {
    try {
      // Menu focus is intentionally deferred until the destination view mounts.
      // Execute owned callbacks while this test's document still exists, even
      // when an assertion failed, rather than leaving real timers past teardown.
      if (vi.isFakeTimers()) {
        act(() => vi.runAllTimers());
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      fields.remove();
      vi.useRealTimers();
    }
  });

  async function mountForFocus(over: Record<string, unknown> = {}) {
    // Listener setup uses Testing Library's real-timer waitFor. Take ownership
    // of timers after it finishes and before dispatching any menu action.
    const mounted = await mount(over);
    vi.useFakeTimers();
    return mounted;
  }

  function field(className: string) {
    const wrapper = document.createElement("div");
    wrapper.className = className;
    const input = document.createElement("input");
    input.value = "https://example.test/video";
    wrapper.append(input);
    fields.append(wrapper);
    return input;
  }

  function expectDeferredFocus(input: HTMLInputElement) {
    expect(document.activeElement).not.toBe(input);
    expect(vi.getTimerCount()).toBe(1);
    // select() also queues jsdom selection events; drain those while the same
    // document is alive instead of abandoning them when real timers return.
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(vi.getTimerCount()).toBe(0);
  }

  it("stays put in a session instead of ejecting to Clip", async () => {
    // The sticky-workspace rule: in a room the URL bar IS the source bar.
    const { d } = await mountForFocus({ sessionRoomRef: { current: { id: "r1" } }, activeViewRef: { current: "coreview" } });
    field("cp-url");
    const roomInput = field("cp-room-source-field");
    click("open_url_bar");
    expect(d.setActiveView).not.toHaveBeenCalled();
    expectDeferredFocus(roomInput);
  });

  it("surfaces the Clip view everywhere else, since a hidden field cannot focus", async () => {
    const { d } = await mountForFocus();
    field("cp-room-source-field");
    click("open_url_bar");
    expect(d.setActiveView).toHaveBeenCalledWith("clip");
    // The newly surfaced Clip field can appear after the menu event but before
    // its queued focus callback, just as it does after React commits the view.
    expectDeferredFocus(field("cp-url"));
  });

  it("does not stay put for a room that is not the active view", async () => {
    // Both halves of the condition matter: a backgrounded session must not
    // stop the menu item working from the Library.
    const { d } = await mountForFocus({ sessionRoomRef: { current: { id: "r1" } }, activeViewRef: { current: "library" } });
    field("cp-room-source-field");
    const clipInput = field("cp-url");
    click("open_url_bar");
    expect(d.setActiveView).toHaveBeenCalledWith("clip");
    expectDeferredFocus(clipInput);
  });

  it("finishes the deferred action safely when no URL field is mounted", async () => {
    await mountForFocus();
    click("open_url_bar");
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(document.body);
    expect(vi.getTimerCount()).toBe(0);
  });
});
