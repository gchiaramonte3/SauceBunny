// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { TranscriptViewer } from "./TranscriptViewer";

/**
 * THERE ARE TWO WAYS TO PUT SPEAKERS ON A TRANSCRIPT AND THEY ARE NOT CLOSE.
 *
 *   Diarize only  - reuse this transcript + the cached source audio, run the
 *                   Swift diarizer, merge labels into the existing SRT in
 *                   place. Seconds. The text is untouched.
 *   Regenerate    - throw the transcript away, re-run Whisper over the whole
 *                   source with Detect speakers on. Minutes on anything long,
 *                   and the text is replaced.
 *
 * The Improve popover offered ONLY Regenerate, which was most wrong in exactly
 * the case it fires most: YouTube auto-captions. Those arrive with no speakers,
 * the audio is already pre-cached for them, and regenerating discards the
 * fetched captions in favour of Whisper's own text - a different edit than the
 * one being asked for.
 *
 * `re_diarize_transcript` had existed the whole time, reachable only as
 * "Re-detect speakers" in a Tools dropdown, under a name that reads as a
 * repeat of something that never happened.
 */

// No [SPEAKER_nn] tags: this is what a fetched caption file looks like, and
// what makes the roster collapse to the single generic "Speaker" entry.
const UNDIARIZED = `1
00:00:01,000 --> 00:00:03,000
First thing.

2
00:00:05,000 --> 00:00:07,000
Second thing.
`;

const DIARIZED = `1
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
  localStorage.clear();
});
afterEach(cleanup);

type Opts = {
  srt?: string;
  onRegenerate?: () => void;
  onRedetectSpeakers?: () => void;
  canRedetect?: boolean;
  onFixCaptionTiming?: () => void;
};

async function mount(o: Opts = {}) {
  invoke.mockResolvedValue(o.srt ?? UNDIARIZED);
  render(
    <TranscriptViewer
      path="/tmp/t.srt"
      playheadActive={false}
      onSeek={() => {}}
      // The case this is all about: text fetched from the source, not
      // transcribed here.
      origin="captions"
      sourceKind="youtube"
      onClearTranscript={() => {}}
      onLoadFromHistory={() => {}}
      onImportTranscript={() => {}}
      regenerateBusy={false}
      // The improvements list early-returns unless regeneration is possible at
      // all, so this must be on for any of it to render.
      canRegenerate
      onRegenerate={o.onRegenerate ?? (() => {})}
      onRedetectSpeakers={o.onRedetectSpeakers}
      canRedetect={o.canRedetect}
      onFixCaptionTiming={o.onFixCaptionTiming}
    />,
  );
  // Wait for the SRT read to land - the roster, and therefore every
  // improvement, is derived from parsed turns.
  await waitFor(() => expect(screen.getByText(/First thing/)).toBeTruthy());
}

describe("adding speakers picks the cheap path when it exists", () => {
  it("runs the diarizer alone rather than a full re-transcription", async () => {
    const onRegenerate = vi.fn();
    const onRedetectSpeakers = vi.fn();
    await mount({ onRegenerate, onRedetectSpeakers, canRedetect: true });

    act(() => { screen.getByRole("button", { name: /Improve/ }).click(); });
    // Scoped to the popover: "Regenerate" and "Detect speakers" both also
    // exist in the toolbar behind it, and an unscoped query would be
    // ambiguous about which control the test actually pressed.
    const pop = screen.getByRole("group", { name: /Ways to improve/ });
    act(() => { within(pop).getByRole("button", { name: /Detect speakers/ }).click(); });

    expect(onRedetectSpeakers, "should diarize in place").toHaveBeenCalledTimes(1);
    expect(onRegenerate, "must NOT re-run Whisper over the whole source").not.toHaveBeenCalled();
  });

  it("still offers Regenerate when diarizing alone is not available", async () => {
    // A local file whose audio cannot be resolved, or any source where App
    // withholds canRedetect. The expensive path is correct here, not absent.
    const onRegenerate = vi.fn();
    await mount({ onRegenerate, canRedetect: false });

    act(() => { screen.getByRole("button", { name: /Improve/ }).click(); });
    const pop = screen.getByRole("group", { name: /Ways to improve/ });
    act(() => { within(pop).getByRole("button", { name: /^Regenerate$/ }).click(); });

    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("the offer disappears once the transcript has speakers", async () => {
    // CANARY for the two cases above: if the roster signal broke, they would
    // both keep passing while the offer showed on every transcript forever.
    //
    // onFixCaptionTiming is supplied so the popover has something ELSE to
    // hold. Without it the improvements list empties, the Improve button stops
    // rendering, and this would pass by never opening anything - which is the
    // scan-found-nothing failure, not evidence.
    await mount({
      srt: DIARIZED, onRedetectSpeakers: vi.fn(), canRedetect: true,
      onFixCaptionTiming: vi.fn(),
    });
    act(() => { screen.getByRole("button", { name: /Improve/ }).click(); });
    const pop = screen.getByRole("group", { name: /Ways to improve/ });
    expect(within(pop).getByText("Tighten the timing"), "the popover is open").toBeTruthy();
    expect(within(pop).queryByText("Add speaker labels")).toBeNull();
  });
});

describe("the Tools item says which one it is", () => {
  it("reads Detect speakers when the transcript has none", async () => {
    await mount({ onRedetectSpeakers: vi.fn(), canRedetect: true });
    act(() => { screen.getByRole("button", { name: /Tools/ }).click(); });
    expect(screen.getByRole("menuitem", { name: "Detect speakers" })).toBeTruthy();
  });

  it("reads Re-detect speakers once there are some", async () => {
    // "Re-" is a claim about history. On a fetched caption file nothing was
    // ever detected, so the word sent people to Regenerate instead.
    await mount({ srt: DIARIZED, onRedetectSpeakers: vi.fn(), canRedetect: true });
    act(() => { screen.getByRole("button", { name: /Tools/ }).click(); });
    expect(screen.getByRole("menuitem", { name: "Re-detect speakers" })).toBeTruthy();
  });
});
