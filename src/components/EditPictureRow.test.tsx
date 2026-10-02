// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AafPictureClip } from "../bindings/AafPictureClip";
import { EditPictureRow } from "./EditPictureRow";

afterEach(cleanup);

const clip = (name: string): AafPictureClip => ({ start_frame: 0, duration_frames: 1, kind: "clip", name, master_mob_id: null, file_mob_id: null, tape_name: null,
  source_start_frame: null, source_timecode_fps: null, source_drop_frame: null, group: false, effect: null, descriptor: null });
const pct = (t: number) => `${t * 10}%`;

it("places each picture cut where its segment now plays, trimmed to the segment", () => {
  // Source picture: A 0-4 s, B 4-10 s. The edit plays source 3-6 s, then a 1 s gap, then 8-9 s.
  const edit = { segments: [{ id: "a", source: "s1", srcIn: 3, srcOut: 6 }, { id: "g", source: "gap", srcIn: 0, srcOut: 1 }, { id: "b", source: "s1", srcIn: 8, srcOut: 9 }], mutes: [] };
  render(<EditPictureRow edit={edit} starts={[0, 3, 4]} start={0} span={10} x={pct} w={pct}
    pictureOf={() => [{ from: 0, to: 4, clip: clip("A") }, { from: 4, to: 10, clip: clip("B") }]} />);
  const blocks = screen.getAllByRole("listitem");
  expect(blocks.map((block) => [block.textContent, block.style.left, block.style.width])).toEqual([
    ["A", "0%", "10%"], ["B", "10%", "20%"], ["B", "40%", "10%"],
  ]);
  expect(document.querySelector("video, canvas, img")).toBeNull();
});

it("draws nothing when no source carries picture", () => {
  const view = render(<EditPictureRow edit={{ segments: [{ id: "a", source: "s1", srcIn: 0, srcOut: 1 }], mutes: [] }} starts={[0]} start={0} span={1} x={pct} w={pct} pictureOf={() => []} />);
  expect(view.container.innerHTML).toBe("");
});
