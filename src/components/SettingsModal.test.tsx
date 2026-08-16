// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";

/**
 * The two most expensive single clicks in the app.
 *
 * A Whisper or LLM model is a multi-GB download measured in minutes or hours.
 * Both Delete buttons fired `invoke` immediately, both sat directly beside
 * "Use as default" in the same `btn btn-ghost` styling, and the only statement
 * of what they did lived in a `title` nobody reads before clicking.
 *
 * The rule was already written down and already applied elsewhere:
 * CachedWebPane says a multi-GB consequence gets named in the control the user
 * clicks and never only in a tooltip, clearing the cache asks and names the
 * bytes, and the settings reset asks. The two actions costing the most were
 * the two that did not ask, so this is the existing policy reaching where it
 * had been missed.
 *
 * The interesting case is Escape. This is a modal that already closes on
 * Escape, so the pane's own `window` listener could not be copied across: two
 * listeners would both fire and disarm AND close Settings in one keystroke.
 * Precedence lives in the modal's single handler, and the test below is what
 * keeps it there.
 */

const h = vi.hoisted(() => ({ calls: [] as Array<{ cmd: string; args: unknown }> }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "list_whisper_models") {
      return Promise.resolve([
        { id: "large-v3", name: "Large v3", size_bytes: 3_100_000_000, url: "u", downloaded: true, path: "/m/l.bin" },
        { id: "tiny", name: "Tiny", size_bytes: 77_000_000, url: "u", downloaded: true, path: "/m/t.bin" },
      ]);
    }
    if (cmd === "list_llm_models") {
      return Promise.resolve([
        { id: "qwen-7b", name: "Qwen 7B", size_bytes: 4_400_000_000, ctx: 8192, recommended: true, blurb: "b", downloaded: true },
      ]);
    }
    // Every `list_*` command returns a Vec from Rust, so an empty array is the
    // faithful default. Resolving null instead is what a throwaway mock does,
    // and it is not harmless: `setAudioInputs(null)` makes the render throw
    // inside a `.map`, surfacing as a failure in whichever test ran last. The
    // shared e2e mock lists all three of these for the same reason.
    if (cmd.startsWith("list_")) return Promise.resolve([]);
    return Promise.resolve(null);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/path", () => ({ appDataDir: () => Promise.resolve("/d"), join: (...p: string[]) => Promise.resolve(p.join("/")) }));

const onClose = vi.fn();

function props(over: Record<string, unknown> = {}) {
  return {
    open: true,
    onClose,
    defaults: {
      folder: "/M", format: "video", reencode: false, timecode: "smpte",
      captions: false, captionFont: "Inter", captionSizePx: 18, captionColor: "#fff",
      captionBgOpacity: 0.5, whisperModel: "tiny", transcriptionEngine: "whisper",
      transcriptionLanguage: "auto", transcriptLibrary: "/T", llmSummarizationModel: "qwen-7b",
      summaryFormat: "bullets", summaryLength: "short", scrubAudio: true,
      streamPreview: true, useWebCodecsDecoder: false, clearCacheOnQuit: false,
      mediaCacheCapGb: 20, stunUrl: "", turnUrl: "", turnUsername: "", turnPassword: "",
    },
    setDefaults: vi.fn(),
    streamRungPref: "auto", setStreamRungPref: vi.fn(),
    keepEnabled: true, setKeepEnabled: vi.fn(),
    keybindings: {}, setKeybindings: vi.fn(),
    initialTab: "transcription",
    diarizerReady: true, diarizerPrepareState: "idle", diarizerPrepareError: null,
    onPrepareDiarizerModels: vi.fn(), onCancelDiarizerPrepare: vi.fn(),
    ...over,
  } as unknown as Parameters<typeof SettingsModal>[0];
}

const deleteBtns = () => screen.getAllByRole("button", { name: /^(Delete|Confirm deleting) / });

beforeEach(() => { h.calls.length = 0; onClose.mockClear(); });
afterEach(cleanup);

describe("deleting a downloaded model", () => {
  it("names the model and its size before anything is armed", async () => {
    // The canary. Every assertion below queries these buttons, so if the model
    // list stops rendering they would all pass on an empty result.
    render(<SettingsModal {...props()} />);
    await waitFor(() => expect(deleteBtns().length).toBeGreaterThan(1));
    const names = deleteBtns().map((b) => b.getAttribute("aria-label"));
    expect(names).toContain("Delete Large v3, 2.9 GB");
  });

  it("does NOT delete on the first click", async () => {
    // The defect: one click on a ghost button beside "Use as default" used to
    // spend a 3.1 GB download.
    render(<SettingsModal {...props()} />);
    await waitFor(() => expect(deleteBtns().length).toBeGreaterThan(1));
    const b = deleteBtns().find((x) => x.getAttribute("aria-label")?.includes("Large v3"))!;
    fireEvent.click(b);
    expect(h.calls.some((c) => c.cmd === "delete_whisper_model")).toBe(false);
    // and it now says what the second click costs, in the control itself
    expect(b.textContent).toBe("Delete 2.9 GB?");
    expect(b.className).toContain("armed");
  });

  it("deletes on the second click, and passes the right id", async () => {
    render(<SettingsModal {...props()} />);
    await waitFor(() => expect(deleteBtns().length).toBeGreaterThan(1));
    const b = deleteBtns().find((x) => x.getAttribute("aria-label")?.includes("Large v3"))!;
    fireEvent.click(b);
    fireEvent.click(b);
    const call = h.calls.find((c) => c.cmd === "delete_whisper_model");
    expect(call).toBeTruthy();
    expect(call!.args).toEqual({ modelId: "large-v3" });
  });

  it("arms only the row that was clicked", async () => {
    // Shared state across two lists, so this is the check that one key cannot
    // arm a different model's button.
    render(<SettingsModal {...props()} />);
    await waitFor(() => expect(deleteBtns().length).toBeGreaterThan(1));
    fireEvent.click(deleteBtns().find((x) => x.getAttribute("aria-label")?.includes("Large v3"))!);
    const armed = deleteBtns().filter((x) => x.className.includes("armed"));
    expect(armed.length).toBe(1);
    expect(armed[0].getAttribute("aria-label")).toContain("Large v3");
  });

  it("disarms itself after a few seconds", async () => {
    // A confirm that stays hot is a mine: the next ordinary click on this row
    // would be the destructive one.
    vi.useFakeTimers();
    try {
      render(<SettingsModal {...props()} />);
      await vi.waitFor(() => expect(deleteBtns().length).toBeGreaterThan(1));
      const b = deleteBtns().find((x) => x.getAttribute("aria-label")?.includes("Large v3"))!;
      fireEvent.click(b);
      expect(b.className).toContain("armed");
      act(() => { vi.advanceTimersByTime(4500); });
      expect(deleteBtns().find((x) => x.getAttribute("aria-label")?.includes("Large v3"))!.className)
        .not.toContain("armed");
    } finally { vi.useRealTimers(); }
  });
});

describe("Escape while a delete is armed", () => {
  it("cancels the arming and leaves Settings open", async () => {
    // The reason the pane's pattern could not be copied verbatim. Two window
    // listeners would both fire: the arming would clear AND the modal would
    // close, which is a lot of dismissal for a keystroke aimed at one button.
    render(<SettingsModal {...props()} />);
    await waitFor(() => expect(deleteBtns().length).toBeGreaterThan(1));
    const b = deleteBtns().find((x) => x.getAttribute("aria-label")?.includes("Large v3"))!;
    fireEvent.click(b);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(deleteBtns().find((x) => x.getAttribute("aria-label")?.includes("Large v3"))!.className)
      .not.toContain("armed");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("still closes Settings when nothing is armed", async () => {
    // The behaviour that existed before and must survive: Escape is still the
    // way out of the modal.
    render(<SettingsModal {...props()} />);
    await waitFor(() => expect(deleteBtns().length).toBeGreaterThan(1));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
