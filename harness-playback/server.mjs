// Localhost-only configuration/result collector. Media stays on the app's
// real Rust/FFmpeg proxy; delay/starvation is injected in the test frontend.
import { createServer } from "node:http";
import { statSync } from "node:fs";
const local = process.env.REVIEW_FILE;
const high = process.env.HIGH_FILE;
if (!local || !high) throw new Error("Set REVIEW_FILE and HIGH_FILE to matching local media.");
statSync(local); statSync(high);
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "tauri://localhost");
  const url = new URL(req.url, "http://127.0.0.1:5197");
  if (url.pathname === "/config") return res.end(JSON.stringify({ local, high, duration: Number(process.env.DURATION ?? 149), fps: Number(process.env.FPS ?? 24000 / 1001) }));
  if (url.pathname === "/result") {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    console.log(JSON.stringify({ report: JSON.parse(Buffer.concat(chunks).toString()) }));
    return res.end("ok");
  }
  res.statusCode = 404; res.end();
});
server.listen(5197, "127.0.0.1", () => console.log("Playback fixture listening on 127.0.0.1:5197"));
