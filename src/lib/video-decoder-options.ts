import type { VideoSinkDecoderOptions } from "mediabunny";

/** Track.canDecode() checks the default config, not CanvasSink's overrides.
 * Unsupported hardware/latency preferences must not turn a decodable file
 * into an FFmpeg transcode. Custom/WASM decoders retain their normal path. */
export async function supportedVideoDecoderOptions(
  config: VideoDecoderConfig | null,
): Promise<VideoSinkDecoderOptions> {
  if (!config || typeof VideoDecoder === "undefined") return {};
  const candidates: VideoSinkDecoderOptions[] = [
    { hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
    { hardwareAcceleration: "no-preference", optimizeForLatency: true },
  ];
  for (const options of candidates) {
    try {
      if ((await VideoDecoder.isConfigSupported({ ...config, ...options })).supported) return options;
    } catch { /* A rejected preference does not reject the track's default decoder. */ }
  }
  return {};
}
