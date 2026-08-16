// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useCaptionsListeners } from "./use-captions-listeners";

/**
 * The second way a transcript arrives.
 *
 * Captions and Whisper are different pipelines that finish the same way: both
 * hand App `setActiveTranscript` plus a tick, and the Transcript tab does not
 * care which produced the SRT. That shared ending is exactly what used to be
 * cited as the reason captions could not be a hook; it is now expressed as two
 * hooks handed the same pair.
 *
 * The history record is the part worth pinning. A fetched caption track has to
 * land in the transcript history like a generated one — same de-dup key, same
 * popover — or re-importing the source silently offers nothing.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlistened: 0,
  recorded: [] as unknown[],
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return () => { h.unlistened += 1; };
  },
}));
vi.mock("../lib/transcript-history", () => ({
  recordTranscript: (e: unknown) => { h.recorded.push(e); },
}));

const JOB = "cap-1";

function deps() {
  return {
    appendLog: vi.fn(),
    setCaptionsState: vi.fn(),
    setCaptionsError: vi.fn(),
    setActiveTranscript: vi.fn(),
    setTranscriptArrivedTick: vi.fn(),
    captionsJobIdRef: { current: JOB as string | null },
    clipSourceKeyRef: { current: "src-key" as string | null },
    metadataRef: { current: { title: "A Talk", webpage_url: "https://y.tld/1" } },
  } as unknown as Parameters<typeof useCaptionsListeners>[0];
}

async function mount() {
  const d = deps();
  const r = renderHook(() => useCaptionsListeners(d));
  await waitFor(() => expect(h.handlers.has("captions-done")).toBe(true));
  return { d, ...r };
}
const fire = (n: string, payload: unknown) => h.handlers.get(n)!({ payload });

beforeEach(() => { h.handlers.clear(); h.unlistened = 0; h.recorded.length = 0; });
afterEach(() => vi.clearAllMocks());

describe("subscription", () => {
  it("registers both caption channels and cleans them up", async () => {
    const { unmount } = await mount();
    expect([...h.handlers.keys()].sort()).toEqual(["captions-done", "captions-log"]);
    unmount();
    await waitFor(() => expect(h.unlistened).toBe(2));
  });
});

describe("captions-done", () => {
  it("loads the SRT into the Transcript tab, tagged as captions", async () => {
    // The origin matters: the reader shows a different provenance line for a
    // fetched track than for one Whisper produced.
    const { d } = await mount();
    fire("captions-done", { job_id: JOB, success: true, path: "/T/a.en.srt" });
    expect(d.setCaptionsState).toHaveBeenCalledWith("done");
    expect(d.setActiveTranscript).toHaveBeenCalledWith(
      { path: "/T/a.en.srt", origin: "captions", sourceKey: "src-key" });
    expect(d.setTranscriptArrivedTick).toHaveBeenCalled();
  });

  it("records it in history with the source's URL, not just the file", async () => {
    // A web source is keyed by URL in the history; recording only the path
    // would make a re-import fail to find it.
    const { d } = await mount();
    fire("captions-done", { job_id: JOB, success: true, path: "/T/a.en.srt" });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({
      srtPath: "/T/a.en.srt", origin: "captions", sourceUrl: "https://y.tld/1", title: "A Talk",
    });
    expect(d.setCaptionsError).toHaveBeenCalledWith(null);
  });

  it("reports a failure without loading anything", async () => {
    const { d } = await mount();
    fire("captions-done", { job_id: JOB, success: false, error: "no captions available" });
    expect(d.setCaptionsState).toHaveBeenCalledWith("error");
    expect(d.setActiveTranscript).not.toHaveBeenCalled();
    expect(h.recorded).toHaveLength(0);
  });

  it("ignores an event for a different job", async () => {
    const { d } = await mount();
    fire("captions-done", { job_id: "other", success: true, path: "/T/x.srt" });
    expect(d.setCaptionsState).not.toHaveBeenCalled();
    expect(h.recorded).toHaveLength(0);
  });
});

describe("captions-log", () => {
  it("routes lines to the captions channel", async () => {
    const { d } = await mount();
    fire("captions-log", { job_id: JOB, tag: "info", line: "[info] writing subtitles" });
    expect(d.appendLog).toHaveBeenCalledWith("info", "captions", "[info] writing subtitles");
  });

  it("is job-gated too, so a stale run cannot write into a live log", async () => {
    // This gate had no test until a break-test aimed at the done-handler
    // happened to hit THIS one instead and nothing failed. Two identical
    // guards, one of them unexercised, is exactly the shape that survives a
    // careless edit.
    const { d } = await mount();
    fire("captions-log", { job_id: "other", tag: "info", line: "from a dead run" });
    expect(d.appendLog).not.toHaveBeenCalled();
  });
});
