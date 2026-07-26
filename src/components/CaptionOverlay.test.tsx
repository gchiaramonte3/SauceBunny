// @vitest-environment jsdom
//
// The on-video captions. Chosen as the second component test because this is
// where the app's central claim is observable: one clock drives the picture,
// the transcript highlight and these captions, so if any of them disagrees
// the user sees it immediately and blames the transcription.
//
// The pieces were each covered already — parseSrt and cueIndexAt in
// lib/srt.test.ts, the speaker-name resolution in transcript/helpers — and the
// assembly of them was not. That is the shape of the gap component tests
// close: every part correct, wired together wrong.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CaptionOverlay, type CaptionStyle } from "./CaptionOverlay";
import { setPlayheadFrames } from "../lib/playhead-store";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const SRT = `1
00:00:01,000 --> 00:00:03,000
First line.

2
00:00:05,000 --> 00:00:07,000
Second line.

3
00:00:09,000 --> 00:00:11,000
Third line.
`;

const FPS = 30;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(SRT);
  localStorage.clear();
  setPlayheadFrames(0);
});
afterEach(cleanup);

/** Render and let the async SRT read settle. */
async function mount(props: Partial<Parameters<typeof CaptionOverlay>[0]> = {}) {
  const view = render(
    <CaptionOverlay path="/tmp/x.srt" fps={FPS} enabled {...props} />,
  );
  await act(async () => { await Promise.resolve(); });
  return view;
}

/** Move the playhead to a wall-clock second, the way a player would. */
function seek(seconds: number) {
  act(() => setPlayheadFrames(Math.floor(seconds * FPS)));
}

function shown(): string | null {
  return screen.queryByRole("status")?.textContent
    ?? document.querySelector(".cp-caption-cue")?.textContent
    ?? null;
}

describe("CaptionOverlay — which cue is on screen", () => {
  it("shows nothing before the first cue", async () => {
    await mount();
    seek(0.5);
    expect(shown()).toBeNull();
  });

  it("shows the cue covering the playhead", async () => {
    await mount();
    seek(2);
    expect(shown()).toContain("First line.");
    seek(6);
    expect(shown()).toContain("Second line.");
    seek(10);
    expect(shown()).toContain("Third line.");
  });

  it("goes blank in the gaps between cues", async () => {
    // Captions that linger through silence are the single most common
    // giveaway of a naive "last cue wins" lookup.
    await mount();
    seek(4);
    expect(shown()).toBeNull();
    seek(8);
    expect(shown()).toBeNull();
    seek(20);
    expect(shown()).toBeNull();
  });

  it("switches on a tick with no prop change", async () => {
    // The single-clock model: the store moves, the caption follows, nothing
    // above this component re-renders.
    await mount();
    seek(2);
    expect(shown()).toContain("First line.");
    seek(6);
    expect(shown()).toContain("Second line.");
  });
});

describe("CaptionOverlay — the sync offset", () => {
  const style = (syncSec: number): CaptionStyle => ({
    sizePx: 28, font: "nunito", bgOpacity: 0.6, color: "#fff", syncSec,
  });

  it("a positive offset shows the cue earlier", async () => {
    // The knob exists for the MSE stream path, where the playhead runs behind
    // real media time. Positive = look further ahead in the transcript.
    await mount({ style: style(1) });
    seek(4.5); // +1 → 5.5, inside cue 2
    expect(shown()).toContain("Second line.");
  });

  it("a negative offset shows it later", async () => {
    await mount({ style: style(-1) });
    seek(6); // -1 → 5.0, still cue 2
    expect(shown()).toContain("Second line.");
    seek(5.5); // -1 → 4.5, in the gap
    expect(shown()).toBeNull();
  });

  it("treats a missing offset as zero", async () => {
    await mount({ style: { sizePx: 28, font: "nunito", bgOpacity: 0.6, color: "#fff" } });
    seek(6);
    expect(shown()).toContain("Second line.");
    seek(4);
    expect(shown()).toBeNull();
  });
});

describe("CaptionOverlay — when it must render nothing", () => {
  it("stays silent while disabled, and never reads the file", async () => {
    // Not just hidden: a disabled overlay must not subscribe, poll, or hit
    // the backend at all. That is what makes toggling captions off actually
    // cheap rather than merely invisible.
    await mount({ enabled: false });
    seek(2);
    expect(shown()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("stays silent with no transcript path", async () => {
    await mount({ path: null });
    seek(2);
    expect(shown()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("survives an unreadable transcript instead of blanking the player", async () => {
    invoke.mockRejectedValue(new Error("ENOENT"));
    await mount();
    seek(2);
    expect(shown()).toBeNull();
  });

  it("renders nothing for a cue whose text is only whitespace", async () => {
    invoke.mockResolvedValue("1\n00:00:01,000 --> 00:00:03,000\n   \n");
    await mount();
    seek(2);
    expect(shown()).toBeNull();
  });
});

describe("CaptionOverlay — speaker labels", () => {
  const DIARIZED = `1
00:00:01,000 --> 00:00:03,000
[SPEAKER_00] Hello there.

2
00:00:05,000 --> 00:00:07,000
[SPEAKER_01] General Kenobi.
`;

  it("shows no label at all for an un-diarized transcript", async () => {
    // A bare "Unknown speaker:" over every line of a solo interview is worse
    // than no label, so the label is a property of the FILE, not the cue.
    await mount();
    seek(2);
    expect(shown()).toContain("First line.");
    expect(document.querySelector(".cp-caption-speaker")).toBeNull();
  });

  it("labels each speaker once the transcript is diarized", async () => {
    invoke.mockResolvedValue(DIARIZED);
    await mount();
    seek(2);
    const a = document.querySelector(".cp-caption-speaker")?.textContent;
    seek(6);
    const b = document.querySelector(".cp-caption-speaker")?.textContent;
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("colours the label with a solid colour, never a gradient", async () => {
    // A gradient is invalid as CSS `color:` and silently falls back, which is
    // how the caption label stopped matching the sidebar chip once before.
    invoke.mockResolvedValue(DIARIZED);
    await mount();
    seek(2);
    const el = document.querySelector(".cp-caption-speaker") as HTMLElement;
    expect(el.style.color).toBeTruthy();
    expect(el.style.color).not.toContain("gradient");
  });
});

describe("CaptionOverlay — appearance settings reach the DOM", () => {
  it("applies size, font, colour and backing opacity", async () => {
    await mount({
      style: { sizePx: 44, font: "courier", bgOpacity: 0.25, color: "#ff0000" },
    });
    seek(2);
    const cue = document.querySelector(".cp-caption-cue") as HTMLElement;
    expect(cue.style.getPropertyValue("--cap-size")).toBe("44px");
    expect(cue.style.fontFamily).toContain("Courier");
    expect(cue.style.color).toBe("rgb(255, 0, 0)");
    expect(cue.style.background).toBe("rgba(0, 0, 0, 0.25)");
  });

  it("breaks a long cue across at most two lines", async () => {
    invoke.mockResolvedValue(
      "1\n00:00:01,000 --> 00:00:09,000\n" +
      "This is a deliberately long caption line that has to wrap because it " +
      "exceeds the Latin-script maximum by a comfortable margin.\n",
    );
    await mount();
    seek(2);
    const lines = document.querySelectorAll(".cp-caption-line");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2);
  });
});
