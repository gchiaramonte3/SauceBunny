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
  /** Overrides the per-track decode answer. Null = derive it from canDecode,
   *  which is the all-or-nothing behaviour the older tests were written
   *  against. Set it to say "the picture is fine, the sound is not". */
  decodeProbe: null as null | { video: string; audio: string },
}));

vi.mock("../lib/mediabunny-helpers", () => ({
  // The hook asks WHICH track failed now, not merely whether one did, so that
  // it can remux instead of re-encoding when only the audio is undecodable.
  // `h.canDecode` still drives it: false means both tracks fail, which is the
  // old all-or-nothing behaviour these tests were written against.
  probeMediabunnyDecode: async () => h.decodeProbe ?? (h.canDecode
    ? { video: "ok", audio: "ok" }
    : { video: "undecodable", audio: "undecodable" }),
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
    /** Whether each prep was asked to COPY the video rather than re-encode it. */
    prepCopyVideo: [] as boolean[],
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
    runPlaybackPrep: async (p: string, _hv: boolean, _d: number | null, _seq: number, copyVideo?: boolean) => {
      calls.prep.push(p);
      calls.prepCopyVideo.push(copyVideo ?? false);
    },
    openSourceView: noop,
    appendLog: (_t: string, _s: string, m: string) => { calls.logs.push(m); },
  } as unknown as Props;
  const { result } = renderHook(() => useLocalSource(props));
  return { calls, load: result.current.loadLocalPath };
}

describe("the WebCodecs decoder toggle", () => {
  beforeEach(() => { h.decodeProbe = null; });
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
    vi.spyOn(spy, "probeMediabunnyDecode").mockImplementation(async () => {
      probed = true;
      return { video: "ok", audio: "ok" };
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

describe("only the audio is broken, so only the audio is re-encoded", () => {
  /**
   * The decode probe is an AND, so a file with good H.264 video and one
   * undecodable audio track failed the whole check and had EVERY FRAME
   * re-encoded through h264_videotoolbox to fix the SOUND. The hook's own
   * comment names that as the common case - AAC in WKWebView, which has no
   * AudioDecoder before Safari 26 - so the expensive path was the usual one.
   */
  beforeEach(() => {
    h.canDecode = false;
    h.decodeProbe = { video: "ok", audio: "undecodable" };
  });

  it("copies the video when the picture decodes and only the sound does not", async () => {
    h.probe = { ...ORDINARY, vcodec: "h264", acodec: "aac" };
    const { calls, load } = harness(true);
    await load(ORDINARY.path);
    expect(calls.prep, "the fallback did not run at all").toEqual([ORDINARY.path]);
    expect(calls.prepCopyVideo[0], "the video was re-encoded to fix the audio").toBe(true);
  });

  it("does NOT copy a codec the native player cannot open", async () => {
    // mediabunny decodes ProRes through turbores, so "the video is fine" does
    // not mean the NATIVE player can open it - and the native player is what
    // plays the prep output. Copying ProRes into an MP4 produces exactly the
    // black canvas this path exists to avoid.
    h.probe = { ...ORDINARY, vcodec: "prores", acodec: "pcm_s24le" };
    const { calls, load } = harness(true);
    await load(ORDINARY.path);
    expect(calls.prep).toEqual([ORDINARY.path]);
    expect(calls.prepCopyVideo[0], "a ProRes stream was copied into an MP4").toBe(false);
  });

  it("does NOT copy when the video itself is undecodable", async () => {
    h.decodeProbe = { video: "undecodable", audio: "ok" };
    h.probe = { ...ORDINARY, vcodec: "h264", acodec: "aac" };
    const { calls, load } = harness(true);
    await load(ORDINARY.path);
    expect(calls.prep).toEqual([ORDINARY.path]);
    expect(calls.prepCopyVideo[0]).toBe(false);
  });
});
