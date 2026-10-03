// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import { useEditSourceSide, type EditSourceTake } from "../hooks/use-edit-source-side";
import type { TimelineWord } from "../lib/edit-model";
import { EditSourceHost } from "./EditSourceHost";

vi.mock("../hooks/use-edit-playback", () => ({
  useEditPlayback: () => ({ frame: 0, playing: false, busy: false, toggle: vi.fn(), pause: vi.fn(), seek: vi.fn(async () => undefined) }),
}));
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

function Host({ list = words, reading = null, onTake = vi.fn() }: { list?: TimelineWord[]; reading?: { done: number; total: number } | null; onTake?: (take: EditSourceTake | null, atEnd: boolean) => void }) {
  const side = useEditSourceSide({ document: edit, sources: [{ id: "s1", short: "Kitchen", duration: 10, startFrames: 86400 }], documents: new Map(),
    words: list, colors: { rosa: "#f00", dev: "#0f0" }, fps: 24, active: true });
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
  expect([take.from, take.to]).toEqual([1, 2.1]);
  // Every mic is on by default, so the clip brings both people, in track order.
  expect(take.lanes).toEqual(["rosa", "dev"]);
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
