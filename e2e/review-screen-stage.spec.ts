import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

const FILE = "/e2e-mock/generated-review.mp4";
const TRANSCRIPT = "/e2e-mock/generated-review.srt";
type PlayerCall = { method: string; value?: number };
type Fixture = {
  __screenStage: {
    calls: PlayerCall[]; native: string[]; opens: number; closes: number; rejectedSeeks: number;
    player: { playing: boolean; time: number; latePlaying: () => void; lateTime: (time: number) => void };
    stream: MediaStream | null;
  };
  __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
  __TAURI_MOCK__: { emitTauriEvent: (event: string, payload: unknown) => void };
};

/** Only decoder/capture adapters are substituted. App, Monitor, transport,
 * review-session, useCoReview, ShareController and PeerStageVideo are real.
 * There are no native requests, real files, devices, peers or external media.
 * This proves wiring/ownership, not WKWebView decoding or capture delivery. */
async function boot(page: Page) {
  await page.route("https://**", route => route.abort());
  await page.route(/\/src\/components\/(LocalMediaPlayer|MediaBunnyPlayer)\.tsx(?:\?|$)/, async route => {
    const name = route.request().url().includes("/LocalMediaPlayer.") ? "LocalMediaPlayer" : "MediaBunnyPlayer";
    await route.fulfill({ contentType: "application/javascript", body: `
      import React from "/node_modules/.vite/deps/react.js";
      const { forwardRef, useEffect, useImperativeHandle, useRef } = React;
      export const ${name} = forwardRef(function GeneratedFilePlayer(props, ref) {
        const latest = useRef(props); latest.current = props;
        const state = useRef({ playing: false, time: 0, volume: 1, muted: false });
        const record = (method, value) => window.__screenStage.calls.push({ method, ...(value === undefined ? {} : { value }) });
        const seek = async time => { record("seek", time); state.current.time = time;
          latest.current.onTimeUpdate?.(time); return { requestedSeconds: time, presentedSeconds: time, status: "presented" }; };
        useImperativeHandle(ref, () => ({
          play: () => { record("play"); state.current.playing = true; latest.current.onPlayStateChange?.(true); },
          pause: () => { record("pause"); state.current.playing = false; latest.current.onPlayStateChange?.(false); },
          seekTo: seek, beginScrub: () => record("beginScrub"), scrubTo: time => record("scrubTo", time), endScrub: seek,
          getCurrentTime: () => state.current.time, getDuration: () => 120, isReady: () => true,
          isPlaying: () => state.current.playing, supportsPlaybackRate: true,
          setShuttle: value => { record("shuttle", value); }, setPlaybackRate: value => record("rate", value),
          setVolume: value => { state.current.volume = value; }, getVolume: () => state.current.volume,
          setMuted: value => { state.current.muted = value; }, isMuted: () => state.current.muted,
          getCaptureElement: () => null,
        }), []);
        useEffect(() => {
          window.__screenStage.player = Object.assign(state.current, {
            latePlaying: () => { state.current.playing = true; latest.current.onPlayStateChange?.(true); },
            lateTime: time => latest.current.onTimeUpdate?.(time),
          });
          latest.current.onReady?.(120); latest.current.onTimeUpdate?.(0);
        }, []);
        return React.createElement("div", { "data-testid": "generated-file-player", style: { width: "100%", height: "100%", background: "#203050" } }, "Generated local picture");
      });
    ` });
  });
  await page.route(/\/src\/lib\/share-stream\.ts(?:\?|$)/, route => route.fulfill({ contentType: "application/javascript", body: `
    export async function openShareStream(url, onDied, options) {
      if (url !== "generated:screen-stage") throw Error("Unexpected fixture source");
      if (options?.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext("2d"); let frame = 0;
      const paint = () => { context.fillStyle = frame++ % 2 ? "#204f39" : "#28563f";
        context.fillRect(0, 0, 640, 360); context.fillStyle = "white"; context.font = "28px sans-serif";
        context.fillText("Generated shared screen", 50, 180); };
      paint(); const stream = canvas.captureStream(12), track = stream.getVideoTracks()[0];
      window.__screenStage.stream = stream; window.__screenStage.opens++;
      const timer = setInterval(paint, 80); let closed = false;
      return { stream, track, audioTrack: null, close: () => {
        if (closed) return; closed = true; clearInterval(timer); track.stop(); window.__screenStage.closes++;
      } };
    }
  ` }));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ file, transcript }) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Generated screen editor"));
    localStorage.setItem("saucebunny.queueDrawerActiveTab", "review");
    localStorage.setItem("cp-captions-on", "true"); localStorage.setItem("e2e.avGranted", "1");
    localStorage.setItem("e2e.files", JSON.stringify({ [transcript]:
      "1\n00:00:00,000 --> 00:00:20,000\nGenerated first caption.\n\n2\n00:00:30,000 --> 00:01:00,000\nGenerated second caption.\n" }));
    localStorage.setItem("saucebunny.transcriptHistory", JSON.stringify([{ id: "generated-screen-transcript", srtPath: transcript,
      sourcePath: file, sourceUrl: null, title: "Generated transcript", origin: "whisper", createdAt: Date.now(), lastOpenedAt: Date.now() }]));
    const fixture = window as unknown as Fixture;
    fixture.__screenStage = { calls: [], native: [], opens: 0, closes: 0, rejectedSeeks: 0, player: null!, stream: null };
    const original = fixture.__TAURI_INTERNALS__.invoke;
    fixture.__TAURI_INTERNALS__.invoke = (command, args) => {
      fixture.__screenStage.native.push(command);
      if (command === "plugin:event|emit" && (args as { event?: string })?.event === "panel:action-rejected") fixture.__screenStage.rejectedSeeks++;
      if (command === "plugin:dialog|open") return Promise.resolve(file);
      if (command === "probe_local_file") return Promise.resolve({ path: file, filename: "generated-review.mp4", size_bytes: 4096,
        duration: 120, width: 640, height: 360, fps: 24, vcodec: "h264", acodec: "aac", has_video: true, has_audio: true });
      if (command === "get_file_size") return Promise.resolve(4096);
      if (command === "read_file_range") return new Promise(() => {});
      if (command === "screen_capture_access") return Promise.resolve("granted");
      if (command === "list_share_sources") return Promise.resolve({ capture_engine: true, windows: [], displays: [{
        id: 7, label: "Generated display", width: 640, height: 360, thumb: null }] });
      if (command === "start_screen_share") return Promise.resolve("generated:screen-stage");
      if (command === "stop_screen_share") return Promise.resolve();
      return original(command, args);
    };
  }, { file: FILE, transcript: TRANSCRIPT });
  await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "File", exact: true }).click();
  await expect(page.getByTestId("generated-file-player")).toBeVisible();
  await expect(page.locator(".cp-caption-overlay")).toContainText("Generated first caption.");
  await page.evaluate(() => {
    (window as unknown as Fixture).__TAURI_MOCK__.emitTauriEvent("session:state", {
      role: "host", code: "generated-screen-room", selfId: "m0", presenter: "m0", presenterEpoch: 1,
      peers: [], title: "Generated screen review", error: null,
    });
  });
  await expect(page.getByRole("toolbar", { name: "Room controls" })).toBeVisible();
}

async function share(page: Page) {
  await page.getByRole("toolbar", { name: "Room controls" }).getByRole("button", { name: /^Share your screen/ }).click();
  const dialog = page.getByRole("dialog", { name: "Share your screen" });
  await dialog.getByRole("button", { name: /Generated display/ }).click();
  await dialog.getByRole("button", { name: "Share", exact: true }).click();
  const stage = page.locator(".cp-monitor .cp-peerstage video");
  await expect(stage).toBeVisible();
  await expect(stage).toHaveAttribute("aria-label", "Your shared screen");
  await expect.poll(() => stage.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(640);
  await expect.poll(() => page.evaluate(() => (window as unknown as Fixture).__screenStage.player.playing)).toBe(false);
  return stage;
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as Fixture).__screenStage.calls);
const resetCalls = (page: Page) => page.evaluate(() => { (window as unknown as Fixture).__screenStage.calls = []; });

test("the host sees their explicit screen share in the main viewport and stopping restores the parked file", async ({ page }) => {
  await boot(page);
  const surface = page.locator(".cp-view-clip");
  await surface.focus(); await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => (window as unknown as Fixture).__screenStage.player.playing)).toBe(true);
  const stage = await share(page);
  expect(await stage.evaluate(element => (element as HTMLVideoElement).muted)).toBe(true);
  expect(await stage.evaluate(element => (element as HTMLVideoElement).srcObject === (window as unknown as Fixture).__screenStage.stream)).toBe(true);
  await expect(page.locator(".cp-caption-overlay")).toHaveCount(0);
  await expect(page.getByTestId("generated-file-player")).toBeAttached();
  await expect(page.locator(".cp-monitor-file-layer").filter({ has: page.getByTestId("generated-file-player") })).toHaveAttribute("inert", "");
  expect(await page.evaluate(() => (window as unknown as Fixture).__screenStage.opens)).toBe(1);
  await resetCalls(page);
  await page.getByRole("toolbar", { name: "Room controls" }).getByRole("button", { name: /Stop sharing/ }).click();
  await expect(stage).toHaveCount(0);
  await expect(page.locator(".cp-caption-overlay")).toContainText("Generated first caption.");
  await expect(page.locator(".cp-monitor-file-layer").filter({ has: page.getByTestId("generated-file-player") })).not.toHaveAttribute("inert");
  expect(await page.evaluate(() => (window as unknown as Fixture).__screenStage.closes)).toBe(1);
  expect((await calls(page)).filter(call => call.method === "play")).toEqual([]);
  await surface.focus(); await page.keyboard.press("Space");
  await expect.poll(() => page.evaluate(() => (window as unknown as Fixture).__screenStage.player.playing)).toBe(true);
});

test("screen ownership blocks Space, J/L and palette playback instead of driving the hidden file", async ({ page }) => {
  await boot(page);
  const surface = page.locator(".cp-view-clip");
  // Positive control: these keys reach the real App transport before sharing.
  await resetCalls(page); await surface.focus(); await page.keyboard.press("j"); await page.keyboard.press("k");
  await page.keyboard.press("l"); await page.keyboard.press("k");
  expect((await calls(page)).some(call => call.method === "shuttle" && call.value! < 0)).toBe(true);
  expect((await calls(page)).some(call => call.method === "play" || (call.method === "shuttle" && call.value! > 0))).toBe(true);
  await share(page); await resetCalls(page);
  await surface.focus();
  for (const key of ["Space", "j", "l", "k", "ArrowRight", "ArrowLeft"]) await page.keyboard.press(key);
  expect((await calls(page)).filter(call => call.method === "play" || call.method === "seek" || (call.method === "shuttle" && call.value !== 0))).toEqual([]);
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  for (const label of ["Play", "Jump to start", "Jump to end"]) {
    const row = palette.getByRole("option").filter({ has: page.locator(".cp-palette-row-label", { hasText: new RegExp(`^${label}$`) }) });
    await expect(row).toHaveAttribute("aria-disabled", "true");
    await row.click({ force: true });
  }
  await expect(palette).toBeVisible(); await page.keyboard.press("Escape");
  expect((await calls(page)).filter(call => call.method === "play" || call.method === "seek")).toEqual([]);
});

test("screen sharing suppresses file captions and transcript timing, rejects cue seeks and late file callbacks", async ({ page }) => {
  await boot(page);
  await page.getByRole("tablist", { name: "Right panel sections" }).getByRole("tab", { name: "Transcript", exact: true }).click();
  const cues = page.locator(".cp-view-clip [data-cue-idx]");
  await expect(cues.first()).toContainText("Generated first caption.");
  await expect(cues.first()).toHaveClass(/active/);
  // A real transcript cue must seek before the program source takes over.
  await resetCalls(page); await cues.nth(1).click();
  expect((await calls(page)).filter(call => call.method === "seek")).toEqual([{ method: "seek", value: 30 }]);
  await cues.first().click();
  await page.evaluate(() => (window as unknown as Fixture).__TAURI_MOCK__.emitTauriEvent("panel:request-state", {}));
  await expect.poll(() => page.evaluate(() => localStorage.getItem("saucebunny.panelSnapshot"))).not.toBeNull();
  const fileIdentity = await page.evaluate(() => JSON.parse(localStorage.getItem("saucebunny.panelSnapshot")!).sourceIdentity as string);
  await share(page); await resetCalls(page);
  await expect(page.locator(".cp-caption-overlay")).toHaveCount(0);
  await expect(cues).toHaveCount(0);
  await expect(page.locator(".cp-view-clip [data-cue-idx].active")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as Fixture).__TAURI_MOCK__.emitTauriEvent("panel:request-state", {}));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("saucebunny.panelSnapshot")!).programInputActive)).toBe(true);
  // A detached transcript may have queued a click before the source changed.
  // Exercise its actual Tauri event handler, not a direct controller method.
  await page.evaluate(identity => {
    const fixture = window as unknown as Fixture;
    const snapshot = JSON.parse(localStorage.getItem("saucebunny.panelSnapshot")!);
    fixture.__TAURI_MOCK__.emitTauriEvent("panel:action:seek", { sourceIdentity: identity, seconds: 30 });
    fixture.__TAURI_MOCK__.emitTauriEvent("panel:action:seek", { sourceIdentity: snapshot.sourceIdentity, seconds: 30 });
  }, fileIdentity);
  await expect.poll(() => page.evaluate(() => (window as unknown as Fixture).__screenStage.rejectedSeeks)).toBe(2);
  expect((await calls(page)).filter(call => call.method === "seek")).toEqual([]);
  await page.evaluate(() => {
    const fixture = (window as unknown as Fixture).__screenStage;
    fixture.player.lateTime(45); fixture.player.latePlaying();
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as Fixture).__screenStage.player.playing)).toBe(false);
  expect((await calls(page)).some(call => call.method === "pause")).toBe(true);
  await expect(page.locator(".cp-view-clip [data-cue-idx].active")).toHaveCount(0);
  await expect(page.locator(".cp-caption-overlay")).toHaveCount(0);
  await page.getByRole("toolbar", { name: "Room controls" }).getByRole("button", { name: /Stop sharing/ }).click();
  await expect(page.locator(".cp-caption-overlay")).toContainText("Generated first caption.");
  await expect(cues.first()).toHaveClass(/active/);
  await expect(page.getByRole("region", { name: "Playback transport" }).getByRole("button", { name: "Play", exact: true })).toBeVisible();
});
