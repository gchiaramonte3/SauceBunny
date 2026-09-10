import { createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { ProxyPresentationPlayer } from "../src/components/ProxyPresentationPlayer";
import type { PlayerHandle } from "../src/components/player-handle";
import type { ResolvedPresentationSource } from "../src/bindings/ResolvedPresentationSource";
import type { Metadata } from "../src/bindings/Metadata";
import type { SafariCookieAccess } from "../src/bindings/SafariCookieAccess";
import type { YtdlpStatus } from "../src/bindings/YtdlpStatus";
import "../src/styles/app.css";

const origin = "http://127.0.0.1:5197";
const config = await fetch(`${origin}/config`).then((r) => r.json());
const registered = await invoke<{ id: string; url: string }>("peer_media_register", { path: config.high });
// Only this test uses the local-file FFmpeg route. Production CDN URLs retain
// their SSRF protection; no local-origin allowlist is added to the application.
const source: ResolvedPresentationSource = { kind: "split", videoUrl: registered.url,
  audioUrl: "", expiresAt: Date.now() / 1000 + 3600,
  width: 1920, height: 1080, videoCodec: "avc1.640028", audioCodec: "mp4a.40.2" };
const player = createRef<PlayerHandle>();
const logs: { tag: string; message: string }[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const originalFetch = window.fetch.bind(window);
let slow = true;
let starve = false;
window.fetch = async (input, init) => {
  if (String(input).includes("/fmp4/v1/") && slow) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException("Cancelled", "AbortError")); };
      const timer = setTimeout(() => { init?.signal?.removeEventListener("abort", abort); resolve(); }, 1800);
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  }
  const response = await originalFetch(input, init);
  if (!String(input).includes("/fmp4/v1/") || !response.body) return response;
  let delivered = 0;
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (starve && delivered >= 1_500_000) {
        await new Promise<void>((_, reject) => {
          const abort = () => reject(new DOMException("Cancelled", "AbortError"));
          if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      delivered += chunk.length; controller.enqueue(chunk);
    },
  }));
  return new Response(stream, { status: response.status, headers: response.headers });
};
const analyzers: AnalyserNode[] = [];
// Passive analysis branch; the existing connection to the audio destination
// is untouched. This measures rendered PCM, not a claim about speaker output.
const connect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (...args: Parameters<typeof connect>) {
  const result = connect.apply(this, args);
  if (args[0] instanceof AudioDestinationNode) {
    const analyzer = this.context.createAnalyser(); analyzer.fftSize = 256;
    connect.call(this, analyzer); analyzers.push(analyzer);
  }
  return result;
} as typeof connect;
const samples = new Float32Array(256);
function audioActive() {
  return analyzers.some((node) => { node.getFloatTimeDomainData(samples);
    return samples.some((sample) => Math.abs(sample) > 0.001); });
}
const sample = document.createElement("canvas"); sample.width = 32; sample.height = 18;
const ctx = sample.getContext("2d", { willReadFrequently: true })!;
function pictureHash() {
  const canvas = document.querySelector(".cp-playback-proxy canvas") as HTMLCanvasElement | null;
  if (!canvas?.width) return 0;
  ctx.drawImage(canvas, 0, 0, 32, 18);
  return ctx.getImageData(0, 0, 32, 18).data.reduce((hash, value) => ((hash << 5) - hash + value) | 0, 0);
}
const percentile95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
function App() {
  const [ready, setReady] = useState(false);
  const [presentation, setPresentation] = useState<ResolvedPresentationSource | null>(null);
  const [status, setStatus] = useState("Opening completed review copy…");
  const [running, setRunning] = useState(false);
  async function checkAcquisition() {
    setRunning(true); setStatus("Checking app-launched downloader and Safari access; no permission settings are changed…");
    try {
      const access = await invoke<SafariCookieAccess>("safari_fda_status");
      const backend = await invoke<string>("get_backend_build_id");
      const engine = await invoke<YtdlpStatus>("ytdlp_version");
      // The public URL from the reported failure. Only public-first metadata,
      // never a second media download or an exported browser cookie file.
      const metadata = await invoke<Metadata>("fetch_metadata", { url: "https://www.youtube.com/watch?v=18NJ_Kt89E4", cookiesBrowser: "safari" });
      const report = { check: "native public-first acquisition", access, backend, engine,
        width: metadata.width, height: metadata.height, fps: metadata.fps, duration: metadata.duration };
      await fetch(`${origin}/result`, { method: "POST", body: JSON.stringify(report) });
      setStatus(`Safari: ${access} · public metadata loaded · yt-dlp ${engine.version}`);
    } catch (error) {
      setStatus(`Acquisition check: ${String(error)}`);
      await fetch(`${origin}/result`, { method: "POST", body: JSON.stringify({ check: "native acquisition", error: String(error) }) });
    } finally { setRunning(false); }
  }
  async function checkRecovery() {
    setRunning(true); slow = true; starve = false;
    const waitUntil = async (condition: () => boolean, timeout: number) => {
      const start = performance.now();
      while (!condition()) { if (performance.now() - start > timeout) throw new Error("Native recovery check timed out"); await sleep(20); }
    };
    try {
      player.current!.pause();
      setPresentation(source);
      player.current!.beginScrub(); player.current!.scrubTo(43);
      await player.current!.endScrub(43);
      const parked = player.current!.getCurrentTime();
      await player.current!.play();
      if (player.current!.supportsPlaybackRate) throw new Error("Expected local-first playback with delayed quality");
      setStatus("Local playback running; waiting for synchronized automatic high-resolution upgrade…");
      await waitUntil(() => !!player.current!.supportsPlaybackRate, 25000);
      if (!player.current!.isPlaying()) throw new Error("Automatic promotion paused playback");
      starve = true;
      setStatus("High quality playing; withholding delivery until native waiting fires…");
      const started = performance.now();
      await waitUntil(() => !player.current!.supportsPlaybackRate && player.current!.isPlaying(), 45000);
      await waitUntil(audioActive, 2000);
      const report = { check: "native automatic running promotion and genuine buffer starvation", parked,
        fallbackAfterMs: performance.now() - started, fallbackPosition: player.current!.getCurrentTime(), logs };
      await fetch(`${origin}/result`, { method: "POST", body: JSON.stringify(report) });
      setStatus("Passed: automatic running promotion, genuine waiting → local picture and rendered audio.");
    } catch (error) {
      const video = document.querySelector("video")!;
      const report = { check: "native recovery", error: String(error), logs,
        media: video ? { time: video.currentTime, readyState: video.readyState, seeking: video.seeking,
          error: video.error?.code, buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]) } : null };
      setStatus(String(error)); await fetch(`${origin}/result`, { method: "POST", body: JSON.stringify(report) });
    } finally { player.current!.pause(); setRunning(false); }
  }
  async function run() {
    setRunning(true); slow = true; starve = false; setPresentation(null);
    const runs: { target: number; mode: string; frameMs: number; audioMs: number; seekMs: number }[] = [];
    try {
      // First warm both real decoders/audio context in the user gesture.
      await player.current!.play(); await sleep(800); player.current!.pause(); await sleep(200);
      for (let i = 0; i < 20; i++) {
        const target = [43, 67.8, 105.7, 68.3, 20][i % 5];
        if (i === 10) { setPresentation(source); await sleep(20); }
        player.current!.beginScrub(); player.current!.scrubTo(target);
        const seeking = performance.now();
        const landed = await player.current!.endScrub(target);
        if (landed.status !== "presented") throw new Error(`Local seek ${target}: ${landed.status}`);
        const seekMs = performance.now() - seeking;
        await sleep(160); // clear the preceding PCM window; NOT part of Play
        const before = pictureHash(), start = performance.now();
        let frameMs = -1, audioMs = -1;
        void player.current!.play();
        while (performance.now() - start < 2000 && (frameMs < 0 || audioMs < 0)) {
          await new Promise(requestAnimationFrame);
          if (frameMs < 0 && pictureHash() !== before) frameMs = performance.now() - start;
          if (audioMs < 0 && audioActive()) audioMs = performance.now() - start;
        }
        if (frameMs < 0 || audioMs < 0) throw new Error(`No advancing picture/audio in run ${i + 1}`);
        runs.push({ target, mode: i < 10 ? "unresolved" : "high-quality fetch delayed 1800ms", frameMs, audioMs, seekMs });
        await sleep(300);
        player.current!.pause(); await sleep(120);
        setStatus(`Warm-cache resume ${i + 1}/20 · frame ${frameMs.toFixed(1)} ms · PCM ${audioMs.toFixed(1)} ms`);
      }
      const report = { userAgent: navigator.userAgent, runs, frameP95: percentile95(runs.map((r) => r.frameMs)),
        audioP95: percentile95(runs.map((r) => r.audioMs)), logs };
      slow = false;
      await fetch(`${origin}/result`, { method: "POST", body: JSON.stringify(report) });
      setStatus(`Done · picture p95 ${report.frameP95.toFixed(1)} ms · rendered PCM p95 ${report.audioP95.toFixed(1)} ms`);
    } catch (error) {
      setStatus(String(error)); await fetch(`${origin}/result`, { method: "POST", body: JSON.stringify({ error: String(error), runs, logs }) });
    } finally { player.current!.pause(); setRunning(false); }
  }
  return <main style={{ padding: 24 }}><h2>Packaged WKWebView playback test</h2><p>{status}</p>
    <button disabled={!ready || running} onClick={() => void run()}>Run 20 warm-cache resumes</button>
    <button disabled={!ready || running} onClick={() => void checkRecovery()}>Check buffered promotion and starvation</button>
    <button disabled={running} onClick={() => void checkAcquisition()}>Check public acquisition and Safari access</button>
    <div style={{ position: "relative", width: "100%", height: 540, marginTop: 20 }}>
      <ProxyPresentationPlayer ref={player} proxyPath={config.local} presentation={presentation} initialVolume={.12}
        fps={config.fps} knownDuration={config.duration} scrubAudio={false}
        onReady={() => { setReady(true); setStatus("Ready. Uses the real local decoder and Rust streaming proxy."); }}
        onDiag={(tag, message) => logs.push({ tag, message })}
        onAudioDiag={(tag, message) => logs.push({ tag, message })}
        onError={(message) => setStatus(message)} />
    </div></main>;
}
createRoot(document.getElementById("root")!).render(<App />);
