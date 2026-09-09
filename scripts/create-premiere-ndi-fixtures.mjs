// Generated calibration media only. Does not open or modify a Premiere project.
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "sauce-premiere-calibration-"));
const binary = name => path.join(root, `src-tauri/binaries/${name}-aarch64-apple-darwin`);
const font = "/System/Library/Fonts/Supplemental/Arial.ttf";
const rates = [["23.976", "24000/1001"], ["24", "24/1"], ["25", "25/1"], ["29.97", "30000/1001"], ["30", "30/1"], ["60", "60/1"]];
const files = [];
function encode(name, rate, graph) {
  const output = path.join(directory, name);
  execFileSync(binary("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-nostdin", "-n",
    "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", "18", "-c:v", "h264_videotoolbox",
    "-b:v", "6000000", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough", "-video_track_timescale", rate.split("/")[0],
    "-c:a", "pcm_s16le", "-ar", "48000", "-movflags", "+faststart", output], { stdio: "inherit" });
  const { streams } = JSON.parse(execFileSync(binary("ffprobe"), ["-v", "error", "-show_streams", "-of", "json", output], { encoding: "utf8" }));
  const video = streams.find(s => s.codec_type === "video"), audio = streams.find(s => s.codec_type === "audio");
  assert.equal(video.width, 1920); assert.equal(video.height, 1080); assert.equal(video.avg_frame_rate, rate);
  assert.equal(audio.channels, 2); assert.equal(audio.sample_rate, "48000"); assert.equal(audio.codec_name, "pcm_s16le");
  files.push({ name, frameRate: rate, width: video.width, height: video.height, audio: "stereo 48 kHz PCM",
    durationSeconds: Number(video.duration), kind: name.startsWith("stereo") ? "channel-identification" : "av-sync" });
  console.log(`Created ${output}`);
}
for (const [label, rate] of rates) {
  // Zero intentional flash delay; beep is duplicated to both channels. The
  // separate channel-identification fixture below checks left/right mapping.
  encode(`av-sync-${label}fps.mov`, rate,
    `avsynctest=size=1920x1080:framerate=${rate}:samplerate=48000:duration=18:amplitude=0.2:period=3:delay=0[beep][picture];` +
    `[beep]pan=stereo|c0=c0|c1=c0[a];` +
    `[picture]drawtext=fontfile=${font}:text='Sauce Bunny calibration - ${label} fps - synchronized beep and flash':fontsize=34:fontcolor=white:x=40:y=40,` +
    `drawtext=fontfile=${font}:text='FRAME %{n}':fontsize=76:fontcolor=white:x=40:y=150[v]`);
}
encode("stereo-left-right-30fps.mov", "30/1",
  "color=c=black:s=1920x1080:r=30:d=18[picture];" +
  "aevalsrc=exprs='0.2*sin(2*PI*440*t)*lt(mod(t,4),2)|0.2*sin(2*PI*880*t)*gte(mod(t,4),2)':s=48000:d=18:c=stereo[a];" +
  `[picture]drawtext=fontfile=${font}:text='LEFT ONLY - 440 Hz':fontsize=80:fontcolor=white:x=120:y=400:enable='lt(mod(t,4),2)',` +
  `drawtext=fontfile=${font}:text='RIGHT ONLY - 880 Hz':fontsize=80:fontcolor=white:x=900:y=400:enable='gte(mod(t,4),2)',` +
  `drawtext=fontfile=${font}:text='Channels alternate every two seconds. Keep monitoring muted until ready.':fontsize=32:fontcolor=white:x=100:y=800[v]`);
await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), files }, null, 2) + "\n", { flag: "wx" });
console.log(`Calibration media ready: ${directory}`);
console.log("These are input fixtures, not test results. Use a separate Premiere project and create each sequence from its matching clip.");
