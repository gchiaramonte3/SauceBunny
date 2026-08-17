// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLocalSource } from "./use-local-source";

/**
 * The Settings toggle that promised an escape hatch and moved the thumbnail.
 *
 * "WebCodecs decoder (experimental)" says, in the UI, "Disable if local files
 * won't play." Its type declaration says imported local files are "played via
 * mediabunny + WebCodecs instead of the ffmpeg pre-encode path". Neither was
 * true: this hook read `useWebCodecsDecoder` in exactly one place — poster
 * extraction — while the playback branch called `canMediabunnyDecode`
 * unconditionally. Turning it off changed which decoder drew the thumbnail.
 *
 * The reason it went unnoticed is worth keeping. The app already reroutes an
 * import when MediaBunnyPlayer REPORTS a codec it cannot decode, so every
 * failure that throws is covered automatically and the manual switch is never
 * needed. The failure that does NOT throw — a track that decodes and is
 * inaudible, a perfect picture with no sound — is the one case with no
 * automatic way out, and it is the case a user reaches for the switch for.
 *
 * So both directions are pinned here: on (the default) still goes to
 * mediabunny with no transcode, off actually reaches ffmpeg-prep.
 */

const h = vi.hoisted(() => ({
  canDecode: true,
  probe: null as unknown,
}));

vi.mock("../lib/mediabunny-helpers", () => ({
  canMediabunnyDecode: async () => h.canDecode,
  // The poster path is fire-and-forget; returning null sends it to the ffmpeg
  // branch, which the invoke mock below answers. Not what this file is about.
  extractPosterBlob: async () => null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "probe_local_file") return h.probe;
    return "";
  },
}));

vi.mock("../lib/library", () => ({ chosenPosterFor: () => null }));
vi.mock("../lib/playhead-store", () => ({ setPlayheadFrames: () => {} }));
vi.mock("../lib/asset-url", () => ({ assetUrl: (p: string) => `asset://${p}` }));

/** An ordinary h264/aac call recording — every codec natively playable. */
const ORDINARY = {
  path: "/Users/x/Calls/call.mp4",
  filename: "call.mp4",
  size: 625_231_495,
  has_video: true,
  has_audio: true,
  width: 1280,
  height: 720,
  fps: 25,
  vcodec: "h264",
  acodec: "aac",
  duration: 5043.3,
};

type Props = Parameters<typeof useLocalSource>[0];

function harness(useWebCodecsDecoder: boolean) {
  const calls = {
    player: [] as string[],
    prep: [] as string[],
    logs: [] as string[],
  };
  const noop = () => {};
  const props = {
    defaults: { useWebCodecsDecoder, folder: "/out" },
    sourceSeqRef: { current: 0 },
    setMetadata: noop,
    setLocalFilePath: noop,
    setLocalFileSize: noop,
    setLocalPlayer: (v: unknown) => { calls.player.push(String(v)); },
    setSourceKind: noop,
    setStatus: noop,
    setErrorDetail: noop,
    setExportOpts: noop,
    setInFrames: noop,
    setOutFrames: noop,
    setUrl: noop,
    resetForNewSource: noop,
    tryAutoLoadTranscript: async () => {},
    recordRecentSource: noop,
    seedFilename: (_p: string, t: string) => t,
    runPlaybackPrep: async (p: string) => { calls.prep.push(p); },
    openSourceView: noop,
    appendLog: (_t: string, _s: string, m: string) => { calls.logs.push(m); },
  } as unknown as Props;
  const { result } = renderHook(() => useLocalSource(props));
  return { calls, load: result.current.loadLocalPath };
}

describe("the WebCodecs decoder toggle", () => {
  beforeEach(() => {
    // The probe spy below REPLACES the module export, and a replacement
    // outlives the test that made it: without this, the last case here read
    // the spy's hard-coded `true` instead of its own `canDecode = false` and
    // failed for a reason that had nothing to do with the code under test.
    vi.restoreAllMocks();
    h.canDecode = true;
    h.probe = ORDINARY;
  });

  it("ships ON, so mediabunny-first stays the default nobody opts into", async () => {
    const { calls, load } = harness(true);
    await load(ORDINARY.path);
    expect(calls.player).toContain("mediabunny");
    // The whole point of the default: no ffmpeg subprocess on import.
    expect(calls.prep, "the default must not transcode").toEqual([]);
  });

  it("actually routes playback to ffmpeg-prep when turned OFF", async () => {
    // The regression. Before the fix this asserted "mediabunny" — the toggle
    // was read for posters only, so playback ignored it completely.
    const { calls, load } = harness(false);
    await load(ORDINARY.path);
    expect(calls.player).toContain("native");
    expect(calls.player, "must not resolve to the decoder the user disabled")
      .not.toContain("mediabunny");
    expect(calls.prep, "the ffmpeg fallback never ran").toEqual([ORDINARY.path]);
  });

  it("does not probe mediabunny at all when the user has opted out", async () => {
    // Short-circuit, not probe-then-discard: opening the file to ask a decoder
    // a question whose answer is already irrelevant is pure latency on import.
    h.canDecode = true;
    let probed = false;
    const spy = await import("../lib/mediabunny-helpers");
    vi.spyOn(spy, "canMediabunnyDecode").mockImplementation(async () => {
      probed = true;
      return true;
    });
    const { load } = harness(false);
    await load(ORDINARY.path);
    expect(probed, "canMediabunnyDecode ran despite the toggle being off").toBe(false);
  });

  it("names the toggle as the reason, instead of a transcode with no cause", async () => {
    // h264/aac/.mp4 is native on every axis, so the reason list is empty and
    // the line used to render as "Transcoding for playback: ." — a wait with
    // no stated cause, which is how a deliberate setting reads as a bug.
    const { calls, load } = harness(false);
    await load(ORDINARY.path);
    const line = calls.logs.find((m) => m.startsWith("Transcoding for playback"));
    expect(line).toBeDefined();
    expect(line).toContain("WebCodecs decoder off in Settings");
    expect(line, "an empty reason list").not.toMatch(/playback: \.$/);
  });

  it("still falls back on its own when mediabunny cannot decode", async () => {
    // The automatic path is unchanged by any of this: toggle on, undecodable
    // file, ffmpeg-prep. Pinned so honouring the toggle did not become the
    // ONLY route to the fallback.
    h.canDecode = false;
    const { calls, load } = harness(true);
    await load(ORDINARY.path);
    expect(calls.player).toContain("native");
    expect(calls.prep).toEqual([ORDINARY.path]);
  });
});
