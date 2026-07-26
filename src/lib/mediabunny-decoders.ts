import {
  CustomAudioDecoder, AudioSample, registerDecoder,
  type AudioCodec, type EncodedPacket,
} from "mediabunny";
import { OpusDecoder } from "opus-decoder";
import { registerProresDecoder } from "@mediabunny/prores";

/**
 * Custom audio + video decoders registered with mediabunny so local playback
 * can be mediabunny-first even when WKWebView's WebCodecs can't do the codec
 * (see CLAUDE.md "Media playback path"). mediabunny's built-in decode goes
 * through WebCodecs; `registerDecoder` lets us polyfill a codec WebCodecs lacks,
 * and `track.canDecode()` then reports it decodable — so MediaBunnyPlayer /
 * CanvasSink play the file in-app with NO ffmpeg transcode.
 *
 * **Opus** (audio): modern YouTube downloads are AV1 video (which WKWebView's
 * WebCodecs CAN decode) + Opus audio (which it can't); without this the whole
 * file bounces to a full ffmpeg re-encode just to hear it. A tiny WASM libopus
 * (the MIT `opus-decoder`, WASM inlined → fully local) closes that gap. We own
 * this `CustomAudioDecoder` because no upstream adapter exists.
 *
 * **ProRes** (video): WKWebView's WebCodecs can't decode ProRes at all, so a
 * ProRes file (the dominant Mac editing/intermediate codec) would otherwise
 * always transcode. mediabunny 1.50 demuxes ProRes but ships no decoder; the
 * official `@mediabunny/prores` adapter supplies one backed by turbores (a
 * pure-WASM ProRes decoder, MPL-2.0, WASM inlined → fully local). We use the
 * adapter rather than hand-wiring turbores because it carries the WebKit
 * height-trim fix (bug 317524), dynamic VideoFrame pixel-format probing, color
 * space + pixel-aspect handling, and auto shared-memory detection — all of
 * which a hand-rolled `CustomVideoDecoder` would miss in WKWebView.
 *
 * Scope: this only adds DECODE capability to mediabunny's reader/player path.
 * It does not touch the web-streaming pipeline (MSEStreamPlayer / stream_proxy),
 * which remuxes through ffmpeg and never decodes via mediabunny.
 */

/** Opus is always decoded at 48 kHz regardless of the container's stated rate. */
const OPUS_DECODE_RATE = 48000;

type OpusConfig = {
  channels: number;
  preSkip: number;
  streamCount: number;
  coupledStreamCount: number;
  channelMappingTable: number[] | undefined;
};

/**
 * Parse the Opus init header into the params libopus needs. Handles both the
 * Ogg-style `OpusHead` (8-byte magic, little-endian fields — what WebCodecs
 * hands us) and the raw ISOBMFF `dOps` payload (no magic, big-endian fields).
 * Falls back to a sane mono/stereo config if the header is missing or short.
 */
function parseOpusHead(
  description: AllowSharedBufferSource | undefined | null,
  fallbackChannels: number,
): OpusConfig {
  const ch = Math.min(8, Math.max(1, fallbackChannels || 2));
  const fallback: OpusConfig = {
    channels: ch, preSkip: 0, streamCount: 1,
    coupledStreamCount: ch >= 2 ? 1 : 0, channelMappingTable: undefined,
  };
  if (!description) return fallback;

  const u8 = description instanceof Uint8Array
    ? description
    : ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : new Uint8Array(description);

  const magic = u8.length >= 8 &&
    u8[0] === 0x4f && u8[1] === 0x70 && u8[2] === 0x75 && u8[3] === 0x73 &&
    u8[4] === 0x48 && u8[5] === 0x65 && u8[6] === 0x61 && u8[7] === 0x64; // "OpusHead"
  const o = magic ? 8 : 0;
  const le = magic; // OpusHead is little-endian; dOps is big-endian
  if (u8.length < o + 11) return fallback;

  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const channels = u8[o + 1] || ch;
  const preSkip = dv.getUint16(o + 2, le);
  const mappingFamily = u8[o + 10];

  if (mappingFamily === 0 || u8.length < o + 13 + channels) {
    return {
      channels, preSkip, streamCount: 1,
      coupledStreamCount: channels === 2 ? 1 : 0, channelMappingTable: undefined,
    };
  }
  return {
    channels, preSkip,
    streamCount: u8[o + 11],
    coupledStreamCount: u8[o + 12],
    channelMappingTable: Array.from(u8.subarray(o + 13, o + 13 + channels)),
  };
}

class OpusAudioDecoder extends CustomAudioDecoder {
  private decoder: OpusDecoder | null = null;

  static supports(codec: AudioCodec): boolean {
    return codec === "opus";
  }

  async init(): Promise<void> {
    const cfg = parseOpusHead(this.config.description, this.config.numberOfChannels ?? 2);
    this.decoder = new OpusDecoder({
      channels: cfg.channels,
      preSkip: cfg.preSkip,
      streamCount: cfg.streamCount,
      coupledStreamCount: cfg.coupledStreamCount,
      channelMappingTable: cfg.channelMappingTable,
    });
    // Bounded, ALWAYS. opus-decoder's bootstrap resolves or parks - it has no
    // rejection path - so a blocked WebAssembly instantiate leaves `ready`
    // pending forever. mediabunny then queues every decode behind this init,
    // the audio loop awaits a generator that never yields, and the file plays
    // silently with no error on any layer. A REJECTION is recoverable:
    // mediabunny surfaces it, MediaBunnyPlayer turns it into the
    // [WEBCODECS_UNSUPPORTED] sentinel, and App transcodes with ffmpeg and
    // plays the file WITH sound.
    await Promise.race([
      this.decoder.ready,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("Opus WASM decoder did not start within 3s (WebAssembly may be blocked)")),
        3000,
      )),
    ]);
  }

  decode(packet: EncodedPacket): void {
    const dec = this.decoder;
    if (!dec) return;
    const { channelData, samplesDecoded } = dec.decodeFrame(packet.data);
    if (samplesDecoded <= 0 || channelData.length === 0) return;

    // mediabunny / WebCodecs want one buffer per AudioSample; f32-planar lays
    // the channels back-to-back (all of ch0, then all of ch1, …).
    const channels = channelData.length;
    const planar = new Float32Array(channels * samplesDecoded);
    for (let c = 0; c < channels; c++) {
      planar.set(channelData[c].subarray(0, samplesDecoded), c * samplesDecoded);
    }

    this.onSample(new AudioSample({
      data: planar,
      format: "f32-planar",
      numberOfChannels: channels,
      sampleRate: OPUS_DECODE_RATE,
      timestamp: packet.timestamp,
    }));
  }

  flush(): void {
    // decodeFrame is synchronous and per-packet — nothing is buffered.
  }

  close(): void {
    this.decoder?.free();
    this.decoder = null;
  }
}

let registered = false;

/** Register Sauce Bunny's custom mediabunny decoders (audio + video).
 *  Idempotent; call once at startup. */
export function registerLocalDecoders(blobWorkerOk = true): void {
  if (registered) return;
  registered = true;
  registerDecoder(OpusAudioDecoder); // libopus (we own this)
  // turbores spawns its Workers from blob: URLs. Without that permission it
  // does not fail - getCanvas() simply never settles (measured: still pending
  // after 40s), which strands the player with neither onReady nor onError.
  if (blobWorkerOk) registerProresDecoder();
}
