import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture, multitrackTranscript } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

/**
 * String Outs, driven from the nav rail with the backend mocked at
 * the invoke seam. The undo log is a small in-memory stand-in for
 * edit_log.rs: each commit is a new head, undo walks back. What this proves
 * is the wiring (picker, session, sources, text, delete, undo labels), not the
 * Rust store, which has its own tests.
 */
async function boot(page: Page) {
  const fixture = multitrackFixture();
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
        case "aaf_speech": return Promise.resolve({ track_id: args.trackId, floor_db: -60, activity: [[160_000, 720_000]], reactions: [], words: words(args.trackId as string) });
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
});

test("an edit from a sequence shows its words, and a delete is one undoable step", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Interview" });
  await page.getByRole("button", { name: "Create" }).click();
  const moved = page.locator(".cp-te-doc [data-index]", { hasText: "moved" }).first();
  await expect(moved).toBeVisible();
  await expect(page.locator(".cp-te-doc")).toContainText("Sam answers the door.");
  await page.locator(".cp-te-doc [data-index]", { hasText: "Rosa" }).first().dblclick();
  await page.keyboard.press("Backspace");
  const undo = page.getByRole("button", { name: /^Undo / });
  await expect(undo).toBeEnabled();
  await expect(undo).toHaveAccessibleName(/Undo (Delete|Remove)/);
  await page.keyboard.press("Meta+z");
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
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
