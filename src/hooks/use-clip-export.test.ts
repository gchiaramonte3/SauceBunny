// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useClipExport } from "./use-clip-export";

/**
 * The local-clip export core, testable for the first time.
 *
 * `runLocalClipExport` owns the shared cancel token, and that ownership is the
 * subtle part: Stop and a source switch both flip it, the queue runner and the
 * single Export button both call this, and the release in `finally` is
 * OWNERSHIP-CHECKED — blindly nulling would strand a concurrently started
 * export's Stop button. None of that had a test; it lived in the middle of a
 * 6,000-line component.
 *
 * The decode/encode work is mocked. What is being checked here is the
 * contract around it: which result shapes pass through untouched, that a
 * thrown error becomes a value rather than a rejection, and that the token is
 * installed and released correctly.
 */

const h = vi.hoisted(() => ({
  result: { kind: "ok", bytes: new Uint8Array([1, 2, 3]) } as unknown,
  exportCalls: [] as unknown[],
  invokeCalls: [] as Array<{ cmd: string }>,
  throwOnExport: null as Error | null,
}));

vi.mock("../lib/mediabunny-export", () => ({
  exportLocalClipViaMediabunny: async (args: unknown, token: { cancelled: boolean }) => {
    h.exportCalls.push({ args, token });
    if (h.throwOnExport) throw h.throwOnExport;
    return h.result;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    h.invokeCalls.push({ cmd });
    return "/out/clip-2.mp4";
  },
}));

type Deps = Parameters<typeof useClipExport>[0];

function deps(over: Partial<Deps> = {}): Deps {
  return {
    metadata: null, metadataRef: { current: null },
    sourceKind: "file", localFilePath: "/in/a.mov",
    exportOpts: { folder: "/out", filename: "clip", format: "video", reencode: false, inTc: "", outTc: "" },
    exportOptsRef: { current: { folder: "/out", filename: "clip", format: "video" } },
    fps: 25, inFrames: null, outFrames: null,
    sourceSeqRef: { current: 1 },
    localExportCancelRef: { current: null },
    clipJobMetaRef: { current: null },
    appendLog: vi.fn(), notify: vi.fn(), pushNotification: vi.fn(),
    classifyExtractorRot: vi.fn(), cookiesBrowserOrNone: () => undefined,
    setStatus: vi.fn(), setProgress: vi.fn(), setResultPath: vi.fn(),
    setErrorDetail: vi.fn(), setExportPhase: vi.fn(), setJobId: vi.fn(),
    setRecents: vi.fn(),
    ...over,
  } as unknown as Deps;
}

const ARGS = {
  inputPath: "/in/a.mov", startSeconds: 0, endSeconds: 1,
  format: "video-mp4" as const, destPath: "/out/clip.mp4", onProgress: vi.fn(),
};

beforeEach(() => {
  h.result = { kind: "ok", bytes: new Uint8Array([1, 2, 3]) };
  h.exportCalls.length = 0; h.invokeCalls.length = 0; h.throwOnExport = null;
});
afterEach(() => vi.clearAllMocks());

describe("runLocalClipExport", () => {
  it("writes the bytes and reports the path the backend chose", async () => {
    // The canary, and the uniquing contract: destPath is derived rather than
    // dialog-vetted, so a collision walks -2/-3 on disk and the FINAL path
    // comes back from the writer. Returning the requested path would name a
    // file that does not exist.
    const d = deps();
    const { result } = renderHook(() => useClipExport(d));
    const r = await result.current.runLocalClipExport(ARGS);
    expect(r).toEqual({ kind: "ok", bytesWritten: 3, finalPath: "/out/clip-2.mp4" });
    expect(h.invokeCalls.map((c) => c.cmd)).toEqual(["write_raw_to_path"]);
  });

  it("passes a cancel token through and installs it while running", async () => {
    const d = deps();
    const { result } = renderHook(() => useClipExport(d));
    await result.current.runLocalClipExport(ARGS);
    const call = h.exportCalls[0] as { token: { cancelled: boolean } };
    expect(call.token, "no cancel token reached the encoder").toBeTruthy();
    expect(call.token.cancelled).toBe(false);
  });

  it("releases the token when it finishes", async () => {
    const d = deps();
    const { result } = renderHook(() => useClipExport(d));
    await result.current.runLocalClipExport(ARGS);
    expect(d.localExportCancelRef.current, "a finished export left its token installed").toBeNull();
  });

  it("does NOT release a token another export installed", async () => {
    // The ownership check. Blindly nulling in `finally` would strand the Stop
    // button of an export that started while this one was finishing.
    const d = deps();
    const { result } = renderHook(() => useClipExport(d));
    const other = { cancelled: false };
    h.result = { kind: "ok", bytes: new Uint8Array([9]) };
    const running = result.current.runLocalClipExport(ARGS);
    d.localExportCancelRef.current = other;   // a second export takes ownership
    await running;
    expect(d.localExportCancelRef.current, "the other export's token was cleared").toBe(other);
  });

  it("passes 'unsupported' straight through, with no ffmpeg fallback", async () => {
    // Local clips deliberately have no fallback: the reason has to reach the
    // caller intact so the UI can say what went wrong.
    h.result = { kind: "unsupported", reason: "10-bit ProRes" };
    const d = deps();
    const { result } = renderHook(() => useClipExport(d));
    const r = await result.current.runLocalClipExport(ARGS);
    expect(r).toEqual({ kind: "unsupported", reason: "10-bit ProRes" });
    expect(h.invokeCalls, "an unsupported result still wrote a file").toHaveLength(0);
  });

  it("passes 'cancelled' through without writing", async () => {
    h.result = { kind: "cancelled" };
    const d = deps();
    const { result } = renderHook(() => useClipExport(d));
    const r = await result.current.runLocalClipExport(ARGS);
    expect(r).toEqual({ kind: "cancelled" });
    expect(h.invokeCalls).toHaveLength(0);
  });

  it("turns a thrown error into a value rather than a rejection", async () => {
    // Callers branch on `result.kind`; a rejection here would escape the queue
    // runner's loop and strand queueRunning, which is the one flag whose being
    // stuck disables the export button for the rest of the session.
    h.throwOnExport = new Error("decoder exploded");
    const d = deps();
    const { result } = renderHook(() => useClipExport(d));
    const r = await result.current.runLocalClipExport(ARGS);
    expect(r.kind).toBe("error");
    expect((r as { message: string }).message).toContain("decoder exploded");
    expect(d.localExportCancelRef.current, "a thrown export left its token installed").toBeNull();
  });
});
