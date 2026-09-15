import { describe, expect, it, vi } from "vitest";
import { requestCaptureThumbnail } from "./capture-thumbnail-queue";

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("shared thumbnail admission", () => {
  it("keeps obsolete in-flight slots occupied and removes queued hidden sources", async () => {
    const first = deferred(), second = deferred();
    const old = new AbortController(), hidden = new AbortController(), current = new AbortController();
    const a = requestCaptureThumbnail(old.signal, () => first.promise);
    const b = requestCaptureThumbnail(old.signal, () => second.promise);
    const hiddenCapture = vi.fn(async () => "hidden");
    const stale = requestCaptureThumbnail(hidden.signal, hiddenCapture);
    const staleError = expect(stale).rejects.toMatchObject({ name: "AbortError" });
    const currentCapture = vi.fn(async () => "current");
    const next = requestCaptureThumbnail(current.signal, currentCapture);
    old.abort(); hidden.abort();
    expect(currentCapture).not.toHaveBeenCalled(); expect(hiddenCapture).not.toHaveBeenCalled();
    first.resolve("obsolete");
    await expect(a).resolves.toBe("obsolete");
    await expect(next).resolves.toBe("current");
    await staleError;
    expect(currentCapture).toHaveBeenCalledOnce(); expect(hiddenCapture).not.toHaveBeenCalled();
    second.resolve("obsolete"); await b;
  });

  it("releases failed slots and never starts a pre-cancelled request", async () => {
    const signal = new AbortController().signal, first = deferred(), second = deferred();
    const a = requestCaptureThumbnail(signal, () => first.promise);
    const failure = expect(a).rejects.toThrow("Generated failure");
    const b = requestCaptureThumbnail(signal, () => second.promise);
    const next = requestCaptureThumbnail(signal, async () => "ready");
    first.reject(new Error("Generated failure"));
    await failure; await expect(next).resolves.toBe("ready");
    second.resolve("ready"); await b;
    const cancelled = new AbortController(); cancelled.abort();
    const capture = vi.fn(async () => "unexpected");
    await expect(requestCaptureThumbnail(cancelled.signal, capture)).rejects.toMatchObject({ name: "AbortError" });
    expect(capture).not.toHaveBeenCalled();
  });
});
