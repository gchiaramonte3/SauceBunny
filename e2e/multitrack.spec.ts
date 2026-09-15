import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture, multitrackTranscript } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

async function boot(page: Page, trackCount = 3) {
  // Silent, duration-correct PCM exercises browser decoding without private
  // media or a nonexistent asset:// URL masking unrelated UI failures.
  await page.route("**/e2e-mock/solo-*.wav", (route) => {
    const frames = Number(new URL(route.request().url()).pathname.match(/solo-(\d+)\.wav$/)?.[1]);
    const samples = Math.ceil(frames * 1001 / 24000 * 16000), body = Buffer.alloc(44 + samples * 2);
    body.write("RIFF", 0); body.writeUInt32LE(body.length - 8, 4); body.write("WAVEfmt ", 8);
    body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22);
    body.writeUInt32LE(16000, 24); body.writeUInt32LE(32000, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34);
    body.write("data", 36); body.writeUInt32LE(samples * 2, 40);
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
      if (command === "plugin:dialog|open") return Promise.resolve((args.options as { directory?: boolean })?.directory ? "/exports" : fixture.source_path);
      if (command === "plugin:dialog|save") return Promise.resolve("/exports/transcript.txt");
      if (command === "write_text_to_path") return Promise.resolve(args.path);
      if (command === "aaf_import" || command === "aaf_open") return Promise.resolve(fixture);
      if (command === "aaf_save_labels") { fixture.labels = args.labels as typeof fixture.labels; return Promise.resolve(fixture); }
      if (command === "aaf_waveform") return Promise.resolve({ track_id: args.trackId, peaks: Array.from({ length: 400 }, (_, index) => { const height = (index % 19) / 20; return [-height, height]; }) });
      if (command === "parakeet_model_downloaded") return Promise.resolve(true);
      if (command === "list_whisper_models") return Promise.resolve([{ id: "large-v3", name: "Large v3", downloaded: true }]);
      if (command === "aaf_transcribe_track") return Promise.resolve({ ...transcript, track_id: args.trackId, start_frame: args.startFrame, duration_frames: args.durationFrames });
      if (command === "aaf_prepare_audio") return Promise.resolve({ path: `/e2e-mock/solo-${args.durationFrames}.wav`, start_frame: args.startFrame, duration_frames: args.durationFrames, sample_rate: 16000, sample_count: Math.ceil(Number(args.durationFrames) * 1001 / 24000 * 16000), peaks: [] });
      return original(command, args);
    };
  }, { document: { ...multitrackFixture(), manifest: { ...multitrackFixture().manifest, tracks: Array.from({ length: trackCount }, (_, index) => ({ ...multitrackFixture().manifest.tracks[index % 3], id: `track-${index + 1}`, name: index < 3 ? multitrackFixture().manifest.tracks[index].name : `Mic ${index + 1}` })) } }, transcript: multitrackTranscript() });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.locator(".cp-nav-item").filter({ hasText: "Multitrack" }).click();
  await expect(page.getByRole("heading", { name: "Multitrack", exact: true })).toBeVisible();
}

for (const viewport of [{ width: 1100, height: 740 }, { width: 1680, height: 1020 }]) {
  test(`Multitrack import and whole-sequence transcript flow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await boot(page);
    const region = page.getByRole("region", { name: "Multitrack", exact: true });
    await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
    await expect(region.getByRole("heading", { name: "Interview", exact: true })).toBeVisible();
    await expect(region.getByRole("slider", { name: /^Seek / })).toHaveCount(3);
    const generate = region.getByRole("button", { name: "Generate 3 tracks", exact: true });
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(region.getByRole("status").filter({ hasText: "Selected range saved for every track" })).toBeVisible();
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

test("Mic edits do not gate Generate, and typing does not invoke JKL playback", async ({ page }) => {
  await boot(page);
  const region = page.getByRole("region", { name: "Multitrack", exact: true });
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
  const region = page.getByRole("region", { name: "Multitrack", exact: true });
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
  await region.getByRole("button", { name: "Multitrack settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Multitrack settings" }); await expect(settings).toBeVisible();
  await settings.press("Escape"); await expect(settings).toBeHidden();
  await expect(region.getByRole("button", { name: "Multitrack settings", exact: true })).toBeFocused();
});

test("Pointer drag tracks continuously, zoom centers its position, and Text shows timed cues", async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1020 }); await boot(page);
  const region = page.getByRole("region", { name: "Multitrack", exact: true });
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
  const region = page.getByRole("region", { name: "Multitrack", exact: true });
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
  const region = page.getByRole("region", { name: "Multitrack", exact: true });
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
  expect(writes[0].args.text).toContain("Alex\t01:00:09:23\tV1\tred\t");
  await expect(region.locator(".cp-multitrack-editor-content > [role=alert]")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("multitrack-person-workspace.png") });
});

for (const width of [1100, 1920]) {
  test(`Compact gain fader, replacement typing and bottom-row popup at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1100 ? 740 : 1080 }); await boot(page, 20);
    if (width === 1100) await page.evaluate(() => {
      for (const [token, size] of Object.entries({ sm: 12.5, base: 13.75, md: 15 })) document.documentElement.style.setProperty(`--text-${token}`, `${size}px`);
    });
    const region = page.getByRole("region", { name: "Multitrack", exact: true });
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
    await updated.click(); await popup.getByRole("button", { name: "Reset to 0 dB" }).click();
    // A real pointer drag must run vertically, with the boost end at the top.
    await page.mouse.move(fader.x + fader.width / 2, fader.y + fader.height / 2); await page.mouse.down();
    await page.mouse.move(fader.x + fader.width / 2, fader.y, { steps: 6 }); await page.mouse.up();
    await expect(number).toHaveValue("+36 dB");
    await page.screenshot({ path: test.info().outputPath("multitrack-gain-fader.png") });
    await slider.press("Home"); await expect(number).toHaveValue("−∞ dB");
    await slider.press("Escape"); await expect(region.getByRole("button", { name: "Alex volume: 0 dB", exact: true })).toHaveCount(1);
  });
}

test("Full workspace stays usable with enlarged text at 1100px", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 740 }); await boot(page, 20);
  await page.evaluate(() => {
    for (const [token, value] of Object.entries({ xs: 11.875, sm: 12.5, base: 13.75, md: 15, lg: 16.25, xl: 17.5, "2xl": 18.75, "3xl": 22.5 })) document.documentElement.style.setProperty(`--text-${token}`, `${value}px`);
  });
  const region = page.getByRole("region", { name: "Multitrack", exact: true });
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
  for (const button of await region.locator(".cp-multitrack-generate-row button, .cp-multitrack-export button").all()) {
    await button.scrollIntoViewIfNeeded();
    expect(await button.evaluate((element) => { const box = element.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })).toBe(true);
  }
  await page.screenshot({ path: test.info().outputPath("multitrack-enlarged-workspace.png") });
});
