/**
 * A video stream does not have to start at zero, and the local player used to
 * assume it did.
 *
 * Builds an H.264 fixture with a deliberate start offset (the same shape as
 * Big Buck Bunny's h264/mp3 build, `start 0.066667`), then decodes it for real
 * in a browser and checks that the frame is found where the track says it
 * begins rather than at 0.
 *
 *   npm run harness:firstframe
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FFMPEG = path.join(ROOT, "src-tauri/binaries/ffmpeg-aarch64-apple-darwin");
const SAMPLE = path.join(HERE, "offset-start.mp4");

/** The offset is the whole point: two frames at 30fps, like the real file. */
const OFFSET = 0.066667;

if (!existsSync(SAMPLE)) {
  if (!existsSync(FFMPEG)) throw new Error(`no bundled ffmpeg at ${FFMPEG}`);
  console.log(`• building an H.264 fixture whose first frame is at ${OFFSET}s…`);
  const r = spawnSync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    // Shift every timestamp forward. ffprobe then reports `start 0.066667`,
    // which is exactly the condition that broke real playback.
    "-output_ts_offset", String(OFFSET),
    "-movflags", "+faststart", SAMPLE,
  ], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg could not build the fixture");
}

const server = await createServer({
  configFile: path.join(ROOT, "vite.config.ts"),
  root: ROOT,
  logLevel: "warn",
  server: { port: 5201, strictPort: true, host: "127.0.0.1" },
  plugins: [{
    name: "firstframe-sample",
    configureServer(s) {
      s.middlewares.use("/harness-firstframe/sample.mp4", (req, res) => {
        const size = statSync(SAMPLE).size;
        const range = req.headers.range;
        const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : size - 1;
          res.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
          });
          createReadStream(SAMPLE, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": size,
          });
          createReadStream(SAMPLE).pipe(res);
        }
      });
    },
  }],
});
await server.listen();

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("  [console]", m.text()); });
await page.goto("http://127.0.0.1:5201/harness-firstframe/probe.html", { waitUntil: "load" });
await page.waitForFunction(
  () => /RESULT/.test(document.getElementById("out")?.textContent ?? ""),
  null, { timeout: 60_000 },
);
const text = await page.locator("#out").textContent() ?? "";
console.log("\n" + text.split("\n").map((l) => "  " + l).join("\n") + "\n");

await browser.close();
await server.close();

const firstTs = Number(/firstTimestamp=([\d.]+)/.exec(text)?.[1] ?? "0");
let bad = 0;
if (!(firstTs > 0)) {
  console.log("✗ the fixture starts at 0, so this run proves nothing — check -output_ts_offset");
  bad = 1;
} else if (!/getCanvas\(0\)=null/.test(text)) {
  console.log("✗ getCanvas(0) returned a frame, so the trap this guards is gone — re-derive the test");
  bad = 1;
} else if (!/RESULT ok/.test(text)) {
  console.log("✗ no frame at the track's own first timestamp");
  bad = 1;
}
console.log(bad ? "✗ first-frame probe FAILED" : "✅ the first frame is found where the track says it is");
process.exit(bad);
