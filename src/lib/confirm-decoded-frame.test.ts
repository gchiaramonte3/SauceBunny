import { describe, expect, it, vi } from "vitest";
import { confirmDecodedFrame } from "./confirm-decoded-frame";

describe("decoded frame confirmation under a paused/covered compositor", () => {
  function fixture() {
    let frame!: VideoFrameRequestCallback;
    const media = { currentTime: 68, readyState: 2, seeking: false, videoWidth: 1920,
      requestVideoFrameCallback: vi.fn((cb: VideoFrameRequestCallback) => { frame = cb; return 7; }),
      cancelVideoFrameCallback: vi.fn(),
    };
    const confirm = vi.fn();
    const current = vi.fn(() => true);
    const cancel = confirmDecodedFrame(media as unknown as HTMLMediaElement, current, confirm);
    return { media, confirm, current, cancel, frame: (time: number) => frame(0, { mediaTime: time } as VideoFrameCallbackMetadata) };
  }
  it("settles decoded media without a timer when a hidden video never delivers rVFC", async () => {
    const h = fixture();
    await Promise.resolve();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(68);
    expect(h.media.cancelVideoFrameCallback).toHaveBeenCalledWith(7);
  });
  it("prefers the compositor's frame timestamp and settles only once", async () => {
    const h = fixture(); h.frame(67.984);
    await Promise.resolve();
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(67.984);
  });
  it.each(["loading", "seeking", "no picture", "superseded", "cancelled"])("never confirms %s media", async (state) => {
    const h = fixture();
    if (state === "loading") h.media.readyState = 1;
    if (state === "seeking") h.media.seeking = true;
    if (state === "no picture") h.media.videoWidth = 0;
    if (state === "superseded") h.current.mockReturnValue(false);
    if (state === "cancelled") h.cancel();
    h.frame(68); await Promise.resolve();
    expect(h.confirm).not.toHaveBeenCalled();
  });
});
