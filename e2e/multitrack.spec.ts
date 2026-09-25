import { expect, test, type Locator, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture, multitrackLinkedFixture, multitrackTranscript } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

test.use({ browserName: process.env.SAUCE_AUDIO_BROWSER === "webkit" ? "webkit" : "chromium" });

async function boot(page: Page, trackCount = 3, audible = false, grouped = false, pendingMedia = false) {
  const fixture = multitrackFixture();
  fixture.manifest.tracks = Array.from({ length: trackCount }, (_, index) => ({ ...structuredClone(multitrackFixture().manifest.tracks[index % 3]), id: `track-${index + 1}`, name: index < 3 ? multitrackFixture().manifest.tracks[index].name : `Mic ${index + 1}` }));
  if (grouped) fixture.manifest.graph = { sequence_id: "group", sources: [], positions: [], markers: [], picture_tracks: [], path_mappings: [], lanes: fixture.manifest.tracks.map((track, index) => ({ track_id: track.id, parent_track_id: index < 14 ? null : `track-${Math.floor((index-14)/6)+1}`, branch_id: index < 14 ? null : `branch-${index}`, group_name: "Generated group", availability: "ready" })) };
  if (pendingMedia) { fixture.manifest = multitrackLinkedFixture().manifest; fixture.transcripts = [multitrackTranscript()]; }
  // Silent, duration-correct PCM exercises browser decoding without private
  // media or a nonexistent asset:// URL masking unrelated UI failures.
  await page.route("**/e2e-mock/solo-*.wav", (route) => {
    const frames = Number(new URL(route.request().url()).pathname.match(/solo-(\d+)\.wav$/)?.[1]);
    const samples = Math.ceil(frames * 1001 / 24000 * 16000), body = Buffer.alloc(44 + samples * 2);
    body.write("RIFF", 0); body.writeUInt32LE(body.length - 8, 4); body.write("WAVEfmt ", 8);
    body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22);
    body.writeUInt32LE(16000, 24); body.writeUInt32LE(32000, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34);
    body.write("data", 36); body.writeUInt32LE(samples * 2, 40);
    if (audible) for (let sample = 0; sample < samples; sample++) body.writeInt16LE(Math.round(Math.sin(sample / 16000 * 2 * Math.PI * 440) * 4000), 44 + sample * 2);
    return route.fulfill({ contentType: "audio/wav", body });
  });
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ document: fixture, transcript }) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1"); localStorage.setItem("e2e.files", "{}");
    const app = window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[]; __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>; convertFileSrc: (path: string, protocol?: string) => string } };
    app.__multitrackCalls = [];
    const original = app.__TAURI_INTERNALS__.invoke;
    const originalFileSrc = app.__TAURI_INTERNALS__.convertFileSrc;
    app.__TAURI_INTERNALS__.convertFileSrc = (path, protocol) => path.startsWith("/e2e-mock/solo-") ? path : originalFileSrc(path, protocol);
    app.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      app.__multitrackCalls.push({ command, args });
      if (command === "aaf_list") return Promise.resolve([]);
      if (command === "aaf_sequences") return Promise.resolve([{ id: "fixture", name: fixture.manifest.name }]);
      if (command === "plugin:dialog|open") return Promise.resolve((args.options as { directory?: boolean })?.directory ? "/exports" : fixture.source_path);
      if (command === "plugin:dialog|save") return Promise.resolve("/exports/transcript.txt");
      if (command === "write_text_to_path") return Promise.resolve(args.path);
      if (command === "print_transcript" || command === "export_transcript_pdf") return Promise.resolve();
      if (command === "aaf_import" || command === "aaf_open") return Promise.resolve(fixture);
      // Deliberately never finishes: opening the timeline and reading saved
      // dialogue must not depend on a slow or disconnected MXF mount.
      if (command === "aaf_resolve_media") return new Promise(() => {});
      if (command === "aaf_save_labels") { fixture.labels = args.labels as typeof fixture.labels; return Promise.resolve(fixture); }
      if (command === "aaf_waveform") return Promise.resolve({ track_id: args.trackId, peaks: Array.from({ length: 400 }, (_, index) => { const height = (index % 19) / 20; return [-height, height]; }) });
      if (command === "parakeet_model_downloaded") return Promise.resolve(true);
      if (command === "list_whisper_models") return Promise.resolve([{ id: "large-v3", name: "Large v3", downloaded: true }]);
      if (command === "aaf_transcribe_track") {
        const committed = { ...transcript, track_id: args.trackId as string, start_frame: args.startFrame as number, duration_frames: args.durationFrames as number };
        fixture.transcripts = [...fixture.transcripts.filter(t => t.track_id !== committed.track_id), committed];
        return Promise.resolve(committed);
      }
      if (command === "aaf_prepare_audio") return Promise.resolve({ path: `/e2e-mock/solo-${args.durationFrames}.wav`, start_frame: args.startFrame, duration_frames: args.durationFrames, sample_rate: 16000, sample_count: Math.ceil(Number(args.durationFrames) * 1001 / 24000 * 16000), peaks: [] });
      return original(command, args);
    };
  }, { document: fixture, transcript: multitrackTranscript() });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.locator(".cp-nav-item").filter({ hasText: "AAF Audio" }).click();
  await expect(page.getByRole("heading", { name: "AAF Audio", exact: true })).toBeVisible();
}

for (const [width, scale] of [[1100, 1], [1100, 1.25], [1920, 1]] as const) {
  test(`linked media never blocks the timeline or saved transcript at ${width}/${scale}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 }); await boot(page, 3, false, false, true);
    if (scale !== 1) await page.evaluate(scale => {
      for (const name of ["--text-base", "--text-md", "--text-lg", "--text-3xl"]) {
        const size = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
        document.documentElement.style.setProperty(name, `${size * scale}px`);
      }
    }, scale);
    const region = page.getByRole("region", { name: "AAF Audio", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    const status = region.getByRole("status").filter({ hasText: "Checking linked media" });
    await expect(status).toBeVisible();
    await expect(region.getByRole("button", { name: "Current timecode" })).toBeVisible();
    await expect(region.getByText("This is the first answer.", { exact: true }).first()).toBeVisible();
    await expect(status.getByRole("button", { name: "Stop", exact: true })).toBeInViewport();
    expect(await region.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("progressive-aaf-open.png") });
    await status.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(status).toBeHidden();
    await expect(region.getByText("This is the first answer.", { exact: true }).first()).toBeVisible();
    const calls = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[] }).__multitrackCalls);
    const checks = calls.filter(call => call.command === "aaf_resolve_media");
    expect(checks).toHaveLength(1);
    expect(calls.some(call => call.command === "cancel_job" && call.args.jobId === checks[0].args.jobId)).toBe(true);
  });
}

for (const scale of [1, 1.25]) {
  test(`Whisper subsettings stay compact and persist at ${scale} text scale`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await boot(page);
    if (scale !== 1) await page.evaluate(scale => {
      for (const name of ["--text-base", "--text-md", "--text-lg", "--text-3xl"]) {
        const size = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
        document.documentElement.style.setProperty(name, `${size * scale}px`);
      }
    }, scale);
    const region = page.getByRole("region", { name: "AAF Audio", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    await region.getByRole("combobox", { name: "Engine", exact: true }).selectOption("whisper");
    const options = region.locator(".cp-multitrack-asr-options");
    await expect(options.getByRole("combobox", { name: "Decoding" })).not.toBeVisible();
    await options.locator("summary").click();
    await expect(options.getByRole("combobox", { name: "Decoding" })).toHaveValue("accurate");
    await expect(options.getByLabel("Skip non-speech")).not.toBeChecked();
    await options.getByRole("combobox", { name: "Decoding" }).selectOption("fast");
    await options.getByLabel("Skip non-speech").check();
    await expect(options.getByText(/May miss quiet voices/)).toBeVisible();
    await expect(options.getByLabel("Skip non-speech")).toBeInViewport();
    await expect(region.getByRole("button", { name: "Generate 3 tracks" })).toBeInViewport();
    expect(await region.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("whisper-options.png") });
    await region.getByRole("button", { name: "Generate 3 tracks" }).click();
    await expect(region.getByRole("status").filter({ hasText: "Selected range saved for every track" })).toBeVisible();
    const calls = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[] }).__multitrackCalls.filter(call => call.command === "aaf_transcribe_track"));
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.args).toMatchObject({ engine: "whisper", fast: true, speechOnly: true });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("saucebunny.multitrackTranscriptionOptions")!))).toEqual({ fast: true, speechOnly: true });
    await region.getByRole("combobox", { name: "Engine", exact: true }).selectOption("parakeet");
    await expect(options).toHaveCount(0);
    await region.getByRole("combobox", { name: "Engine", exact: true }).selectOption("whisper");
    await expect(options.locator("summary")).toHaveText("Options · Fast · Speech filter");
  });
}

test("Multitrack Pipeline remains available after a failed import and exports server diagnostics", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await boot(page, 20);
  await page.evaluate(() => {
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (command, args) => command === "aaf_sequences"
      ? Promise.reject({ kind: "Invalid", data: "Unable to inspect AAF" }) : original(command, args);
  });
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  await expect(region.getByRole("alert")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } }).__TAURI_MOCK__.emitTauriEvent("aaf-diagnostic", {
      id: "missing-mxf", timestamp_ms: Date.now(), job_id: "failed-import", level: "err", stage: "candidate", active: false,
      message: "/Volumes/Test Workspace/Avid MediaFiles/MXF/Editor.2/large.mxf · Permission denied (os error 13)",
    });
  });
  await expect(region.getByText(/Permission denied/)).toBeVisible();
  const button = region.getByRole("button", { name: "Export diagnostics", exact: true });
  await expect(button).toBeInViewport();
  await button.click();
  await expect(region.getByText(/Diagnostics saved:/)).toBeVisible();
  const exported = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: { text?: string } }[] }).__multitrackCalls.find(call => call.command === "write_text_to_path")?.args.text);
  expect(exported).toContain("Permission denied");
  expect(exported).toContain("Frontend build:");
  await page.screenshot({ path: test.info().outputPath("multitrack-failed-import-pipeline.png") });
});

test("98 grouped microphones expand without implicit audition or transcription", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 }); await boot(page,98,true,true);
  const region=page.getByRole("region",{name:"AAF Audio",exact:true});
  await region.getByRole("button",{name:"Import AAF…",exact:true}).first().click();
  await expect(region.locator('.cp-multitrack-lane')).toHaveCount(14);
  await expect(region.getByRole("button",{name:"Generate 14 tracks",exact:true})).toBeEnabled();
  const calls=()=>page.evaluate(()=>(window as unknown as { __multitrackCalls: {command:string;args:Record<string,unknown>}[] }).__multitrackCalls);
  await expect.poll(async()=> (await calls()).filter(c=>c.command==="aaf_waveform").length).toBeGreaterThanOrEqual(14);
  expect((await calls()).filter(c=>c.command==="aaf_waveform").every(c=>Number(String(c.args.trackId).split('-')[1])<=14)).toBe(true);
  const started=Date.now();
  for (const button of await region.getByRole('button',{name:/Alternative microphones for/}).all()) await button.click();
  await expect(region.locator('.cp-multitrack-lane')).toHaveCount(98);
  expect(await region.getByRole('checkbox',{checked:true}).count()).toBe(14);
  await expect(region.getByRole('button',{name:'Mute Mic 98',exact:true})).toHaveAttribute('aria-pressed','true');
  expect((await calls()).filter(c=>c.command==='aaf_transcribe_track')).toHaveLength(0);
  expect((await calls()).filter(c=>c.command==='aaf_prepare_audio').every(c=>Number(String(c.args.trackId).split('-')[1])<=14)).toBe(true);
  const expandedMs=Date.now()-started;
  await region.getByRole('button',{name:'Solo Mic 98',exact:true}).click();
  await region.getByRole('button',{name:'Play tracks',exact:true}).click();
  await expect.poll(async()=>Number(await region.getByRole('slider',{name:'Seek Mic 98',exact:true}).getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await region.getByRole('button',{name:'Pause audition',exact:true}).click();
  await region.getByRole('button',{name:'Zoom in',exact:true}).click();
  await region.getByRole('button',{name:'Select all',exact:true}).click();
  await region.getByRole('button',{name:'Generate 98 tracks',exact:true}).click();
  await expect.poll(async()=>(await calls()).filter(c=>c.command==='aaf_transcribe_track').length,{timeout:20000}).toBe(98);
  await expect(region.getByRole('status').filter({hasText:'Selected range saved for every track'})).toBeVisible();
  await expect(region.locator('.cp-multitrack-saved-status[role="img"]')).toHaveCount(98);
  await region.getByRole('combobox',{name:'Transcript export format'}).selectOption('avid');
  await region.getByRole('button',{name:'Export selected (98)',exact:true}).click();
  await expect(region.getByRole('status').filter({hasText:'98 files saved in /exports'})).toBeVisible();
  const exports = (await calls()).filter(c => c.command === 'write_text_to_path');
  const markers = exports.filter(c => String(c.args.path).endsWith('.txt'));
  expect(markers).toHaveLength(98); expect(exports).toHaveLength(99);
  expect(new Set(markers.map(c => c.args.path)).size).toBe(98);
  for (const [index, file] of markers.entries()) {
    const fields = String(file.args.text).trim().split('\t');
    expect(fields).toHaveLength(5);
    expect(fields[2]).toBe(`A${index < 14 ? index + 1 : Math.floor((index - 14) / 6) + 1}`);
    expect(file.args).toMatchObject({ atomic: true, unique: true });
  }
  expect(exports.at(-1)!.args.text).toContain('one microphone file per parent track');
  await expect(region.getByRole('button',{name:'Avid files by microphone'})).toBeInViewport();
  expect(await region.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  // A single alternative's context action remains a named Save As, not a folder.
  await region.getByRole('button',{name:'Track actions for Mic 98'}).click();
  const menu = page.getByRole('menu',{name:'Actions for Mic 98'});
  await menu.getByRole('menuitem',{name:'Export Avid markers…'}).click();
  await expect(menu.getByRole('status')).toContainText('Saved to /exports/transcript.txt');
  const single = (await calls()).filter(c => c.command === 'write_text_to_path').at(-1)!;
  expect(single.args.text).toContain('\tA14\tred\t[Group alternative:');
  await menu.getByRole('menuitem',{name:'Export Avid markers…'}).press('Escape');
  await test.info().attach('group-stress',{contentType:'application/json',body:JSON.stringify({lanes:98,roots:14,expandedMs,note:'Real browser mixer and controls, mocked native PCM/recognition; not packaged NEXIS certification.'})});
  await page.screenshot({path:test.info().outputPath('98-grouped-lanes.png')});
});

test("50-track output has signal, solo 47 stays audible, and native controls stay dark under OS Light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1680, height: 1020 });
  await page.addInitScript(() => {
    const probes: AnalyserNode[] = [];
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination: AudioNode, output?: number, input?: number) {
      if (destination instanceof AudioDestinationNode) {
        const probe = this.context.createAnalyser(); probe.fftSize = 2048;
        connect.call(this, probe); probes.push(probe);
      }
      return connect.call(this, destination, output ?? 0, input ?? 0);
    } as typeof connect;
    (window as unknown as { outputRms: () => number }).outputRms = () => Math.max(0, ...probes.map(probe => {
      const samples = new Float32Array(probe.fftSize); probe.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    }));
  });
  await boot(page, 50, true);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  for (const selector of ["html", ".cp-multitrack-scroll", 'input[type="checkbox"]']) {
    const elements = page.locator(selector);
    if (await elements.count()) expect(await elements.first().evaluate(element => getComputedStyle(element).colorScheme)).toContain("dark");
  }
  const tabs = region.getByRole("tablist", { name: "Transcripts by person" });
  expect(await tabs.evaluate(element => getComputedStyle(element).colorScheme)).toContain("dark");
  const rms = () => page.evaluate(() => (window as unknown as { outputRms: () => number }).outputRms());
  const started = Date.now();
  await region.getByRole("button", { name: "Play tracks", exact: true }).click();
  await expect.poll(rms).toBeGreaterThan(0.002);
  const firstSignalMs = Date.now() - started;
  // Sustain real output across the fixed five-second PCM window boundary.
  const seek = region.getByRole("slider", { name: "Seek Alex mic", exact: true });
  await expect.poll(async () => Number(await seek.getAttribute("aria-valuenow")), { timeout: 12_000 }).toBeGreaterThan(145);
  const acrossBoundaryRms = await rms(); expect(acrossBoundaryRms).toBeGreaterThan(0.002);
  await test.info().attach("output-measurement", { contentType: "application/json", body: JSON.stringify({
    browser: process.env.SAUCE_AUDIO_BROWSER ?? "chromium", tracks: 50, firstSignalMs, acrossBoundaryRms,
    note: "Measured Web Audio destination graph, not physical speaker output; generated PCM and mocked file IPC.",
  }, null, 2) });
  await region.getByRole("button", { name: "Pause audition", exact: true }).click();
  await expect.poll(rms).toBeLessThan(0.000001);
  await region.getByRole("button", { name: "Solo Mic 47", exact: true }).click();
  await region.getByRole("button", { name: "Play tracks", exact: true }).click();
  await expect.poll(rms).toBeGreaterThan(0.002);
  await region.getByRole("button", { name: "Mute Mic 47", exact: true }).click();
  await expect.poll(rms).toBeLessThan(0.000001);
  await region.getByRole("button", { name: "Mute Mic 47", exact: true }).click();
  await expect.poll(rms).toBeGreaterThan(0.002);
  await region.getByRole("button", { name: "Pause audition", exact: true }).click();
  await page.screenshot({ path: test.info().outputPath("fifty-track-os-light.png") });
});

for (const width of [1100, 1680]) {
  test(`Selected-track export follows checkboxes, not person, search or Solo at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await boot(page);
    if (width === 1100) await page.evaluate(() => document.documentElement.style.zoom = "1.25");
    const region = page.getByRole("region", { name: "AAF Audio", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    const selected = region.getByRole("button", { name: "Export selected (3)", exact: true });
    await expect(selected).toBeDisabled();
    await region.getByRole("button", { name: "Generate 3 tracks" }).click();
    await expect(selected).toBeEnabled();
    await region.getByRole("checkbox", { name: "Select Sam mic", exact: true }).uncheck();
    await region.getByRole("combobox", { name: "Choose transcript" }).selectOption({ label: "Sam mic" });
    await region.getByRole("button", { name: "Solo Sam mic", exact: true }).click();
    await region.getByRole("searchbox", { name: "Search track transcripts" }).fill("no matching words");
    const format = region.getByRole("combobox", { name: "Transcript export format" });
    for (const kind of ["txt", "csv", "pdf", "avid", "srt", "print"]) {
      await format.selectOption(kind);
      const button = region.getByRole("button", { name: "Export selected (2)", exact: true });
      await button.focus(); await button.press("Space");
      await expect(format).toBeEnabled();
      const call = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[] }).__multitrackCalls.filter(item => ["write_text_to_path", "export_transcript_pdf", "print_transcript"].includes(item.command)).at(-1));
      const text = String(call!.args[kind === "pdf" || kind === "print" ? "html" : "text"]);
      expect(text).toContain("Alex"); expect(text).toContain("Room");
      expect(text).toContain("A1"); expect(text).toContain("A3");
      expect(text).not.toContain("A2"); expect(text).not.toContain("Sam mic");
    }
    await expect(region.getByRole("button", { name: "Pause audition" })).toHaveCount(0);
    await format.selectOption("txt");
    for (const button of await region.locator(".cp-multitrack-export button:visible").all()) {
      const box = (await button.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(24); expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width); expect(box.y + box.height).toBeLessThanOrEqual(900);
      expect(await button.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: test.info().outputPath(`multitrack-selected-export-${width}.png`) });
    await region.getByRole("button", { name: "Select all", exact: true }).click();
    await region.getByRole("button", { name: "Deselect all", exact: true }).click();
    await expect(region.getByRole("button", { name: "Export selected (0)", exact: true })).toBeDisabled();
    await expect(region.getByRole("button", { name: "Entire transcript", exact: true })).toBeEnabled();
  });
}

test("Entire transcript exports every source lane in the selected format despite person/search filters", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 850 }); await boot(page);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  await region.getByRole("button", { name: "Generate 3 tracks" }).click();
  await expect(region.getByRole("status").filter({ hasText: "Selected range saved for every track" })).toBeVisible();
  await region.getByRole("combobox", { name: "Choose transcript" }).selectOption({ label: "Sam mic" });
  await region.getByRole("searchbox", { name: "Search track transcripts" }).fill("no matching words");
  const format = region.getByRole("combobox", { name: "Transcript export format" });
  for (const selected of ["avid", "csv", "txt", "srt", "pdf"]) {
    await format.selectOption(selected);
    await region.getByRole("button", { name: "Entire transcript", exact: true }).click();
    await expect(format).toBeEnabled();
    const call = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[] }).__multitrackCalls.filter((item) => ["write_text_to_path", "export_transcript_pdf"].includes(item.command)).at(-1));
    const text = String(call!.args[selected === "pdf" ? "html" : "text"]);
    for (const lane of ["A1", "A2", "A3"]) expect(text).toContain(lane);
    expect(text).toContain("Alex"); expect(text).toContain("Sam mic"); expect(text).toContain("Room");
    expect(text).not.toContain("V1");
    if (selected === "srt") expect(text).toContain("00:00:10,000 --> 00:00:13,000");
    if (selected === "pdf") expect(call!.command).toBe("export_transcript_pdf");
    expect(await region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: test.info().outputPath("multitrack-export-formats.png") });
});

for (const width of [1100, 1680]) {
  test(`Multitrack timecode punch-in commits on Enter and sits above Play at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await boot(page, 50);
    if (width === 1100) await page.evaluate(() => {
      for (const name of ["--text-base", "--text-md", "--text-lg", "--text-3xl"]) {
        const size = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
        document.documentElement.style.setProperty(name, `${size * 1.25}px`);
      }
    });
    const region = page.getByRole("region", { name: "AAF Audio", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    const tc = region.getByRole("button", { name: "Current timecode", exact: true });
    const play = region.getByRole("button", { name: "Play tracks", exact: true });
    const trt = region.getByLabel("Total runtime", { exact: true });
    await expect(tc).toHaveText("01:00:00:00"); await expect(trt).toHaveText("TRT00:16:40:00");
    const tcBox = (await tc.boundingBox())!, playBox = (await play.boundingBox())!;
    expect(tcBox.y + tcBox.height).toBeLessThan(playBox.y);
    expect(Math.abs(tcBox.x + tcBox.width / 2 - playBox.x - playBox.width / 2)).toBeLessThan(1);
    const toolbar = region.locator(".cp-multitrack-transport");
    expect(await toolbar.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await expect(trt).toBeInViewport();
    const owner = region.getByRole("textbox", { name: "Mic owner for track-1", exact: true });
    await owner.fill("Mic 123"); await expect(page.getByRole("dialog", { name: "Go to timecode" })).toBeHidden();
    await owner.press("Escape");
    const lane = region.getByRole("slider", { name: "Seek Alex mic", exact: true }); await lane.focus();
    // Playwright's US keypad map uses navigation keys unless shifted. This
    // emits real digit keydowns with Numpad codes/location, as on a Mac keypad.
    for (const digit of "01001012") await page.keyboard.press(`Shift+Numpad${digit}`);
    const dialog = page.getByRole("dialog", { name: "Go to timecode" });
    await expect(dialog).toBeVisible(); await expect(dialog).toBeFocused();
    await expect(dialog.getByLabel("Entered timecode")).toHaveText("01:00:10:12");
    await page.keyboard.type("lettersJKL.+-");
    await expect(dialog.getByLabel("Entered timecode")).toHaveText("01:00:10:12");
    await expect(tc).toHaveText("01:00:00:00"); await expect(lane).toHaveAttribute("aria-valuenow", "0");
    await page.keyboard.press("Tab"); await expect(dialog).toBeFocused();
    await page.screenshot({ path: test.info().outputPath("multitrack-timecode-entry.png") });
    await page.keyboard.press("NumpadEnter");
    await expect(dialog).toBeHidden(); await expect(tc).toHaveText("01:00:10:12");
    await expect(lane).toHaveAttribute("aria-valuenow", "252"); await expect(lane).toBeFocused();
    await expect(play).toBeVisible(); await expect(trt).toHaveText("TRT00:16:40:00");
    await tc.click(); await page.keyboard.type("01002000"); await page.keyboard.press("Escape");
    await expect(tc).toBeFocused(); await expect(tc).toHaveText("01:00:10:12");
    await tc.click(); await page.keyboard.press("Enter"); await expect(tc).toHaveText("01:00:10:12");
    await page.screenshot({ path: test.info().outputPath("multitrack-timecode-transport.png") });
    await page.locator(".cp-nav-item").filter({ hasText: "Home" }).click();
    await page.keyboard.press("Shift+Numpad1"); await expect(dialog).toBeHidden();
  });

  test(`Transcript picker stays compact and fixed beside overflowing tabs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await boot(page, 20);
    if (width === 1100) await page.evaluate(() => document.documentElement.style.setProperty("--text-md", "15px"));
    const region = page.getByRole("region", { name: "AAF Audio", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    const picker = region.getByRole("combobox", { name: "Choose transcript" }), tabs = region.getByRole("tablist", { name: "Transcripts by person" });
    const before = (await picker.boundingBox())!, list = (await tabs.boundingBox())!;
    expect(before.width).toBe(28); expect(before.height).toBeGreaterThanOrEqual(24);
    expect(list.x + list.width).toBeCloseTo(before.x, 1);
    await picker.selectOption({ label: "Mic 20" });
    await expect(region.getByRole("tab", { name: "Mic 20", exact: true })).toBeInViewport();
    expect((await picker.boundingBox())!).toEqual(before);
    expect(await picker.evaluate((element) => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element; })).toBe(true);
    await region.getByRole("tab", { name: "Mic 20", exact: true }).press("Home");
    await expect(region.getByRole("tab", { name: "All voices" })).toBeFocused();
    expect((await picker.boundingBox())!).toEqual(before);
    await picker.focus(); expect(await picker.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    const checkbox = region.getByRole("checkbox", { name: "Search with AI" });
    await checkbox.focus(); await checkbox.press("Space"); await expect(checkbox).toBeChecked();
    await expect(region.getByRole("button", { name: "Search", exact: true })).toBeDisabled();
    expect(await region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("multitrack-compact-picker.png") });
  });
}

test("Local AI transcript search uses the existing bar, preserves original results and leaves text mode available", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1020 }); await boot(page);
  const requests: { messages: { role: string; content: string }[] }[] = [];
  await page.route("http://127.0.0.1:51235/v1/chat/completions", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/event-stream", headers: { "access-control-allow-origin": "*" }, body: 'data: {"choices":[{"delta":{"content":"{\\"matches\\":[0]}"}}]}\n\ndata: [DONE]\n\n' });
  });
  await page.evaluate(() => {
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "list_llm_models") return Promise.resolve([{ id: "qwen3-4b-instruct", downloaded: true, recommended: true }]);
      if (command === "llm_server_status") return Promise.resolve({ model_id: "qwen3-4b-instruct", ctx: 8192, base_url: "http://127.0.0.1:51235", api_key: "generated-browser-fixture" });
      return original(command, args);
    };
  });
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  await region.getByRole("button", { name: "Generate 3 tracks" }).click();
  await expect(region.getByRole("button", { name: /This is the first answer/ })).toHaveCount(1);
  await region.getByRole("tab", { name: "All voices" }).click();
  const field = region.getByRole("searchbox", { name: "Search track transcripts" });
  await region.getByRole("checkbox", { name: "Search with AI" }).check();
  await field.fill("opening response"); expect(requests).toHaveLength(0);
  await field.press("Enter");
  await expect(region.getByText("1 matching passage · Local AI")).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(requests[0].messages[0].content).toContain("Sam mic");
  expect(requests[0].messages[1].content).toContain("opening response");
  const cue = region.getByRole("button", { name: /This is the first answer/ }); await expect(cue).toHaveCount(1);
  await cue.click(); await expect(cue).toHaveClass(/is-current/);
  await page.screenshot({ path: test.info().outputPath("multitrack-ai-search.png") });
  await region.getByRole("checkbox", { name: "Search with AI" }).uncheck();
  await expect(region.getByText("No matching transcript text.")).toBeVisible();
  await field.fill("Sam"); await expect(region.getByRole("button", { name: /This is the first answer/ })).toHaveCount(1);
  expect(requests).toHaveLength(1);
});

for (const width of [1100, 1920]) {
  test(`Transcription bar stays on one line through repeated chunk phases at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1100 ? 740 : 1080 }); await boot(page, 20);
    await page.evaluate(({ transcript, largeText }) => {
      if (largeText) document.documentElement.style.setProperty("--text-md", "15px");
      const app = window as unknown as {
        __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
        __TAURI_MOCK__: { emitTauriEvent: (event: string, payload: unknown) => void };
        __progressTest: { emit: (phase: string, frames: number, total: number) => void; finish: () => void };
      };
      const original = app.__TAURI_INTERNALS__.invoke;
      let pending: { args: Record<string, unknown>; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;
      app.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
        if (command === "aaf_transcribe_track") return new Promise((resolve, reject) => { pending = { args, resolve, reject }; });
        if (command === "cancel_job") { pending?.reject(new Error("Cancelled")); return Promise.resolve(); }
        return original(command, args);
      };
      app.__progressTest = {
        emit: (phase, frames, total) => app.__TAURI_MOCK__.emitTauriEvent("aaf-progress", { job_id: pending?.args.jobId, track_id: pending?.args.trackId, phase, completed_frames: frames, total_frames: total }),
        finish: () => pending?.resolve({ ...transcript, track_id: pending.args.trackId }),
      };
    }, { transcript: multitrackTranscript(), largeText: width === 1100 });
    const region = page.getByRole("region", { name: "AAF Audio", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    const generate = region.getByRole("button", { name: "Generate 20 tracks", exact: true });
    const trackStatus = region.locator('.cp-multitrack-saved-status[role="img"]');
    await expect(trackStatus).toHaveCount(0);
    const soloBefore = await region.getByRole("button", { name: "Solo Alex mic", exact: true }).boundingBox();
    const controls = region.locator(".cp-multitrack-generation .cp-multitrack-options");
    const idle = (await generate.boundingBox())!, toolbar = (await controls.boundingBox())!;
    expect(idle.width).toBe(240);
    expect(idle.x + idle.width).toBeCloseTo(toolbar.x + toolbar.width, 1);
    await generate.click();
    const button = region.locator(".cp-gen-btn"), label = button.locator(".cp-gen-load"), fill = button.locator(".cp-gen-fill");
    await expect(button).toHaveAttribute("aria-label", "Transcribing 1 of 20");
    const initial = (await button.boundingBox())!;
    const stop = (await region.getByRole("button", { name: "Stop", exact: true }).boundingBox())!;
    const settings = (await region.getByRole("button", { name: "Deselect all", exact: true }).boundingBox())!;
    expect(initial.width).toBe(240);
    expect(stop.x - initial.x - initial.width).toBeCloseTo(12, 1);
    expect(stop.x + stop.width).toBeCloseTo(toolbar.x + toolbar.width, 1);
    if (Math.abs(settings.y - initial.y) < 12) expect(initial.x - settings.x - settings.width).toBeGreaterThanOrEqual(24);
    for (const frames of [0, 6000, 12000, 18000, 24000]) {
      for (const phase of ["preparing-audio", "transcribing"]) {
        await page.evaluate(({ phase, frames }) => (window as unknown as { __progressTest: { emit: (phase: string, frames: number, total: number) => void } }).__progressTest.emit(phase, frames, 24000), { phase, frames });
        await expect(label).toHaveText("Transcribing 1 of 20");
        await expect(fill).toHaveCount(1);
        expect(parseFloat(await fill.evaluate((element) => (element as HTMLElement).style.width))).toBeCloseTo(frames / 24000 * 5);
        const box = (await button.boundingBox())!;
        expect(box.height).toBeCloseTo(initial.height, 3);
        // The shared button's existing hover lift is 1px; chunk updates must
        // not introduce a line-height/layout jump beyond that decoration.
        expect(Math.abs(box.y - initial.y)).toBeLessThanOrEqual(1);
        expect(await label.evaluate((element) => {
          const text = document.createRange(); text.selectNodeContents(element);
          return text.getClientRects().length === 1 && element.scrollWidth <= element.clientWidth;
        })).toBe(true);
      }
    }
    await page.evaluate(() => (window as unknown as { __progressTest: { finish: () => void } }).__progressTest.finish());
    await expect(label).toHaveText("Transcribing 2 of 20");
    await expect(trackStatus).toHaveCount(1);
    await expect(trackStatus).toHaveAttribute("aria-label", "Alex: Selected range transcribed. Transcript saved.");
    expect(await region.getByRole("button", { name: "Solo Alex mic", exact: true }).boundingBox()).toEqual(soloBefore);
    expect((await button.boundingBox())!.height).toBeCloseTo(initial.height, 3);
    await page.screenshot({ path: test.info().outputPath("multitrack-steady-progress.png") });
    await region.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(region.getByRole("status").filter({ hasText: "Stopped. 1 tracks saved." })).toBeVisible();
    await expect(button).toHaveAttribute("aria-busy", "false");
    await expect(trackStatus).toHaveCount(1);
  });
}

for (const viewport of [{ width: 1100, height: 740 }, { width: 1680, height: 1020 }]) {
  test(`Multitrack import and whole-sequence transcript flow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await boot(page);
    const region = page.getByRole("region", { name: "AAF Audio", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    await expect(region.getByRole("heading", { name: "Interview", exact: true })).toBeVisible();
    await expect(region.getByRole("slider", { name: /^Seek / })).toHaveCount(3);
    const generate = region.getByRole("button", { name: "Generate 3 tracks", exact: true });
    await expect(generate).toBeEnabled();
    await expect(region.locator('.cp-multitrack-saved-status[role="img"]')).toHaveCount(0);
    await generate.click();
    await expect(region.getByRole("status").filter({ hasText: "Selected range saved for every track" })).toBeVisible();
    await expect(region.locator('.cp-multitrack-saved-status[role="img"]')).toHaveCount(3);
    await expect(region.getByRole("img", { name: "Alex: Transcribed. Transcript saved." })).toBeVisible();
    await expect(region.getByRole("button", { name: /This is the first answer/ })).toHaveCount(1);
    await region.getByRole("tab", { name: "All voices", exact: true }).click();
    await expect(region.getByRole("button", { name: /This is the first answer/ })).toHaveCount(3);
    await region.getByRole("searchbox", { name: "Search track transcripts" }).fill("Alex");
    await expect(region.getByRole("button", { name: /This is the first answer/ })).toHaveCount(1);
    await region.getByRole("button", { name: /This is the first answer/ }).click();
    const calls = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[] }).__multitrackCalls);
    expect(calls.filter((call) => call.command === "aaf_transcribe_track")).toHaveLength(3);
    expect(calls.filter((call) => call.command === "aaf_transcribe_track").every((call) => call.args.startFrame === 0 && call.args.durationFrames === 24000)).toBe(true);
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string }[] }).__multitrackCalls.filter((call) => call.command === "aaf_prepare_audio").length)).toBeGreaterThan(0);
    expect(await region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const generation = (await region.locator(".cp-multitrack-generation").boundingBox())!, output = (await region.locator(".cp-multitrack-export").boundingBox())!;
    expect(Math.abs(generation.y - output.y)).toBeLessThan(1);
    for (const button of await region.locator(".cp-multitrack-generate-row button").all()) {
      await button.scrollIntoViewIfNeeded();
      expect(await button.evaluate((element) => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath("multitrack-workspace.png") });
  });
}

test("Saved transcript icons survive failed regeneration and reopening without marking failed-only tracks", async ({ page }) => {
  await boot(page);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  await page.evaluate(() => {
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (command, args = {}) => command === "aaf_transcribe_track" && args.trackId === "track-3"
      ? Promise.reject(new Error("Test recognition failed")) : original(command, args);
  });
  await region.getByRole("button", { name: "Generate 3 tracks" }).click();
  await expect(region.getByRole("status").filter({ hasText: "2 tracks saved · 1 failed" })).toBeVisible();
  const statuses = region.locator('.cp-multitrack-saved-status[role="img"]');
  await expect(statuses).toHaveCount(2);
  await expect(region.getByRole("img", { name: /^Room:/ })).toHaveCount(0);
  await page.evaluate(() => {
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (command, args) => command === "aaf_transcribe_track"
      ? Promise.reject(new Error("Test regeneration failed")) : original(command, args);
  });
  await region.getByRole("button", { name: "Track actions for Alex", exact: true }).click();
  await page.getByRole("menuitem", { name: "Regenerate…", exact: true }).click();
  await page.getByRole("dialog", { name: "Regenerate Alex" }).getByRole("button", { name: "Regenerate track" }).click();
  await expect(region.getByRole("status").filter({ hasText: "0 tracks saved · 1 failed" })).toBeVisible();
  await expect(statuses).toHaveCount(2);
  await region.getByRole("button", { name: "Import AAF…", exact: true }).click();
  await expect(region.getByRole("img", { name: "Alex: Transcribed. Transcript saved." })).toBeVisible();
  await expect(statuses).toHaveCount(2);
});

test("Mic edits do not gate Generate, and typing does not invoke JKL playback", async ({ page }) => {
  await boot(page);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  await region.getByRole("textbox", { name: "Mic owner for track-1" }).fill("Updated Alex");
  await region.getByRole("heading", { name: "Interview", exact: true }).click();
  await expect(region.getByRole("button", { name: "Generate 3 tracks" })).toBeEnabled();
  await expect(region.getByText("Labels saved locally")).toBeVisible();
  // Opening a sequence silently warms audio; typing must not add playback work.
  await page.waitForTimeout(150);
  const beforeTyping = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string }[] }).__multitrackCalls.filter((call) => call.command === "aaf_prepare_audio").length);
  await region.getByRole("textbox", { name: "Mic owner for track-1" }).press("l");
  expect(await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string }[] }).__multitrackCalls.filter((call) => call.command === "aaf_prepare_audio").length)).toEqual(beforeTyping);
});

test("Twenty compact tracks, centered transport, additive Solo/Mute and settings", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); await boot(page, 20);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  const lanes = region.locator(".cp-multitrack-lanes"), last = region.locator(".cp-multitrack-lane").last();
  await expect(last).toBeVisible();
  const bounds = await lanes.boundingBox(), end = await last.boundingBox();
  expect(end!.y + end!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height + 1);
  const clipped = await region.locator(".cp-multitrack-lane").evaluateAll((rows) => rows.flatMap((row) => {
    const bounds = row.getBoundingClientRect();
    return Array.from(row.querySelectorAll("input,button")).filter((control) => { const box = control.getBoundingClientRect(); return box.top < bounds.top || box.bottom > bounds.bottom; }).map((control) => control.getAttribute("aria-label"));
  }));
  expect(clipped).toEqual([]);
  await expect(region.getByRole("button", { name: "Rewind tracks" })).toBeVisible();
  await expect(region.getByRole("button", { name: "Fast-forward tracks" })).toBeVisible();
  expect(await region.locator(".cp-multitrack-lane-audio").first().evaluate((element) => getComputedStyle(element).cursor)).toBe("default");
  const toolbar = await region.locator(".cp-multitrack-transport").boundingBox(), center = await region.locator(".cp-multitrack-transport-center").boundingBox();
  expect(Math.abs(center!.x + center!.width / 2 - toolbar!.x - toolbar!.width / 2)).toBeLessThan(2);
  await region.getByRole("button", { name: "Solo Alex mic", exact: true }).click();
  await region.getByRole("button", { name: "Solo Sam mic", exact: true }).click();
  await expect(region.getByRole("button", { name: "Solo Alex mic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(region.getByRole("button", { name: "Solo Sam mic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await region.getByRole("button", { name: "Solo Alex mic", exact: true }).click();
  await expect(region.getByRole("button", { name: "Solo Alex mic", exact: true })).toHaveAttribute("aria-pressed", "false");
  await region.getByRole("button", { name: "Mute Sam mic", exact: true }).click();
  await expect(region.getByRole("button", { name: "Mute Sam mic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(region.getByRole("button", { name: "Generate 20 tracks" })).toBeEnabled();
  await region.getByRole("button", { name: "Audio scrub" }).click();
  await expect(region.getByRole("button", { name: "Audio scrub" })).toHaveAttribute("aria-pressed", "false");
  await region.getByRole("button", { name: "Waveforms", exact: true }).click();
  await expect(region.locator("canvas.cp-track-wave")).toHaveCount(0);
  await region.getByRole("button", { name: "Waveforms", exact: true }).click();
  await expect(region.locator("canvas.cp-track-wave")).toHaveCount(20);
  await page.screenshot({ path: test.info().outputPath("twenty-track-toolbar.png") });
  await region.getByRole("button", { name: "AAF Audio settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "AAF Audio settings" }); await expect(settings).toBeVisible();
  await settings.press("Escape"); await expect(settings).toBeHidden();
  await expect(region.getByRole("button", { name: "AAF Audio settings", exact: true })).toBeFocused();
});

test("Pointer drag tracks continuously, zoom centers its position, and Text shows timed cues", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1020 }); await boot(page);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  const slider = region.getByRole("slider", { name: "Seek Alex mic", exact: true });
  const box = await slider.boundingBox();
  await page.mouse.move(box!.x + box!.width * .4, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * .65, box!.y + box!.height / 2, { steps: 12 });
  const during = Number(await slider.getAttribute("aria-valuenow")); expect(during).toBeGreaterThan(15000);
  await page.mouse.up();
  await region.getByRole("button", { name: "Zoom in", exact: true }).click();
  expect(await region.locator(".cp-multitrack-playhead").first().evaluate((element) => parseFloat((element as HTMLElement).style.left))).toBeCloseTo(50, 0);
  await region.getByRole("button", { name: "Generate 3 tracks" }).click();
  await expect(region.getByRole("button", { name: /This is the first answer/ })).toHaveCount(1);
  await region.getByRole("button", { name: "Fit", exact: true }).click();
  await region.getByRole("button", { name: "Text overlay Alex mic" }).click();
  await expect(region.locator(".cp-multitrack-text-overlay").getByText("1 passage")).toBeVisible();
  await region.getByRole("button", { name: /This is the first answer/ }).click();
  for (let step = 0; step < 6; step++) await region.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(region.locator(".cp-multitrack-text-overlay").getByText("This is the first answer.")).toBeVisible();
});

test("Transcript divider resizes at its actual boundary and Cast fields stay compact", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1020 }); await boot(page);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  const handle = region.getByRole("separator", { name: "Resize track transcripts" });
  const pane = region.locator(".cp-multitrack-transcript-pane");
  const before = (await pane.boundingBox())!;
  const grip = (await handle.boundingBox())!;
  expect(grip.x + grip.width / 2).toBeCloseTo(before.x, 0);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + 100); await page.mouse.down();
  await page.mouse.move(grip.x - 100, grip.y + 100, { steps: 5 }); await page.mouse.up();
  expect((await pane.boundingBox())!.width).toBeGreaterThan(before.width + 90);
  await handle.focus(); await handle.press("ArrowRight");
  expect(Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(400);
  await handle.press("Home"); await expect(handle).toHaveAttribute("aria-valuenow", "340");
  await region.getByText("Save Mic Owners as Cast", { exact: true }).click();
  const cast = page.getByRole("dialog", { name: "Mic owners and casts" });
  expect((await cast.boundingBox())!.width).toBeLessThanOrEqual(560);
  await cast.getByRole("textbox", { name: "New cast name" }).fill("Test cast");
  for (const control of await cast.locator("input,select,button").all()) {
    const box = (await control.boundingBox())!, outer = (await cast.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(outer.x + 3);
    expect(box.x + box.width).toBeLessThanOrEqual(outer.x + outer.width - 3);
  }
  expect(await region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("multitrack-results-layout.png") });
  await cast.press("Escape"); await expect(cast).toBeHidden();
  await expect(region.getByRole("button", { name: "Save Mic Owners as Cast" })).toBeFocused();
  await region.getByRole("button", { name: "Save Mic Owners as Cast" }).click();
  await expect(page.getByRole("textbox", { name: "New cast name" })).toHaveValue("Test cast");
});

test("Person navigation, per-track levels, context regeneration and safe exports", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1020 }); await boot(page, 20);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  await region.getByRole("button", { name: "Generate 20 tracks" }).click();
  await expect(region.getByRole("button", { name: /This is the first answer/ })).toHaveCount(1);
  await region.getByRole("combobox", { name: "Choose transcript" }).selectOption({ label: "Mic 20" });
  await expect(region.getByRole("tabpanel", { name: "Mic 20" })).toBeVisible();
  await expect(region.getByRole("tab", { name: "Mic 20", exact: true })).toBeInViewport();
  await region.getByRole("button", { name: "Solo Alex mic", exact: true }).click();
  await expect(region.locator(".cp-multitrack-lane.is-unsoloed")).toHaveCount(19);
  expect(await region.locator(".cp-multitrack-lane.is-unsoloed .cp-multitrack-waveform").first().evaluate((element) => getComputedStyle(element).filter)).toBe("grayscale(1)");
  const level = region.getByRole("button", { name: "Alex volume: 0 dB" }); await level.click();
  const group = page.getByRole("group", { name: "Alex volume controls" });
  await expect(group).toBeVisible(); await group.getByRole("slider").fill("12");
  await group.getByRole("slider").press("Escape");
  await expect(region.getByRole("button", { name: "Alex volume: +12 dB" })).toBeFocused();
  await region.getByRole("button", { name: "Alex volume: +12 dB" }).click();
  await region.getByRole("button", { name: "Alex volume: +12 dB" }).click(); await expect(group).toBeHidden();
  await region.locator(".cp-multitrack-lane").nth(1).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Actions for Sam mic" }); await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Regenerate…" }).click();
  const dialog = page.getByRole("dialog", { name: "Regenerate Sam mic" });
  await dialog.getByLabel("Engine").selectOption("whisper");
  await dialog.getByRole("button", { name: "Regenerate track" }).click(); await expect(dialog).toBeHidden();
  await expect(region.getByRole("button", { name: "Track actions for Sam mic" })).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[] }).__multitrackCalls.filter((call) => call.command === "aaf_transcribe_track").length)).toBe(21);
  const last = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[] }).__multitrackCalls.filter((call) => call.command === "aaf_transcribe_track").at(-1));
  expect(last!.args).toMatchObject({ trackId: "track-2", engine: "whisper", modelId: "large-v3" });
  await region.getByRole("button", { name: "Avid files by person" }).click();
  await expect(region.getByRole("status").filter({ hasText: "20 files saved in /exports" })).toBeVisible();
  const writes = await page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string; args: Record<string, unknown> }[] }).__multitrackCalls.filter((call) => call.command === "write_text_to_path"));
  expect(writes).toHaveLength(20); expect(writes.every((call) => call.args.unique === true && call.args.atomic === true)).toBe(true);
  expect(writes[0].args.text).toContain("Alex\t01:00:09:23\tA1\tred\t");
  await expect(region.locator(".cp-multitrack-editor-content > [role=alert]")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("multitrack-person-workspace.png") });
});

for (const width of [1100, 1920]) {
  test(`Compact gain fader, replacement typing and bottom-row popup at ${width}px`, async ({ page, browserName }) => {
    await page.setViewportSize({ width, height: width === 1100 ? 740 : 1080 }); await boot(page, 20);
    if (width === 1100) await page.evaluate(() => {
      for (const [token, size] of Object.entries({ sm: 12.5, base: 13.75, md: 15 })) document.documentElement.style.setProperty(`--text-${token}`, `${size}px`);
    });
    const region = page.getByRole("region", { name: "AAF Audio", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    await region.getByRole("combobox", { name: "Track size" }).selectOption("small");
    const level = region.getByRole("button", { name: "Mic 20 volume: 0 dB", exact: true });
    await level.scrollIntoViewIfNeeded(); await expect(level).toHaveText(""); await expect(level.locator("svg")).toHaveCount(1);
    const button = (await level.boundingBox())!, row = (await region.locator(".cp-multitrack-lane").last().boundingBox())!;
    expect(button.width).toBe(24); expect(button.height).toBe(24);
    expect(button.y).toBeGreaterThanOrEqual(row.y); expect(button.y + button.height).toBeLessThanOrEqual(row.y + row.height);
    await level.click();
    const popup = page.getByRole("group", { name: "Mic 20 volume controls" }), slider = popup.getByRole("slider"), number = popup.getByRole("textbox");
    await expect(slider).toBeFocused(); await expect(slider).toHaveAttribute("aria-orientation", "vertical");
    const bounds = (await popup.boundingBox())!, fader = (await slider.boundingBox())!, readout = (await number.boundingBox())!;
    await test.info().attach("gain-popover-geometry", { body: JSON.stringify({ bounds, fader, readout }), contentType: "application/json" });
    // Keep roughly half the former footprint without shrinking text or hit targets.
    // Baselines were measured with the same 100% / 125% text fixtures.
    const previousArea = 168 * (width === 1100 ? 378 : 371);
    expect(bounds.width).toBe(120);
    expect(bounds.width * bounds.height).toBeLessThanOrEqual(previousArea * 0.55);
    const resetButton = popup.getByRole("button", { name: "Reset to 0 dB" });
    await expect(resetButton).toHaveText(""); await expect(resetButton.locator("svg")).toHaveCount(1);
    await expect(popup.getByText("Above +12 dB can clip.")).toHaveCount(0);
    const reset = (await resetButton.boundingBox())!, zero = (await popup.locator(".cp-multitrack-gain-unity").boundingBox())!;
    expect(reset.width).toBe(24); expect(reset.height).toBe(24);
    expect(reset.x).toBeGreaterThanOrEqual(zero.x + zero.width + 4);
    expect(Math.abs(reset.y + reset.height / 2 - (zero.y + zero.height / 2))).toBeLessThan(1);
    for (const control of [fader, readout, reset]) {
      expect(control.width).toBeGreaterThanOrEqual(24); expect(control.height).toBeGreaterThanOrEqual(24);
      expect(control.x).toBeGreaterThan(bounds.x); expect(control.x + control.width).toBeLessThan(bounds.x + bounds.width);
    }
    expect(await popup.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
    expect(bounds.y).toBeGreaterThanOrEqual(8); expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height - 8);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8); expect(readout.y).toBeGreaterThan(fader.y + fader.height);
    expect(await number.evaluate(element => getComputedStyle(element).backgroundColor)).not.toBe("rgb(255, 255, 255)");
    const tickBoxes = await popup.locator(".cp-multitrack-gain-ticks > span").evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
    }));
    expect(tickBoxes).toHaveLength(6);
    for (let index = 1; index < tickBoxes.length; index++) expect(tickBoxes[index].top).toBeGreaterThan(tickBoxes[index - 1].bottom);
    await slider.press("End"); await expect(number).toHaveValue("+36 dB");
    await slider.press("ArrowDown"); await expect(number).toHaveValue("+35 dB");
    await slider.press("ArrowUp"); await expect(number).toHaveValue("+36 dB");
    // WebKit's default macOS Tab mode skips buttons; Option-Tab includes them.
    await slider.press(browserName === "webkit" ? "Alt+Tab" : "Tab"); await expect(resetButton).toBeFocused();
    await resetButton.press("Enter"); await expect(number).toHaveValue("0 dB");
    await slider.press("End");
    await number.click(); await expect(number).toBeFocused();
    expect(await number.evaluate(element => { const field = element as HTMLInputElement; return [field.selectionStart, field.selectionEnd]; })).toEqual([0, 6]);
    await number.pressSequentially("+10 dB"); await expect(number).toHaveValue("+10 dB"); await number.press("Enter");
    await expect(number).toHaveValue("+10 dB");
    await number.click(); await number.pressSequentially("-2.5"); await number.press("Tab");
    await expect(number).toHaveValue("-2.5 dB");
    await number.click(); await number.pressSequentially("jkl@!"); await expect(number).toHaveValue("-2.5 dB");
    await expect(region.getByRole("button", { name: "Play tracks", exact: true })).toBeVisible();
    await number.click(); await number.pressSequentially("+12"); await number.press("Escape");
    await expect(popup).toBeHidden();
    const updated = region.getByRole("button", { name: "Mic 20 volume: -2.5 dB", exact: true }); await expect(updated).toBeFocused();
    await updated.click(); await resetButton.click(); await expect(number).toHaveValue("0 dB");
    // A real pointer drag must run vertically, with the boost end at the top.
    await page.mouse.move(fader.x + fader.width / 2, fader.y + fader.height / 2); await page.mouse.down();
    await page.mouse.move(fader.x + fader.width / 2, fader.y, { steps: 6 }); await page.mouse.up();
    await expect(number).toHaveValue("+36 dB");
    await page.screenshot({ path: test.info().outputPath("multitrack-gain-fader.png") });
    await slider.press("Home"); await expect(number).toHaveValue("−∞ dB");
    await slider.press("Escape"); await expect(region.getByRole("button", { name: "Alex volume: 0 dB", exact: true })).toHaveCount(1);
  });
}

async function waveformInk(canvas: Locator) {
  return canvas.evaluate((element) => {
    const node = element as HTMLCanvasElement, context = node.getContext("2d")!;
    const { data } = context.getImageData(0, 0, node.width, node.height);
    let pixels = 0, top = node.height, bottom = -1;
    for (let y = 0; y < node.height; y++) for (let x = 0; x < node.width; x++) {
      // Ignore the faint centre axis; measure the actual peak envelope.
      if (data[(y * node.width + x) * 4 + 3] > 128) { pixels++; top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    return { pixels, top, bottom, height: node.height, image: node.toDataURL() };
  });
}

test("Track gain redraws cached waveforms at every density and zoom without changing other tracks", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 }); await boot(page, 20);
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  const canvases = region.locator("canvas.cp-track-wave"), first = canvases.first();
  await expect(canvases).toHaveCount(20);
  const waveformCalls = () => page.evaluate(() => (window as unknown as { __multitrackCalls: { command: string }[] }).__multitrackCalls.filter(call => call.command === "aaf_waveform").length);
  const initialCalls = await waveformCalls();
  for (const density of ["small", "medium", "large"]) {
    await region.getByRole("combobox", { name: "Track size" }).selectOption(density);
    await expect(region.getByRole("region", { name: "Audio tracks", exact: true })).toHaveClass(new RegExp(`cp-multitrack-density-${density}`));
    // The prior bitmap still has ink while ResizeObserver is queuing the new
    // density. Compare gain/reset only after the canvas matches its CSS size.
    await expect.poll(() => first.evaluate((element: HTMLCanvasElement) => element.height === Math.round(element.getBoundingClientRect().height * window.devicePixelRatio))).toBe(true);
    await expect.poll(async () => (await waveformInk(first)).pixels).toBeGreaterThan(0);
    const baseline = await waveformInk(first), other = await waveformInk(canvases.nth(1));
    await region.getByRole("button", { name: "Alex volume: 0 dB", exact: true }).click();
    const popup = page.getByRole("group", { name: "Alex volume controls" }), fader = popup.getByRole("slider");
    await fader.fill("12");
    await expect.poll(async () => (await waveformInk(first)).pixels).toBeGreaterThan(baseline.pixels);
    await fader.fill("-12");
    await expect.poll(async () => (await waveformInk(first)).pixels).toBeLessThan(baseline.pixels);
    await fader.press("End");
    const boosted = await waveformInk(first);
    expect(boosted.pixels).toBeGreaterThan(baseline.pixels);
    expect(boosted.top).toBeGreaterThan(0); expect(boosted.bottom).toBeLessThan(boosted.height - 1);
    if (density === "large") await page.screenshot({ path: test.info().outputPath("waveform-gain-boost.png") });
    await fader.press("Home");
    await expect.poll(async () => (await waveformInk(first)).pixels).toBe(0);
    await popup.getByRole("textbox").fill("+6 dB"); await popup.getByRole("textbox").press("Enter");
    await expect.poll(async () => (await waveformInk(first)).pixels).toBeGreaterThan(baseline.pixels);
    await popup.getByRole("button", { name: "Reset to 0 dB" }).click();
    await expect.poll(async () => (await waveformInk(first)).image).toBe(baseline.image);
    expect((await waveformInk(canvases.nth(1))).image).toBe(other.image);
    await fader.press("Escape");
    expect(await waveformCalls()).toBe(initialCalls);
  }
  await region.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect.poll(waveformCalls).toBe(initialCalls + 20);
  const detailed = await waveformInk(first), callsAfterZoom = await waveformCalls();
  await region.getByRole("button", { name: "Alex volume: 0 dB", exact: true }).click();
  const popup = page.getByRole("group", { name: "Alex volume controls" });
  await popup.getByRole("slider").fill("12");
  await expect.poll(async () => (await waveformInk(first)).pixels).toBeGreaterThan(detailed.pixels);
  await popup.getByRole("slider").press("Escape");
  expect(await waveformCalls()).toBe(callsAfterZoom);
});

test("Full workspace stays usable with enlarged text at 1100px", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 740 }); await boot(page, 20);
  await page.evaluate(() => {
    for (const [token, value] of Object.entries({ xs: 11.875, sm: 12.5, base: 13.75, md: 15, lg: 16.25, xl: 17.5, "2xl": 18.75, "3xl": 22.5 })) document.documentElement.style.setProperty(`--text-${token}`, `${value}px`);
  });
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  await region.getByRole("button", { name: "Generate 20 tracks" }).click();
  await expect(region.getByRole("button", { name: /This is the first answer/ })).toHaveCount(1);
  expect(await region.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  const generation = (await region.locator(".cp-multitrack-generation").boundingBox())!, output = (await region.locator(".cp-multitrack-export").boundingBox())!;
  expect(Math.abs(generation.y - output.y)).toBeLessThan(1);
  const label = region.locator(".cp-multitrack-lane-label").first();
  for (const control of await label.locator("input,button").all()) {
    const box = (await control.boundingBox())!, bounds = (await label.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(bounds.y); expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
    expect(box.x).toBeGreaterThanOrEqual(bounds.x); expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  for (const button of await region.locator(".cp-multitrack-generate-row button:visible, .cp-multitrack-export button:visible").all()) {
    await button.scrollIntoViewIfNeeded();
    expect(await button.evaluate((element) => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("multitrack-enlarged-workspace.png") });
});
