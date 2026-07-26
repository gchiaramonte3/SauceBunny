import { Input, ALL_FORMATS, EncodedPacketSink, BufferSource as MBBufferSource } from "mediabunny";
import { readFileSync } from "node:fs";

const path = process.argv[2];
const bytes = readFileSync(path);
const input = new Input({ source: new MBBufferSource(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), formats: ALL_FORMATS });
const at = await input.getPrimaryAudioTrack();
const vt = await input.getPrimaryVideoTrack();

for (const [name, tr] of [["AUDIO", at], ["VIDEO", vt]]) {
  if (!tr) continue;
  const sink = new EncodedPacketSink(tr);
  let i = 0, firstTs = null, lastTs = null, lastDur = 0, n = 0, minTs = Infinity, maxTs = -Infinity;
  const head = [];
  for await (const p of sink.packets()) {
    if (i < 6) head.push({ i, ts: +p.timestamp.toFixed(6), dur: +p.duration.toFixed(6), type: p.type, bytes: p.byteLength });
    if (firstTs === null) firstTs = p.timestamp;
    lastTs = p.timestamp; lastDur = p.duration;
    if (p.timestamp < minTs) minTs = p.timestamp;
    if (p.timestamp > maxTs) maxTs = p.timestamp;
    i++; n++;
  }
  console.log(`--- ${name}: ${n} packets`);
  console.log("  head:", JSON.stringify(head));
  console.log("  first ts:", firstTs, " last ts:", lastTs, " last end:", lastTs + lastDur);
  console.log("  min ts:", minTs, " max ts:", maxTs);
}
