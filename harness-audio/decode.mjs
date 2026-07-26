// Node probe: run the REAL registered Opus custom decoder through mediabunny's
// AudioSampleSink over the same range runAudioLoop asks for.
import { Input, ALL_FORMATS, AudioSampleSink, BufferSource as MBBufferSource,
         CustomAudioDecoder, AudioSample, registerDecoder } from "mediabunny";
import { OpusDecoder } from "opus-decoder";
import { readFileSync } from "node:fs";

const OPUS_DECODE_RATE = 48000;
// ── verbatim copy of src/lib/mediabunny-decoders.ts parseOpusHead ──
function parseOpusHead(description, fallbackChannels) {
  const ch = Math.min(8, Math.max(1, fallbackChannels || 2));
  const fallback = { channels: ch, preSkip: 0, streamCount: 1, coupledStreamCount: ch >= 2 ? 1 : 0, channelMappingTable: undefined };
  if (!description) return fallback;
  const u8 = description instanceof Uint8Array ? description
    : ArrayBuffer.isView(description) ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  const magic = u8.length >= 8 && u8[0]===0x4f&&u8[1]===0x70&&u8[2]===0x75&&u8[3]===0x73&&u8[4]===0x48&&u8[5]===0x65&&u8[6]===0x61&&u8[7]===0x64;
  const o = magic ? 8 : 0;
  const le = magic;
  if (u8.length < o + 11) return fallback;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const channels = u8[o + 1] || ch;
  const preSkip = dv.getUint16(o + 2, le);
  const mappingFamily = u8[o + 10];
  if (mappingFamily === 0 || u8.length < o + 13 + channels) {
    return { channels, preSkip, streamCount: 1, coupledStreamCount: channels === 2 ? 1 : 0, channelMappingTable: undefined };
  }
  return { channels, preSkip, streamCount: u8[o+11], coupledStreamCount: u8[o+12], channelMappingTable: Array.from(u8.subarray(o+13, o+13+channels)) };
}
let initCalls = 0, decodeCalls = 0, emitted = 0, zeroSamples = 0, decodeErrors = 0;
let parsedCfg = null;
class OpusAudioDecoder extends CustomAudioDecoder {
  decoder = null;
  static supports(codec) { return codec === "opus"; }
  async init() {
    initCalls++;
    const cfg = parseOpusHead(this.config.description, this.config.numberOfChannels ?? 2);
    parsedCfg = cfg;
    this.decoder = new OpusDecoder({
      channels: cfg.channels, preSkip: cfg.preSkip, streamCount: cfg.streamCount,
      coupledStreamCount: cfg.coupledStreamCount, channelMappingTable: cfg.channelMappingTable,
    });
    await this.decoder.ready;
  }
  decode(packet) {
    decodeCalls++;
    const dec = this.decoder;
    if (!dec) return;
    let r;
    try { r = dec.decodeFrame(packet.data); }
    catch (e) { decodeErrors++; throw e; }
    const { channelData, samplesDecoded } = r;
    if (samplesDecoded <= 0 || channelData.length === 0) { zeroSamples++; return; }
    const channels = channelData.length;
    const planar = new Float32Array(channels * samplesDecoded);
    for (let c = 0; c < channels; c++) planar.set(channelData[c].subarray(0, samplesDecoded), c * samplesDecoded);
    emitted++;
    this.onSample(new AudioSample({ data: planar, format: "f32-planar", numberOfChannels: channels,
      sampleRate: OPUS_DECODE_RATE, timestamp: packet.timestamp }));
  }
  flush() {}
  close() { this.decoder?.free(); this.decoder = null; }
}
registerDecoder(OpusAudioDecoder);

const path = process.argv[2];
const from = Number(process.argv[3] ?? 0);
const bytes = readFileSync(path);
const input = new Input({ source: new MBBufferSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength)), formats: ALL_FORMATS });
const at = await input.getPrimaryAudioTrack();
const dur = await input.computeDuration();
console.log("canDecode:", await at.canDecode(), " duration:", dur);
const sink = new AudioSampleSink(at);

function measure(s) {
  const f = new Float32Array(s.allocationSize({ planeIndex: 0, format: "f32" }) / 4);
  s.copyTo(f, { planeIndex: 0, format: "f32" });
  let peak = 0, sumsq = 0;
  for (let i = 0; i < f.length; i++) { const v = Math.abs(f[i]); if (v > peak) peak = v; sumsq += f[i]*f[i]; }
  return { peak: +peak.toFixed(5), rms: +Math.sqrt(sumsq/Math.max(1,f.length)).toFixed(5) };
}

const t0 = Date.now();
let n = 0, firstMs = -1, silent = 0, globalPeak = 0;
const head = [], tail = [];
let err = null;
try {
  for await (const s of sink.samples(from, dur)) {
    if (firstMs < 0) firstMs = Date.now() - t0;
    const m = measure(s);
    if (m.peak <= 1e-5) silent++;
    if (m.peak > globalPeak) globalPeak = m.peak;
    const rec = { i: n, ts: +s.timestamp.toFixed(5), dur: +s.duration.toFixed(5), frames: s.numberOfFrames, sr: s.sampleRate, ch: s.numberOfChannels, ...m };
    if (n < 5) head.push(rec);
    tail.push(rec); if (tail.length > 3) tail.shift();
    n++; s.close();
  }
} catch (e) { err = String(e); }
console.log(JSON.stringify({
  from, delivered: n, firstBufferMs: firstMs, totalMs: Date.now()-t0, error: err,
  silentChunks: silent, globalPeak,
  initCalls, decodeCalls, emitted, zeroSamples, decodeErrors, parsedCfg,
  head, tail,
}, null, 2));
