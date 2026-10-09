// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import { useEditSourceSide, type EditSourceMarks, type EditSourceTake } from "../hooks/use-edit-source-side";
import type { TimelineWord } from "../lib/edit-model";
import { EditSourceHost } from "./EditSourceHost";

vi.mock("../hooks/use-edit-playback", async () => {
  const { createFrameStore } = await import("../lib/frame-store");
  const frames = createFrameStore(0);
  return { useEditPlayback: () => ({ frames, playing: false, busy: false, toggle: vi.fn(), pause: vi.fn(), seek: vi.fn(async () => undefined) }) };
});
afterEach(cleanup);

const edit: EditDocument = {
  schema_version: 1, title: "Scene", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86400,
  sources: [{ id: "s1", name: "Kitchen", document_id: "d1" }], segments: [], mutes: [], markers: [],
  tracks: [
    { id: "rosa", name: "ROSA", kind: "sound", source_tracks: { s1: "t1" } },
    { id: "dev", name: "DEV", kind: "sound", source_tracks: { s1: "t2" } },
  ],
};
const lanes = [{ id: "rosa", name: "ROSA", track: 1 }, { id: "dev", name: "DEV", track: 2 }];
const word = (track: string, cue: string, start: number, text: string): TimelineWord =>
  ({ id: `s1:${track}:${cue}:${start}`, source: "s1", track, cue, text, start, end: start + 0.3 });
const words = [word("rosa", "r1", 1, "I"), word("dev", "d1", 1.2, "Yeah"), word("rosa", "r1", 1.4, "was"), word("rosa", "r1", 1.8, "tired")];

function Host({ list = words, reading = null, onTake = vi.fn(), request = null }: { list?: TimelineWord[]; reading?: { done: number; total: number } | null; onTake?: (take: EditSourceTake | null, atEnd: boolean) => void; request?: EditSourceMarks | null }) {
  const side = useEditSourceSide({ document: edit, sources: [{ id: "s1", short: "Kitchen", duration: 10, startFrames: 86400 }], documents: new Map(),
    words: list, colors: { rosa: "#f00", dev: "#0f0" }, fps: 24, active: true, request });
  return <EditSourceHost side={side} lanes={lanes} colors={{ rosa: "#f00", dev: "#0f0" }} fps={24} used={new Set()} reading={reading}
    text={{ family: "sans", size: 13, leading: "normal" }} onText={() => undefined} onPlace={(how) => onTake(side.take(), how === "append")} />;
}
const shownWords = () => [...document.querySelectorAll(".cp-te-src-word")].map((element) => element.textContent);

it("reads a person at a time through AAF Audio's tabs, opening on the first person who speaks", () => {
  render(<Host />);
  const tabs = screen.getByRole("tablist", { name: "Transcripts by person" });
  expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["All voices", "ROSA", "DEV"]);
  expect(within(tabs).getByRole("tab", { name: "ROSA" }).getAttribute("aria-selected")).toBe("true");
  expect(shownWords()).toEqual(["I", "was", "tired"]);
  expect(screen.getByText("0/3 of ROSA's words used")).toBeTruthy();
  fireEvent.click(within(tabs).getByRole("tab", { name: "DEV" }));
  expect(shownWords()).toEqual(["Yeah"]);
  fireEvent.click(within(tabs).getByRole("tab", { name: "All voices" }));
  // Rosa's cue stays whole even though Dev's word falls inside it.
  expect(shownWords()).toEqual(["I", "was", "tired", "Yeah"]);
  expect(screen.getByText("0/4 used")).toBeTruthy();
});

it("Insert takes exactly the words selected in the tab being read, and their span as In to Out", () => {
  const onTake = vi.fn();
  render(<Host onTake={onTake} />);
  expect((screen.getByRole("button", { name: /^Insert/ }) as HTMLButtonElement).disabled).toBe(true);
  const [first, , last] = [...document.querySelectorAll<HTMLElement>("[data-src-index]")];
  fireEvent.pointerDown(first, { button: 0 });
  fireEvent.pointerDown(last, { button: 0, shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: /^Insert/ }));
  const [take, atEnd] = onTake.mock.calls[0];
  expect(atEnd).toBe(false);
  expect(take.words).toEqual([words[0], words[2], words[3]]);
  expect([take.in, take.out]).toEqual([1, 2.1]);
  // Source tracks follow the text: Rosa's words bring Rosa's mic, not every mic in the room.
  expect(take.lanes).toEqual(["rosa"]);
});

it("a selection in All voices brings whoever said its words, in track order", () => {
  const onTake = vi.fn();
  render(<Host onTake={onTake} />);
  fireEvent.click(within(screen.getByRole("tablist", { name: "Transcripts by person" })).getByRole("tab", { name: "All voices" }));
  const shown = [...document.querySelectorAll<HTMLElement>("[data-src-index]")];
  // All voices reads I, was, tired (Rosa's cue), then Yeah (Dev's).
  fireEvent.pointerDown(shown[2], { button: 0 });
  fireEvent.pointerDown(shown[3], { button: 0, shiftKey: true });
  fireEvent.click(screen.getByRole("button", { name: /^Insert/ }));
  expect(onTake.mock.calls[0][0].lanes).toEqual(["rosa", "dev"]);
});

it("source track selectors, once used, make an edit bring exactly those tracks, until it follows the text again", () => {
  const { result } = renderHook(() => useEditSourceSide({ document: edit, sources: [{ id: "s1", short: "Kitchen", duration: 10, startFrames: 86400 }], documents: new Map(),
    words, colors: { rosa: "#f00", dev: "#0f0" }, fps: 24, active: true, request: null }));
  // Rosa's tab, her three words selected.
  act(() => result.current.setRange([0, 2]));
  expect(result.current.following).toBe(true);
  expect(result.current.take()?.lanes).toEqual(["rosa"]);
  // Only Dev's mic on, as with Avid's track selectors: Rosa's words, Dev's track.
  act(() => result.current.toggleSelector("t2", true));
  expect(result.current.following).toBe(false);
  expect(result.current.take()?.lanes).toEqual(["dev"]);
  // Both on.
  act(() => result.current.toggleSelector("t1", false));
  expect(result.current.take()?.lanes).toEqual(["rosa", "dev"]);
  act(() => result.current.followText());
  expect(result.current.take()?.lanes).toEqual(["rosa"]);
});

it("Shift-click extends the selection this tab kept, never from a click made in another tab", () => {
  render(<Host />);
  const tabs = screen.getByRole("tablist", { name: "Transcripts by person" });
  const shown = () => [...document.querySelectorAll<HTMLElement>("[data-src-index]")];
  const selected = () => [...document.querySelectorAll(".cp-te-src-word.is-selected")].map((element) => element.textContent);
  // Rosa's last word, then a click in Dev's tab (index 0 there).
  fireEvent.pointerDown(shown()[2], { button: 0 });
  expect(selected()).toEqual(["tired"]);
  fireEvent.click(within(tabs).getByRole("tab", { name: "DEV" }));
  fireEvent.pointerDown(shown()[0], { button: 0 });
  // Back to Rosa: her selection was kept. Shift-click "was" extends THAT
  // selection to [was, tired]; extending from Dev's index 0 would select [I, was].
  fireEvent.click(within(tabs).getByRole("tab", { name: "ROSA" }));
  expect(selected()).toEqual(["tired"]);
  fireEvent.pointerDown(shown()[1], { button: 0, shiftKey: true });
  expect(selected()).toEqual(["was", "tired"]);
});

it("says the words are still being read instead of claiming there are none", () => {
  const view = render(<Host list={[]} reading={{ done: 4, total: 20 }} />);
  expect(screen.getByRole("status").textContent).toBe("Reading each microphone's words… 4 of 20");
  expect(screen.queryByText(/No transcripts/)).toBeNull();
  view.unmount();
  // Before any mic is counted the sequence itself is still opening.
  const opening = render(<Host list={[]} reading={{ done: 0, total: 0 }} />);
  expect(screen.getByRole("status").textContent).toBe("Opening Kitchen…");
  opening.unmount();
  render(<Host list={[]} />);
  expect(screen.getByText(/No transcripts in Kitchen yet/)).toBeTruthy();
});

it("AAF Audio's In and Out arrive marked: on the source's rail, and on the words between them", () => {
  render(<Host request={{ documentId: "d1", in: 1, out: 2, tick: 1 }} />);
  expect(document.querySelectorAll(".cp-te-source-host .cp-te-scrub .cp-mark-range")).toHaveLength(1);
  const marked = [...document.querySelectorAll(".cp-te-src-word.is-marked")].map((element) => element.textContent);
  // "tired" runs past Out (1.8 to 2.1 s), so it is not inside the marks.
  expect(marked).toEqual(["I", "was"]);
  // Marks set by I and O make the source ready to cut in.
  expect((screen.getByRole("button", { name: /^Insert/ }) as HTMLButtonElement).disabled).toBe(false);
});

it("says whose tracks an edit brings, and that it follows the text", () => {
  render(<Host />);
  // Rosa's tab with nothing selected: her mic.
  expect(screen.getByText("Brings ROSA, following the text")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("tablist", { name: "Transcripts by person" })).getByRole("tab", { name: "All voices" }));
  expect(screen.getByText("Brings ROSA and DEV, following the text")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Choose tracks" })).toBeTruthy();
});
