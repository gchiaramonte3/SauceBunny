// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AafOwnership } from "../bindings/AafOwnership";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let answer: AafOwnership;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd === "aaf_ownership") return answer;
    if (cmd === "aaf_check_voices") return { ...answer, voices: 2, warnings: ["Alex's mic may have changed hands: later in the day it sounds like Sam."], counts: { ...answer.counts, unsure: 0 } };
    return null;
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

import { MultitrackTranscript } from "./MultitrackTranscript";

// Alex says "This is the first answer." on track 1; Sam's mic heard it too.
function fixture() {
  const document = multitrackFixture();
  document.labels.push({ track_id: "track-2", owner_name: "Sam", cast_member_id: null, color: null });
  document.transcripts = [multitrackTranscript("track-1"), { ...multitrackTranscript("track-2"), cues: [{ ...multitrackTranscript().cues[0], id: "sam-1", text: "This is the first answer." }] }];
  return document;
}
const bleed = (index: number) => ({ track_id: "track-2", cue_id: "sam-1", index, label: "bleed" as const, heard_on: "track-1", delta_db: -16, manual: false });

beforeEach(() => {
  calls.length = 0;
  answer = { document_id: "sequence-test", measured: ["track-1", "track-2"], missing: [], stamp: "s", counts: { owner: 5, bleed: 5, overtalk: 0, offmic: 0, unsure: 0, other: 0 }, warnings: [], voices: 0, words: [0, 1, 2, 3, 4].map(bleed) };
});
afterEach(cleanup);

it("hides a line heard on the wrong mic from All voices, and says so", async () => {
  render(<MultitrackTranscript document={fixture()} frame={0} solo={new Set()} onSeek={vi.fn()} initialAll />);
  await screen.findByText("1 line heard on another mic hidden.");
  const body = screen.getByRole("tabpanel");
  expect(within(body).getAllByRole("button", { name: /first answer/ })).toHaveLength(1);
  fireEvent.click(screen.getByLabelText("Show bleed"));
  expect(within(body).getAllByRole("button", { name: /first answer/ })).toHaveLength(2);
  expect(within(body).getByText("Heard on Alex's mic")).toBeTruthy();
});

it("keeps the bleed line on its own mic's tab, dimmed, and lets the editor overrule it", async () => {
  render(<MultitrackTranscript document={fixture()} frame={0} solo={new Set()} onSeek={vi.fn()} />);
  fireEvent.click(await screen.findByRole("tab", { name: /Sam/ }));
  const line = await waitFor(() => screen.getByRole("button", { name: /Heard on Alex's mic/ }));
  expect(line.className).toContain("is-bleed");
  fireEvent.contextMenu(line, { clientX: 20, clientY: 20 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Sam, on their own mic" }));
  await waitFor(() => expect(calls.some((call) => call.cmd === "aaf_set_cue_ownership")).toBe(true));
  expect(calls.find((call) => call.cmd === "aaf_set_cue_ownership")?.args).toMatchObject({ trackId: "track-2", cueId: "sam-1", label: "owner", heardOn: null });
});

it("offers to measure the mics when too few have a level to compare", async () => {
  answer = { ...answer, measured: [], missing: ["track-1", "track-2"], words: [] };
  render(<MultitrackTranscript document={fixture()} frame={0} solo={new Set()} onSeek={vi.fn()} initialAll />);
  fireEvent.click(await screen.findByRole("button", { name: "Measure mics" }));
  await waitFor(() => expect(calls.some((call) => call.cmd === "aaf_ownership" && call.args.build === true)).toBe(true));
  expect((screen.getByLabelText("Show bleed") as HTMLInputElement).disabled).toBe(true);
});

it("checks voices when the levels left words unsure, and reports what it found", async () => {
  answer = { ...answer, counts: { ...answer.counts, unsure: 3 } };
  render(<MultitrackTranscript document={fixture()} frame={0} solo={new Set()} onSeek={vi.fn()} initialAll />);
  fireEvent.click(await screen.findByRole("button", { name: "Check voices" }));
  await screen.findByText("Alex's mic may have changed hands: later in the day it sounds like Sam.");
  expect(screen.getByText(/Voices checked for 2 people/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Check voices" })).toBeNull();
});
