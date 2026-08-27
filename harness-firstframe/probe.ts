/**
 * Does the local player look for the first frame where it actually is?
 *
 * MediaBunnyPlayer used to paint its opening frame with `getCanvas(0)` and
 * treat a null as proof the platform could not decode the codec. A video
 * stream is not obliged to start at zero: Big Buck Bunny's h264/mp3 build
 * starts at 0.066667s, two frames at 30fps, which ffprobe prints as
 * `start 0.066667`. So an ordinary H.264 file reported
 * "WebCodecs doesn't support avc" and was sent to a ten-minute
 * h264_videotoolbox re-encode it never needed.
 *
 * This decodes for real, in a real browser, against a fixture built with a
 * deliberate start offset. A mocked sink would have happily returned a frame
 * at 0 and proved nothing.
 */
import { Input, UrlSource, CanvasSink, ALL_FORMATS } from "mediabunny";

const out = document.getElementById("out")!;
const log: string[] = [];
const say = (s: string) => { log.push(s); out.textContent = log.join("\n"); };

try {
  const input = new Input({ source: new UrlSource("/harness-firstframe/sample.mp4"), formats: ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error("no video track in the fixture");

  const codec = await vt.getCodec().catch(() => "unknown");
  const firstTs = await vt.getFirstTimestamp();
  say(`codec=${codec}`);
  say(`firstTimestamp=${firstTs.toFixed(6)}`);

  const sink = new CanvasSink(vt, { poolSize: 2 });

  // The trap: the old probe asked here.
  const atZero = firstTs > 0 ? await sink.getCanvas(0).catch(() => null) : "n/a";
  say(`getCanvas(0)=${atZero === "n/a" ? "n/a" : atZero ? "frame" : "null"}`);

  // The fix: ask where the track says it begins.
  const atFirst = await sink.getCanvas(firstTs);
  say(`getCanvas(firstTimestamp)=${atFirst ? "frame" : "null"}`);

  say(atFirst ? "RESULT ok" : "RESULT fail");
} catch (e) {
  say(`RESULT fail ${e instanceof Error ? e.message : String(e)}`);
}
