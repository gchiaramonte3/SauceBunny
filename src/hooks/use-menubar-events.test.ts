// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
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
  handlers: new Map<string, () => void>(),
  unlistened: 0,
  invoked: [] as Array<{ cmd: string; args: unknown }>,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: () => void) => {
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
const click = (id: string) => h.handlers.get(`menu:${id}`)!();

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
  it("stays put in a session instead of ejecting to Clip", async () => {
    // The sticky-workspace rule: in a room the URL bar IS the source bar.
    const { d } = await mount({ sessionRoomRef: { current: { id: "r1" } }, activeViewRef: { current: "coreview" } });
    click("open_url_bar");
    expect(d.setActiveView).not.toHaveBeenCalled();
  });

  it("surfaces the Clip view everywhere else, since a hidden field cannot focus", async () => {
    const { d } = await mount();
    click("open_url_bar");
    expect(d.setActiveView).toHaveBeenCalledWith("clip");
  });

  it("does not stay put for a room that is not the active view", async () => {
    // Both halves of the condition matter: a backgrounded session must not
    // stop the menu item working from the Library.
    const { d } = await mount({ sessionRoomRef: { current: { id: "r1" } }, activeViewRef: { current: "library" } });
    click("open_url_bar");
    expect(d.setActiveView).toHaveBeenCalledWith("clip");
  });
});
