import { afterEach, describe, expect, it, vi } from "vitest";
import { supportedVideoDecoderOptions } from "./video-decoder-options";

const config: VideoDecoderConfig = { codec: "avc1.4d4028", codedWidth: 1920, codedHeight: 1080 };
afterEach(() => vi.unstubAllGlobals());

describe("supported video decoder preferences", () => {
  it("keeps low-latency hardware decoding when the exact configuration is supported", async () => {
    const check = vi.fn().mockResolvedValue({ supported: true });
    vi.stubGlobal("VideoDecoder", { isConfigSupported: check });
    const options = await supportedVideoDecoderOptions(config);
    expect(options).toEqual({ hardwareAcceleration: "prefer-hardware", optimizeForLatency: true });
    expect(check).toHaveBeenCalledExactlyOnceWith({ ...config, ...options });
  });

  it("lets the browser select its decoder when hardware preference is unsupported", async () => {
    const check = vi.fn().mockResolvedValueOnce({ supported: false }).mockResolvedValueOnce({ supported: true });
    vi.stubGlobal("VideoDecoder", { isConfigSupported: check });
    expect(await supportedVideoDecoderOptions(config)).toEqual({ hardwareAcceleration: "no-preference", optimizeForLatency: true });
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("uses MediaBunny defaults when both optional configurations are unsupported", async () => {
    vi.stubGlobal("VideoDecoder", { isConfigSupported: vi.fn().mockResolvedValue({ supported: false }) });
    expect(await supportedVideoDecoderOptions(config)).toEqual({});
  });

  it("does not condemn a track when a capability query throws", async () => {
    vi.stubGlobal("VideoDecoder", { isConfigSupported: vi.fn().mockRejectedValue(new Error("Unavailable")) });
    expect(await supportedVideoDecoderOptions(config)).toEqual({});
  });

  it("leaves custom decoders available without WebCodecs", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    expect(await supportedVideoDecoderOptions(config)).toEqual({});
  });

  it("does not query WebCodecs without a native configuration", async () => {
    const check = vi.fn();
    vi.stubGlobal("VideoDecoder", { isConfigSupported: check });
    expect(await supportedVideoDecoderOptions(null)).toEqual({});
    expect(check).not.toHaveBeenCalled();
  });
});
