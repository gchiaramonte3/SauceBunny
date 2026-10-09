// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clipPieces, layerClips, type Layering, type Timeline } from "../lib/edit-model";
import { EditTimelineRow } from "./EditTimelineRow";

afterEach(cleanup);
const pct = (t: number) => `${t * 10}%`;
// Rosa on A1 and Dev on A2 wherever a clip does not say.
const layering: Layering = { carries: () => ["rosa", "dev"], home: (lane) => ({ rosa: 1, dev: 2 } as Record<string, number>)[lane] };
const colors: Record<string, string> = { rosa: "rgb(1, 2, 3)", dev: "rgb(4, 5, 6)", kara: "rgb(7, 8, 9)" };
const draw = (edit: Timeline, layer: number, extra: Partial<React.ComponentProps<typeof EditTimelineRow>> = {}) => render(<EditTimelineRow layer={layer} clips={layerClips(edit, layer, layering)}
  soloed={false} quiet={false} muted={false} shown={false} cues={[]} selected onTrack={() => undefined} onSolo={() => undefined} onMute={() => undefined} onText={() => undefined}
  start={0} span={10} x={pct} w={pct} nameOf={(lane) => lane[0].toUpperCase() + lane.slice(1)} colorOf={(lane) => colors[lane]} sourceName={() => "Kitchen"} waveforms={false}
  peaksOf={() => undefined} durationOf={() => 30} mutes={{}} marked={null} pointer={{}} {...extra} />);
const geometry = (view: ReturnType<typeof draw>) => [...view.container.querySelectorAll<HTMLElement>(".cp-te-tl-clip")].map((clip) => [clip.style.left, clip.style.width]);


it("splits a segment around a track's silenced ranges", () => {
  expect(clipPieces({ srcIn: 2, srcOut: 8 }, [[3, 4], [7.5, 9], [0, 1]])).toEqual([
    { srcIn: 2, srcOut: 3 }, { srcIn: 4, srcOut: 7.5 },
  ]);
  expect(clipPieces({ srcIn: 2, srcOut: 8 }, [[1, 9]])).toEqual([]);
});

it("draws a silenced range as a hole in that track's clip, and nothing else changes", () => {
  const edit: Timeline = { segments: [{ id: "a", source: "s1", srcIn: 2, srcOut: 8 }], mutes: [] };
  const whole = draw(edit, 1);
  expect(geometry(whole)).toEqual([["0%", "60%"]]);
  whole.unmount();
  // Program 0 to 2 s plays source 2 to 4; 2 to 3 s is the hole; 3 to 6 s plays source 5 to 8.
  expect(geometry(draw(edit, 1, { mutes: { "s1:rosa": [[4, 5]] } }))).toEqual([["0%", "20%"], ["30%", "30%"]]);
});

it("is a record track as Avid has one: the track and S, M, T and W, and no person in its header", () => {
  const onTrack = vi.fn(), onSolo = vi.fn();
  draw({ segments: [], mutes: [] }, 2, { onTrack, onSolo, onWave: () => undefined });
  fireEvent.click(screen.getByRole("button", { name: "Track A2" }), { altKey: true });
  expect(onTrack).toHaveBeenCalledWith(2, true);
  fireEvent.click(screen.getByRole("button", { name: "Solo A2" }));
  expect(onSolo).toHaveBeenCalledWith(2);
  expect(["Mute A2", "Text on A2", "Waveform on A2"].every((name) => screen.queryByRole("button", { name }))).toBe(true);
  // An empty track is filler, and nobody is chosen in its header.
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(document.querySelectorAll(".cp-te-tl-clip")).toHaveLength(0);
});

it("one track holds several people's clips, each in its own colour and with its own name", () => {
  // Rosa from source 0 s for 2 s on A1, then Kara's lav from 20 s for 2 s on the same A1.
  const edit: Timeline = { segments: [{ id: "a", source: "s1", srcIn: 0, srcOut: 2, tracks: ["rosa"], layers: { rosa: 1 } },
    { id: "b", source: "s1", srcIn: 20, srcOut: 22, tracks: ["kara"], layers: { kara: 1 } }], mutes: [] };
  const local: Layering = { ...layering, carries: () => ["rosa", "dev", "kara"] };
  const view = render(<EditTimelineRow layer={1} clips={layerClips(edit, 1, local)} soloed={false} quiet={false} muted={false} shown={false} cues={[]} selected
    onTrack={() => undefined} onSolo={() => undefined} onMute={() => undefined} onText={() => undefined} start={0} span={10} x={pct} w={pct}
    nameOf={(lane) => lane} colorOf={(lane) => colors[lane]} sourceName={() => "Kitchen"} waveforms={false} peaksOf={() => undefined} durationOf={() => 30}
    mutes={{}} marked={null} pointer={{}} />);
  const clips = [...view.container.querySelectorAll<HTMLElement>(".cp-te-tl-clip")];
  expect(clips.map((clip) => [clip.textContent, clip.style.left, clip.style.width, clip.style.getPropertyValue("--te-speaker")]))
    .toEqual([["rosa", "0%", "20%", colors.rosa], ["kara", "20%", "20%", colors.kara]]);
});

it("an edit on another track alone does not cut this one: each track draws its own clips", () => {
  // Rosa overwritten from 20 s for 2 to 4 s on A1; Dev, on A2, keeps playing the clip.
  const edit: Timeline = { segments: [{ id: "a", source: "s1", srcIn: 0, srcOut: 2 }, { id: "b", source: "s1", srcIn: 2, srcOut: 4, overrides: { rosa: { source: "s1", srcIn: 20 } } },
    { id: "c", source: "s1", srcIn: 4, srcOut: 8 }], mutes: [] };
  const rosa = draw(edit, 1);
  expect(geometry(rosa)).toEqual([["0%", "20%"], ["20%", "20%"], ["40%", "40%"]]);
  rosa.unmount();
  expect(geometry(draw(edit, 2))).toEqual([["0%", "80%"]]);
});
