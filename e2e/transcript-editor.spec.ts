import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture, multitrackGroupFixture, multitrackTranscript } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

/**
 * String Outs, driven from the nav rail with the backend mocked at
 * the invoke seam. The undo log is a small in-memory stand-in for
 * edit_log.rs: each commit is a new head, undo walks back. What this proves
 * is the wiring (picker, session, sources, text, delete, undo labels), not the
 * Rust store, which has its own tests.
 */
async function boot(page: Page, grouped = false, picture = false) {
  // Grouped: Sam's and the room's mics are angles inside Alex's multigroup.
  const fixture = grouped ? multitrackGroupFixture() : multitrackFixture();
  // Picture: V1 is one group clip, as a multicam sequence from Avid carries it. Metadata only.
  if (picture && fixture.manifest.graph) fixture.manifest.graph.picture_tracks = [{ slot_id: 10, physical_track_number: 1, name: "V1", component: "Sequence",
    clips: [{ start_frame: 0, duration_frames: 24000, kind: "clip", name: "CAM A", master_mob_id: null, file_mob_id: null, tape_name: null, source_start_frame: null,
      source_timecode_fps: null, source_drop_frame: null, group: true, effect: null, descriptor: null }] }];
  fixture.labels = [{ track_id: "track-1", owner_name: "Alex", cast_member_id: null, color: null }, { track_id: "track-2", owner_name: "Sam", cast_member_id: null, color: null }];
  const cue = (id: string, from: number, to: number, text: string) => ({ id, start_sample: from * 16_000, end_sample: to * 16_000, text, boundary_review: false });
  fixture.transcripts = [
    { ...multitrackTranscript("track-1"), cues: [cue("a1", 10, 13, "I moved here in May."), cue("a2", 40, 44, "Then Rosa called me.")] },
    { ...multitrackTranscript("track-2"), cues: [cue("b1", 20, 24, "Sam answers the door.")] },
  ];
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((document) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    type Doc = { title: string };
    type Stored = { states: { id: number; parent: number | null; label: string; document: Doc }[]; head: number };
    // Kept in sessionStorage so a reload finds the same store, the way the
    // app finds timelines.sqlite again on the next launch.
    const edits = new Map<string, Stored>(JSON.parse(sessionStorage.getItem("e2e.edits") ?? "[]") as [string, Stored][]);
    const persist = () => sessionStorage.setItem("e2e.edits", JSON.stringify([...edits]));
    const headOf = (id: string) => {
      const edit = edits.get(id)!, state = edit.states.find((item) => item.id === edit.head)!;
      const parent = edit.states.find((item) => item.id === state.parent);
      const child = [...edit.states].reverse().find((item) => item.parent === state.id);
      return { state: state.id, label: state.label, document: state.document, undo: parent ? state.label : null, redo: child?.label ?? null };
    };
    const app = window as unknown as { __editCalls: string[]; __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
    app.__editCalls = [];
    const original = app.__TAURI_INTERNALS__.invoke;
    const words = (track: string) => document.transcripts.filter((t) => t.track_id === track).flatMap((t) => t.cues.flatMap((c) => {
      const parts = c.text.split(" "), step = (c.end_sample - c.start_sample) / parts.length;
      return parts.map((text, index) => ({ cue_id: c.id, text, start_sample: Math.round(c.start_sample + index * step), end_sample: Math.round(c.start_sample + (index + 1) * step) }));
    }));
    app.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      app.__editCalls.push(command);
      if (command.startsWith("edit_")) queueMicrotask(persist);
      const id = args.id as string;
      switch (command) {
        case "aaf_list": return Promise.resolve([{ id: document.id, name: document.manifest.name, track_count: 3, transcribed_tracks: 2, source_path: document.source_path }]);
        case "aaf_open": return Promise.resolve(document);
        case "aaf_speech": return Promise.resolve({ track_id: args.trackId, floor_db: -60, activity: [[160_000, 720_000]], reactions: [], words: words(args.trackId as string), measured: true });
        case "aaf_waveform": return Promise.resolve({ track_id: args.trackId, peaks: [] });
        case "edit_list": return Promise.resolve([...edits.entries()].map(([key, edit]) => ({ id: key, title: headOf(key).document.title, created_at: 1, updated_at: 2, head: edit.head, states: edit.states.length })));
        case "edit_create": edits.set(id, { states: [{ id: 1, parent: null, label: "New Edit", document: args.document as Doc }], head: 1 }); return Promise.resolve(headOf(id));
        case "edit_head": return edits.has(id) ? Promise.resolve(headOf(id)) : Promise.reject(new Error("no such edit"));
        case "edit_commit": { const edit = edits.get(id)!; const next = edit.states.length + 1; edit.states.push({ id: next, parent: edit.head, label: args.label as string, document: args.document as Doc }); edit.head = next; return Promise.resolve(headOf(id)); }
        case "edit_undo": { const edit = edits.get(id)!; edit.head = edit.states.find((s) => s.id === edit.head)!.parent ?? edit.head; return Promise.resolve(headOf(id)); }
        case "edit_redo": { const edit = edits.get(id)!; const child = [...edit.states].reverse().find((s) => s.parent === edit.head); if (child) edit.head = child.id; return Promise.resolve(headOf(id)); }
        case "edit_history": { const edit = edits.get(id)!; return Promise.resolve({ head: edit.head, states: edit.states.map(({ id: state, parent, label }) => ({ id: state, parent, label, at: state, pinned: null })), next: [] }); }
        default: return original(command, args);
      }
    };
  }, fixture);
  await page.goto("/");
  await page.getByRole("button", { name: "String Outs", exact: true }).click();
  await expect(page.getByRole("main", { name: "String Outs" })).toBeVisible();
}

test("a first visit welcomes, and a new empty string out opens with nothing to export", async ({ page }) => {
  await boot(page);
  await expect(page.getByRole("heading", { name: "Pull the story out, bite by bite" })).toBeVisible();
  await page.getByRole("main", { name: "String Outs" }).getByRole("button", { name: "New string out…" }).last().click();
  await page.getByLabel("Title").fill("Rosa stringout");
  // With one saved sequence the form preselects it; choose the empty timeline.
  await page.getByLabel("Start from").selectOption({ label: "An empty timeline" });
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Rosa stringout" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pull the story out, bite by bite" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Export AAF/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  // Nothing to cut from: the timeline says where sequences come from.
  await expect(page.getByText("Nothing to cut from yet.", { exact: false })).toBeVisible();
});

test("a sequence added with nothing cut in offers the whole sequence, in one undoable step", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  // A new string out starts empty, as a new sequence does in Avid: it is built from chunks of the source.
  await expect(page.getByLabel(/whole sequence/i)).not.toBeChecked();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("combobox", { name: /^Who plays on A\d+$/ })).toHaveCount(0);
  const add = page.getByRole("button", { name: "Add all of Interview" });
  await expect(add).toBeVisible();
  await add.click();
  await expect(add).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Added the whole sequence." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo Add Whole Sequence" })).toBeEnabled();
});

test("an edit from a sequence shows its words, and a delete is one undoable step", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  await page.getByLabel(/whole sequence/i).check();
  await page.getByRole("button", { name: "Create" }).click();
  const moved = page.locator(".cp-te-doc [data-index]", { hasText: "moved" }).first();
  await expect(moved).toBeVisible();
  await expect(page.locator(".cp-te-doc")).toContainText("Sam answers the door.");
  // Play and the readouts lead the timeline's tool row; there is no line of their own.
  await expect(page.getByRole("toolbar", { name: "Timeline tools" }).getByRole("group", { name: "Transport" })).toBeVisible();
  // Undo and redo side by side, and every person's name whole in its track header.
  const [undoBox, redoBox] = await Promise.all([page.locator(".cp-te-undo button").first().boundingBox(), page.locator(".cp-te-undo button").last().boundingBox()]);
  expect(Math.abs(undoBox!.y - redoBox!.y)).toBeLessThan(1);
  expect(redoBox!.x).toBeGreaterThan(undoBox!.x);
  // Each record track says who is patched to it (the patch panel), and no header overflows.
  expect(await page.getByRole("combobox", { name: /^Who plays on A\d+$/ }).count()).toBeGreaterThan(0);
  expect(await page.locator(".cp-te-tl-head").evaluateAll((all) => all.filter((head) => head.scrollWidth > head.clientWidth + 1).length)).toBe(0);
  await page.locator(".cp-te-doc [data-index]", { hasText: "Rosa" }).first().dblclick();
  await page.keyboard.press("Backspace");
  const undo = page.getByRole("button", { name: /^Undo / });
  await expect(undo).toBeEnabled();
  await expect(undo).toHaveAccessibleName(/Undo (Delete|Remove)/);
  await page.keyboard.press("Meta+z");
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
});

test("Insert splices at the record playhead, as Avid's V does, and Overwrite (B) replaces what is there", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  await page.getByLabel(/whole sequence/i).check();
  await page.getByRole("button", { name: "Create" }).click();
  const record = page.locator(".cp-te-doc");
  await expect(record).toContainText("Then Rosa called me.");
  // Park the playhead about 32 s in, after Sam's line (20-24 s) and before Alex's second (40 s), by clicking the timeline.
  const ruler = (await page.locator(".cp-te-tl-ruler").boundingBox())!;
  await page.mouse.click(ruler.x + ruler.width * 0.032, ruler.y + ruler.height / 2);
  await page.getByRole("tab", { name: "Sam" }).click();
  const source = page.locator(".cp-te-src-body");
  await source.locator("[data-src-index]", { hasText: "Sam" }).first().click();
  await source.locator("[data-src-index]", { hasText: "door." }).first().click({ modifiers: ["Shift"] });
  await page.keyboard.press("v");
  await expect(page.getByRole("status").filter({ hasText: /Inserted 4 words at 01:00:(2[4-9]|3\d)/ })).toBeVisible();
  // Not at the start: the cut still opens on Alex, and Sam's line now plays twice, before Alex's second line.
  const lines = () => record.locator(".cp-te-para").evaluateAll((all) => all.map((paragraph) => paragraph.textContent ?? ""));
  await expect.poll(async () => (await lines()).map((text) => /moved/.test(text) ? "alex" : /door/.test(text) ? "sam" : /Rosa/.test(text) ? "rosa" : "?")).toEqual(["alex", "sam", "sam", "rosa"]);
  await expect(page.getByRole("button", { name: /^Undo Insert 4 Words/ })).toBeEnabled();
  // B lays the same line over what follows the new clip: the cut keeps its length.
  const total = page.locator(".cp-te-transport .cp-te-readout-of").first();
  const before = await total.textContent();
  await page.keyboard.press("b");
  await expect(page.getByRole("button", { name: "Undo Overwrite" })).toBeEnabled();
  await expect(total).toHaveText(before!);
});

test("marks clear the Avid way on both sides: G, D and F, and the × on the marked range", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  await page.getByLabel(/whole sequence/i).check();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".cp-te-doc")).toContainText("Then Rosa called me.");
  const ruler = page.locator(".cp-te-tl-ruler"), box = (await ruler.boundingBox())!;
  const range = ruler.locator(".cp-te-tl-marked");
  const record = page.locator(".cp-te-transport .cp-te-readout-tc").first();
  // Park the playhead, and wait for it to land before marking there.
  const park = async (fraction: number) => {
    const before = await record.textContent();
    await page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
    await expect(record).not.toHaveText(before!);
  };
  // Straight after opening, focus is on the view around the editor: the keys still reach it.
  await park(0.03); await page.keyboard.press("i"); await park(0.05); await page.keyboard.press("o");
  await expect(range).toHaveCount(1);
  await page.keyboard.press("g");
  await expect(range).toHaveCount(0);
  // D clears In alone, so no closed range and no ×; F then clears Out.
  await park(0.03); await page.keyboard.press("i"); await park(0.05); await page.keyboard.press("o");
  await page.keyboard.press("d");
  await expect(range).toHaveCount(0);
  await expect(ruler.locator(".cp-mark.out")).toHaveCount(1);
  await page.keyboard.press("f");
  await expect(ruler.locator(".cp-mark")).toHaveCount(0);
  // The × on a closed range clears both, with its key in the tooltip.
  await park(0.03); await page.keyboard.press("i"); await park(0.05); await page.keyboard.press("o");
  const clear = page.getByRole("button", { name: "Clear marks" });
  await expect(clear).toHaveAttribute("title", "Clear marks (G)");
  await clear.click();
  await expect(range).toHaveCount(0);
  // Q goes to In; J steps back a second (the engine plays forward only).
  await park(0.03); await page.keyboard.press("i"); await park(0.05);
  await page.keyboard.press("q");
  const atIn = await record.textContent();
  await page.keyboard.press("j");
  await expect(record).not.toHaveText(atIn!);
  // On the source side, G clears the text that marks it.
  await page.getByRole("radio", { name: "Source" }).click();
  const source = page.locator(".cp-te-src-body");
  await source.locator("[data-src-index]", { hasText: "Then" }).first().click();
  await source.locator("[data-src-index]", { hasText: "me." }).first().click({ modifiers: ["Shift"] });
  await expect(range).toHaveCount(1);
  await page.keyboard.press("g");
  await expect(range).toHaveCount(0);
  await expect(source.locator(".cp-te-src-word.is-selected")).toHaveCount(0);
});

test("a group angle has no track until their words are cut in, then plays on one of their own", async ({ page }) => {
  await boot(page, true);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  await page.getByLabel(/whole sequence/i).check();
  await page.getByRole("button", { name: "Create" }).click();
  const record = page.locator(".cp-te-doc");
  // Who each record track plays, top-down: the patch panel in the track headers.
  const patched = () => page.getByRole("combobox", { name: /^Who plays on A\d+$/ }).evaluateAll((all) => all.map((panel) => (panel as HTMLSelectElement).selectedOptions[0]?.text));
  await expect(record).toContainText("I moved here in May.");
  // Sam is a person (the source pane has his words) but on no track, so the cut does not play him.
  await expect.poll(patched).toEqual(["Alex"]);
  await expect(record).not.toContainText("Sam answers the door.");
  // The source reads a person at a time, as AAF Audio does: Sam's words are under his tab.
  await page.getByRole("tab", { name: "Sam" }).click();
  const source = page.locator(".cp-te-src-body");
  await source.locator("[data-src-index]", { hasText: "Sam" }).first().click();
  await source.locator("[data-src-index]", { hasText: "door." }).first().click({ modifiers: ["Shift"] });
  await page.getByRole("button", { name: "Append", exact: true }).click();
  await expect(page.getByText("Sam is now on a track.", { exact: false })).toBeVisible();
  await expect.poll(patched).toEqual(["Alex", "Sam"]);
  await expect(page.getByRole("button", { name: "Track A2" })).toBeVisible();
  await expect(record).toContainText("Sam answers the door.");
  await expect(page.getByRole("button", { name: /^Undo Insert/ })).toBeEnabled();
  await page.getByRole("button", { name: "Take Sam off a track" }).click();
  await expect.poll(patched).toEqual(["Alex"]);
  await expect(record).not.toContainText("Sam answers the door.");
});

test("Source shows the loaded sequence's mics, its group alternates and V1, and what is marked there cuts into the record", async ({ page }) => {
  await boot(page, true, true);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  // An empty record, the way Avid starts a new sequence: the cut is built from the source.
  await page.getByRole("button", { name: "Create" }).click();
  const record = page.locator(".cp-te-doc");
  await page.getByRole("radio", { name: "Source" }).click();
  const rows = page.locator("[data-source-track]");
  // Alex's track; Sam's and the room's mics are alternates inside his group, closed as AAF Audio opens it.
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("list", { name: "Picture cuts on V1" })).toContainText("CAM A");
  await page.getByRole("button", { name: "Alternative microphones for A1" }).click();
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1).locator(".cp-te-tl-branch")).toHaveAttribute("title", "Group fixture");
  // As in AAF Audio the main track is on and its alternates off: what Insert brings.
  expect(await rows.locator(".cp-te-tl-track").evaluateAll((all) => all.map((button) => button.getAttribute("aria-pressed")))).toEqual(["true", "false", "false"]);
  // The tool row is the same one; its record-only edits rest while the source shows.
  await expect(page.getByRole("button", { name: "Add edit at playhead" })).toBeDisabled();
  // Selecting text marks the source, on the source timeline's ruler too.
  const source = page.locator(".cp-te-src-body");
  await source.locator("[data-src-index]", { hasText: "Then" }).first().click();
  await source.locator("[data-src-index]", { hasText: "me." }).first().click({ modifiers: ["Shift"] });
  await expect(page.locator(".cp-te-tl-ruler .cp-te-tl-marked")).toHaveCount(1);
  // The room's mic turned on: the clip brings it too. The record starts with no tracks and
  // patches the clip's people top-down in the sequence's order: Alex on A1, the room on A2.
  await rows.nth(2).locator(".cp-te-tl-track").click();
  await page.getByRole("button", { name: "Append", exact: true }).click();
  await page.getByRole("radio", { name: "Record" }).click();
  await expect(rows).toHaveCount(0);
  await expect(record).toContainText("Then Rosa called me.");
  const patched = () => page.getByRole("combobox", { name: /^Who plays on A\d+$/ }).evaluateAll((all) => all.map((panel) => (panel as HTMLSelectElement).selectedOptions[0]?.text));
  await expect.poll(patched).toEqual(["Alex", "Room"]);
  // The patch panel: put the room on A1, and Alex moves down.
  await page.getByRole("combobox", { name: "Who plays on A1" }).selectOption({ label: "Room" });
  await expect.poll(patched).toEqual(["Room", "Alex"]);
  await expect(page.getByRole("button", { name: "Undo Patch Room to A1" })).toBeEnabled();
});

test("a new string out has no record tracks until someone is patched, and the empty track below patches the next one", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  await page.getByRole("button", { name: "Create" }).click();
  // Nothing cut in yet: no record tracks at all, only the empty one to patch someone to.
  await expect(page.getByRole("combobox", { name: /^Who plays on A\d+$/ })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Patch someone to A1" })).toBeVisible();
  await page.getByRole("combobox", { name: "Patch someone to A1" }).selectOption({ label: "Sam" });
  const patched = () => page.getByRole("combobox", { name: /^Who plays on A\d+$/ }).evaluateAll((all) => all.map((panel) => (panel as HTMLSelectElement).selectedOptions[0]?.text));
  await expect.poll(patched).toEqual(["Sam"]);
});

test("One per person makes a string out for each person who speaks", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  await page.getByRole("button", { name: "One per person" }).click();
  await expect(page.getByRole("heading", { name: "SO_Interview_Alex" })).toBeVisible();
  const created = await page.evaluate(() => (window as unknown as { __editCalls: string[] }).__editCalls.filter((c) => c === "edit_create").length);
  expect(created).toBe(2);
});

test("coming back reopens the string out that was open, not the welcome", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Title").fill("Keep me");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name: "Keep me" })).toBeVisible();
  // A relaunch: the page is rebuilt from nothing, so only what was
  // remembered can bring the string out back.
  await page.reload();
  await page.getByRole("button", { name: "String Outs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Keep me" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pull the story out, bite by bite" })).toHaveCount(0);
});

test("the left column is Ask, Inspector, History, with a plain prompt", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  await page.getByLabel(/whole sequence/i).check();
  await page.getByRole("button", { name: "Create" }).click();
  const tabs = page.getByRole("tablist", { name: "String out panels" }).getByRole("tab");
  await expect(tabs).toHaveText(["Ask", "Inspector", "History"]);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  const prompt = page.getByRole("combobox", { name: /Ask anything/ });
  await expect(prompt).toHaveAttribute("placeholder", "Ask anything");
  const box = await prompt.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(100);
  // The column sits to the left of the source and the string out.
  const side = await page.locator(".cp-te-pane-side").boundingBox(), record = await page.locator(".cp-te-pane-record").boundingBox();
  expect(side!.x).toBeLessThan(record!.x);
  await tabs.nth(1).click();
  await expect(page.getByRole("complementary", { name: "Inspector" })).toBeVisible();
  await page.keyboard.press("Meta+y");
  await expect(tabs.nth(2)).toHaveAttribute("aria-selected", "true");
});
