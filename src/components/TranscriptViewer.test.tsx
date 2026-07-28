// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { TranscriptViewer } from "./TranscriptViewer";
import { appUndo } from "../lib/undo";

/**
 * The transcript toolbar is where the app's fiddliest edits happen — renaming
 * a speaker across a two-hour interview, merging two the diarizer split,
 * reassigning one turn — and where "Reset all names" sits one click away.
 * Every one of those was a bare state write with no way back, and the stack
 * that could have held them was invisible unless you already knew cmd+Z
 * worked here.
 */
const SRT = `1
00:00:01,000 --> 00:00:03,000
[SPEAKER_00] First thing.

2
00:00:05,000 --> 00:00:07,000
[SPEAKER_01] Second thing.
`;

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(SRT);
  localStorage.clear();
  appUndo.clear();
});
afterEach(cleanup);

async function mount() {
  render(
    <TranscriptViewer
      path="/tmp/t.srt"
      playheadActive={false}
      onSeek={() => {}}
      origin="whisper"
      onClearTranscript={() => {}}
      onLoadFromHistory={() => {}}
      onRegenerate={() => {}}
      onImportTranscript={() => {}}
      regenerateBusy={false}
      canRegenerate={false}
    />,
  );
  // Let the async SRT read land.
  await waitFor(() => expect(screen.queryByRole("group", { name: "Undo and redo" })).toBeTruthy());
}

describe("TranscriptViewer undo/redo", () => {
  it("puts undo and redo in the toolbar", async () => {
    await mount();
    const undo = screen.getByRole("button", { name: /^Undo/ }) as HTMLButtonElement;
    const redo = screen.getByRole("button", { name: /^Redo/ }) as HTMLButtonElement;
    // Resting state on a freshly opened transcript: present, and quietly off.
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
  });

  it("lights up, and names the edit, once a speaker edit happens", async () => {
    await mount();
    const undo = () => screen.getByRole("button", { name: /^Undo/ }) as HTMLButtonElement;
    expect(undo().disabled).toBe(true);

    // Stand in for any of the seven speaker mutations — they all route through
    // the same seam, which is the point of having one.
    act(() => appUndo.push({ label: "merge speakers", undo: () => {}, redo: () => {} }));

    expect(undo().disabled).toBe(false);
    expect(undo().getAttribute("title")).toBe("Undo merge speakers");
  });
});
