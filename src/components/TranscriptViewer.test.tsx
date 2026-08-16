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
  // Wait for the SRT read to LAND, not merely for the toolbar to exist.
  //
  // This used to wait on the undo/redo group, which renders as soon as the
  // panel does - whether or not the transcript has parsed. So mount() returned
  // early and the async read resolved partway through the test body, and any
  // state it settled (the overrides load, the turnTag migration) could land
  // between an assertion being set up and being read. That is what made
  // "lights up, and names the edit" fail about one run in five.
  //
  // Cues only exist once the file is parsed, so they are the real signal.
  await waitFor(() => expect(document.querySelectorAll(".cp-tx-cue").length).toBeGreaterThan(0));
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

    // waitFor, not a bare expect. This failed once on CI - a slower machine -
    // reporting the button still disabled, and could not be reproduced in 12
    // local runs. The store notifies its listeners synchronously and the
    // toolbar reads it through subscribe/getSnapshot, so there is no path
    // where undo simply never enables; what varies is which tick the render
    // lands on when mount's async work is still settling nearby.
    //
    // This does NOT weaken the test. The subject is "undo lights up and names
    // the edit", not "it does so within zero microtasks" - and if undo ever
    // genuinely stopped enabling, this still fails, just at the timeout.
    await waitFor(() => {
      expect(undo().disabled).toBe(false);
      expect(undo().getAttribute("title")).toBe("Undo merge speakers");
    });
  });
});

describe("cue editing is reachable without a mouse", () => {
  it("exposes each cue as a real control, not a bare span", async () => {
    // Fixing a Whisper mis-transcription is the most common thing anyone does
    // in this panel, and the only way in was a double-click on a <span> with
    // no role, no tab stop and no key handler. A mouse was mandatory to
    // correct a word.
    await mount();
    const cues = document.querySelectorAll(".cp-tx-cue");
    expect(cues.length).toBeGreaterThan(0);
    for (const c of cues) {
      expect(c.getAttribute("role")).toBe("button");
      expect(c.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("gives the panel exactly ONE tab stop, not one per cue", async () => {
    // A two-hour interview is thousands of cues. Making each one tabbable
    // would be the same explosion the Library grid had; the stop belongs on
    // the line being heard, which is the line you want to fix.
    await mount();
    const tabbable = [...document.querySelectorAll(".cp-tx-cue")]
      .filter((c) => c.getAttribute("tabindex") === "0");
    expect(tabbable).toHaveLength(1);
  });

  it("opens the editor on F2, the rename convention", async () => {
    await mount();
    const cue = document.querySelector('.cp-tx-cue[tabindex="0"]') as HTMLElement;
    act(() => cue.focus());
    act(() => {
      cue.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });
    // The editor replaces the cue with a textarea in place.
    await waitFor(() => expect(document.querySelector("textarea")).toBeTruthy());
  });
});

describe("splitting a speaker by selecting their dialogue", () => {
  /** Lasso across two cue spans, the way a drag does. */
  function lasso(from: number, to: number) {
    const a = document.querySelector(`[data-cue-idx="${from}"]`)!.firstChild!;
    const b = document.querySelector(`[data-cue-idx="${to}"]`)!.firstChild!;
    document.getSelection()!.setBaseAndExtent(a, 1, b, 2);
  }

  function rightClick(idx: number) {
    const cue = document.querySelector(`[data-cue-idx="${idx}"]`) as HTMLElement;
    act(() => {
      cue.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
  }

  it("offers the split on a selection, sized in lines", async () => {
    await mount();
    lasso(0, 1);
    rightClick(1);
    // Named by what it will do to what you highlighted, not "Split".
    expect(screen.getByRole("menuitem", { name: /Make 2 lines a new speaker/ })).toBeTruthy();
  });

  it("acts on the clicked cue when nothing is selected", async () => {
    // An ordinary right-click is still useful; refusing it would make the
    // feature feel arbitrary.
    await mount();
    document.getSelection()?.removeAllRanges();
    rightClick(0);
    expect(screen.getByRole("menuitem", { name: /Make 1 line a new speaker/ })).toBeTruthy();
  });

  it("splits, then asks who it is", async () => {
    await mount();
    lasso(0, 0);
    rightClick(0);
    act(() => { screen.getByRole("menuitem", { name: /Make 1 line a new speaker/ }).click(); });
    // Splitting and naming are one intention — nobody lassoes dialogue in
    // order to create "CAST_A".
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Name the new speaker" })).toBeTruthy());
  });

  it("puts the split on the undo stack, named", async () => {
    await mount();
    const undo = () => screen.getByRole("button", { name: /^Undo/ }) as HTMLButtonElement;
    expect(undo().disabled).toBe(true);
    lasso(0, 0);
    rightClick(0);
    act(() => { screen.getByRole("menuitem", { name: /a new speaker/ }).click(); });
    // Same shape as "lights up, and names the edit" above, in the same
    // component behind the same async mount - which is the one that actually
    // went red on CI. Fixing that one and leaving this is just waiting for the
    // next slow machine.
    await waitFor(() => {
      expect(undo().disabled).toBe(false);
      expect(undo().getAttribute("title")).toBe("Undo reassign dialogue");
    });
  });

  it("offers the OTHER speakers to reassign to, and not the current one", async () => {
    // The diarizer splits one person as readily as it merges two, so handing
    // the lines to somebody who already exists is the other half of the fix.
    await mount();
    lasso(1, 1);
    rightClick(1);
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent ?? "");
    expect(items.some((t) => /Assign to/.test(t))).toBe(true);
    // Cue 1 belongs to SPEAKER_01 in the fixture; it must not be offered
    // itself, which would be a no-op dressed as an action.
    expect(items.filter((t) => /Assign to Speaker 2/.test(t))).toHaveLength(0);
  });
});
