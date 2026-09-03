// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The background poster sweep gets out of the way of a foreground open.
 *
 * `prefetchThumbnails` walks EVERY video in every library root, decoding a
 * poster per item and falling back to an ffmpeg subprocess for anything
 * WebCodecs cannot handle. Its only exit was "superseded by a newer scan" -
 * switching view, opening a file, starting a transcription, none of them
 * stopped it. So opening a local file raced a walk over the whole library,
 * competing for the decode slots and the main thread with the thing the user
 * is watching a spinner for.
 *
 * Paused rather than cancelled: cancelling means posters never warm again
 * until the next rescan, which is the whole feature.
 */

const h = vi.hoisted(() => ({ decoded: [] as string[], gate: null as null | (() => void) }));

vi.mock("../lib/mediabunny-helpers", () => ({
  // Each "decode" records itself and waits for the test to let it finish, so
  // the sweep can be paused mid-walk rather than after it has already run.
  extractPosterBlob: async (path: string) => {
    h.decoded.push(path);
    await new Promise<void>((r) => { h.gate = r; });
    return null;
  },
  extractFrameAsBlob: async () => null,
  probeVideoDuration: async () => null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => "" }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("../lib/asset-url", () => ({ assetUrl: (p: string) => `asset://${p}` }));
vi.mock("../lib/library", () => ({
  LIBRARY_SCAN_DEPTH: 3,
  chosenPosterFor: () => null,
  clearChosenPoster: () => {},
  loadLibraryRoots: () => [],
  saveLibraryRoots: () => {},
}));

const { prefetchThumbnails, pausePosterWarmup, resumePosterWarmup } =
  await import("./use-library-scan");

/** Release exactly ONE in-flight decode and let the walk take its next turn.
 *  Stepping one at a time is the point: a tick that drains everything runs the
 *  whole sweep to completion before a pause can be issued, and then the test
 *  is measuring a finished walk rather than an interrupted one. */
async function step() {
  h.gate?.(); h.gate = null;
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/** Run the walk to a standstill. */
async function drain() {
  for (let i = 0; i < 10; i++) await step();
}

beforeEach(() => {
  h.decoded = []; h.gate = null;
  // The sweep's pause flag and its leftover work are MODULE state, so a test
  // that pauses and never resumes hands the next test a paused sweep. This
  // repo has been bitten by exactly that before (library-hidden's module-level
  // set), and the symptom is a later test failing for the previous test's
  // reason.
  resumePosterWarmup();
});

describe("the poster warm-up sweep", () => {
  it("stops walking the library while a foreground open is in flight", async () => {
    // DISTINCT paths per test. thumbCache/thumbFailed/thumbPending are module
    // state too, so reusing a path means the second test's walk skips every
    // item at the `continue` and decodes nothing - which reads as "the sweep
    // never came back" and sends you looking at the pause instead of the test.
    prefetchThumbnails(["/p1a.mp4", "/p1b.mp4", "/p1c.mp4", "/p1d.mp4"]);
    await step();
    // Canary: if nothing decoded, the pause below proves nothing.
    expect(h.decoded.length, "the sweep never started").toBeGreaterThan(0);

    pausePosterWarmup();
    const atPause = h.decoded.length;
    await drain();
    expect(h.decoded.length,
      `the sweep kept decoding through the pause: ${h.decoded.join(", ")}`).toBe(atPause);
  });

  it("resumes where it stopped, rather than starting over or giving up", async () => {
    prefetchThumbnails(["/p2a.mp4", "/p2b.mp4", "/p2c.mp4", "/p2d.mp4"]);
    await step();
    pausePosterWarmup();
    await drain();
    const paused = [...h.decoded];
    expect(paused.length).toBeLessThan(4);

    resumePosterWarmup();
    await drain();
    expect(h.decoded.length, "the sweep never came back").toBeGreaterThan(paused.length);
    // Not a restart: nothing is decoded twice.
    expect(new Set(h.decoded).size, `re-decoded: ${h.decoded.join(", ")}`).toBe(h.decoded.length);
  });

  it("a resume with no pause outstanding does nothing", () => {
    expect(() => resumePosterWarmup()).not.toThrow();
    expect(h.decoded).toEqual([]);
  });
});
