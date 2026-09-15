import { afterEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { describeShareStreamError } from "./share-stream-error";
const url = "http://127.0.0.1/t/private/share/v1?request=share-test";
afterEach(() => { vi.useRealTimers(); invoke.mockReset(); });
describe("bounded native share failure readback", () => {
  it("returns only the matching share diagnosis, not other media failures", async () => {
    const signal = new AbortController().signal, error = new Error("EOF");
    invoke.mockResolvedValue({ requestId: "share-test", kind: "share_capture_start_failed", message: "Capture refused." });
    expect(await describeShareStreamError(url, error, signal)).toMatchObject({ message: "Capture refused." });
    expect(invoke).toHaveBeenCalledWith("get_stream_failure", { requestId: "share-test" });
    invoke.mockResolvedValue({ requestId: "other", kind: "share_capture_start_failed", message: "Not ours" });
    expect(await describeShareStreamError(url, error, signal)).toBe(error);
    invoke.mockResolvedValue({ requestId: "share-test", kind: "upstream_rejection", message: "Not a share" });
    expect(await describeShareStreamError(url, error, signal)).toBe(error);
  });
  it("allows one delayed diagnostic result without restarting capture", async () => {
    vi.useFakeTimers(); invoke.mockResolvedValueOnce(null).mockResolvedValueOnce({ requestId: "share-test", kind: "share_capture_exited", message: "Capture exited." });
    const pending = describeShareStreamError(url, new Error("EOF"), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ message: "Capture exited." }); expect(invoke).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cannot hang startup on IPC or report an error after Stop", async () => {
    vi.useFakeTimers(); invoke.mockImplementation(() => new Promise(() => {}));
    const error = new Error("EOF"), abort = new AbortController();
    const pending = describeShareStreamError(url, error, abort.signal);
    await vi.advanceTimersByTimeAsync(250); expect(await pending).toBe(error);
    expect(vi.getTimerCount()).toBe(0);
    const cancelled = describeShareStreamError(url, error, abort.signal); abort.abort();
    expect(await cancelled).toBe(error); expect(vi.getTimerCount()).toBe(0);
  });
});
