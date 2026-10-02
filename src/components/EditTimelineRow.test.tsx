// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clipPieces } from "../lib/edit-model";
import { EditTimelineRow } from "./EditTimelineRow";

afterEach(cleanup);
const pct = (t: number) => `${t * 10}%`;

it("splits a segment around a track's silenced ranges", () => {
  expect(clipPieces({ id: "a", source: "s1", srcIn: 2, srcOut: 8 }, [[3, 4], [7.5, 9], [0, 1]])).toEqual([
    { srcIn: 2, srcOut: 3 }, { srcIn: 4, srcOut: 7.5 },
  ]);
  expect(clipPieces({ id: "a", source: "s1", srcIn: 2, srcOut: 8 }, [[1, 9]])).toEqual([]);
});

it("draws a lifted range as a hole in that track's clip, and nothing else changes", () => {
  const edit = { segments: [{ id: "a", source: "s1", srcIn: 2, srcOut: 8 }], mutes: [] };
  const row = (mutes: Record<string, [number, number][]>) => render(<EditTimelineRow speaker={{ id: "rosa", name: "Rosa", track: 1 }} color="#fff"
    soloed={false} quiet={false} muted={false} shown={false} cues={[]} selected onTrack={() => undefined} onSolo={() => undefined} onMute={() => undefined} onText={() => undefined}
    edit={edit} starts={[0]} start={0} span={10} x={pct} w={pct} sourceSpeakers={{ s1: ["rosa"] }} sourceName={() => "Kitchen"} waveforms={false}
    peaksOf={() => undefined} durationOf={() => 10} mutes={mutes} marked={null} seams={[]} scrub={{}} />);
  const whole = row({});
  expect([...whole.container.querySelectorAll<HTMLElement>(".cp-te-tl-clip")].map((clip) => [clip.style.left, clip.style.width])).toEqual([["0%", "60%"]]);
  whole.unmount();
  const lifted = row({ "s1:rosa": [[4, 5]] });
  // Program 0 to 2 s plays source 2 to 4; 2 to 3 s is the hole; 3 to 6 s plays source 5 to 8.
  expect([...lifted.container.querySelectorAll<HTMLElement>(".cp-te-tl-clip")].map((clip) => [clip.style.left, clip.style.width])).toEqual([["0%", "20%"], ["30%", "30%"]]);
});

it("is a record track with a patch panel: who plays on it, and taking them off", () => {
  const onUntrack = vi.fn(), onPatch = vi.fn();
  const people = [{ id: "ana", name: "Ana", track: 2 }, { id: "rosa", name: "Rosa", track: 1 }, { id: "kai", name: "Kai", track: 0 }];
  render(<EditTimelineRow speaker={people[0]} color="#fff" patch={{ people, onPatch }}
    soloed={false} quiet={false} muted={false} shown={false} cues={[]} selected onTrack={() => undefined} onSolo={() => undefined} onMute={() => undefined} onText={() => undefined}
    onUntrack={onUntrack} edit={{ segments: [], mutes: [] }} starts={[]} start={0} span={10} x={pct} w={pct} sourceSpeakers={{}} sourceName={() => "Kitchen"} waveforms={false}
    peaksOf={() => undefined} durationOf={() => 10} mutes={{}} marked={null} seams={[]} scrub={{}} />);
  expect(screen.getByRole("button", { name: "Track A2" })).toBeTruthy();
  const panel = screen.getByRole("combobox", { name: "Who plays on A2" }) as HTMLSelectElement;
  expect(panel.value).toBe("ana");
  expect([...panel.options].map((option) => option.text)).toEqual(["Ana", "Rosa", "Kai"]);
  fireEvent.change(panel, { target: { value: "kai" } });
  expect(onPatch).toHaveBeenCalledWith("kai", 1);
  // Anyone patched can be taken off, not only a group angle.
  fireEvent.click(screen.getByRole("button", { name: "Take Ana off a track" }));
  expect(onUntrack).toHaveBeenCalledWith("ana");
});

it("draws a clip only on the tracks it plays: a bite of one person is filler on the others", () => {
  const edit = { segments: [{ id: "a", source: "s1", srcIn: 0, srcOut: 4, tracks: ["rosa"] }, { id: "b", source: "s1", srcIn: 4, srcOut: 8 }], mutes: [] };
  const lane = (id: string) => render(<EditTimelineRow speaker={{ id, name: id, track: 1 }} color="#fff"
    soloed={false} quiet={false} muted={false} shown={false} cues={[]} selected onTrack={() => undefined} onSolo={() => undefined} onMute={() => undefined} onText={() => undefined}
    edit={edit} starts={[0, 4]} start={0} span={10} x={pct} w={pct} sourceSpeakers={{ s1: ["rosa", "dev"] }} sourceName={() => "Kitchen"} waveforms={false}
    peaksOf={() => undefined} durationOf={() => 10} mutes={{}} marked={null} seams={[]} scrub={{}} />);
  const rosa = lane("rosa");
  expect(rosa.container.querySelectorAll(".cp-te-tl-clip")).toHaveLength(2);
  rosa.unmount();
  expect(lane("dev").container.querySelectorAll(".cp-te-tl-clip")).toHaveLength(1);
});
