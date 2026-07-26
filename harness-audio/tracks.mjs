import { Input, ALL_FORMATS } from "mediabunny";
import { readFileSync } from "node:fs";
import { BufferSource as MBBufferSource } from "mediabunny";

const path = process.argv[2];
const bytes = readFileSync(path);
const input = new Input({ source: new MBBufferSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), formats: ALL_FORMATS });
const fmt = await input.getFormat();
const all = await input.getTracks();
const vt = await input.getPrimaryVideoTrack();
const at = await input.getPrimaryAudioTrack();
const dur = await input.computeDuration();
console.log("format:", fmt?.name);
console.log("duration:", dur);
console.log("all tracks:", all.length);
for (const t of all) {
  console.log("  track", t.id, t.type, await t.getCodec(), "lang=", t.languageCode);
}
console.log("primary video:", vt ? await vt.getCodec() : null);
console.log("primary audio:", at ? await at.getCodec() : null);
if (at) {
  const cfg = await at.getDecoderConfig();
  console.log("audio decoderConfig:", JSON.stringify({
    codec: cfg?.codec, sampleRate: cfg?.sampleRate, ch: cfg?.numberOfChannels,
    descLen: cfg?.description ? (ArrayBuffer.isView(cfg.description) ? cfg.description.byteLength : cfg.description.byteLength) : 0,
  }));
  const d = cfg?.description;
  if (d) {
    const u8 = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
    console.log("desc hex:", Array.from(u8.subarray(0,32)).map(x=>x.toString(16).padStart(2,"0")).join(" "));
    console.log("desc ascii:", String.fromCharCode(...u8.subarray(0,8)).replace(/[^\x20-\x7e]/g,"."));
  }
  console.log("audio numberOfChannels:", at.numberOfChannels, "sampleRate:", at.sampleRate);
  console.log("audio timeResolution:", at.timeResolution);
  const first = await at.getFirstTimestamp();
  console.log("audio firstTimestamp:", first);
  console.log("audio computeDuration:", await at.computeDuration());
}
if (vt) {
  console.log("video firstTimestamp:", await vt.getFirstTimestamp(), "dur:", await vt.computeDuration());
}
