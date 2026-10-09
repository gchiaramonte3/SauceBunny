// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AafPictureClip } from "../bindings/AafPictureClip";
import type { AafPictureTrack } from "../bindings/AafPictureTrack";
import { multitrackGroupFixture } from "../test/multitrack-fixture";
import { MultitrackPictureLane, pictureClipTitle, pictureSourceTimecode } from "./MultitrackPictureLane";
import { MultitrackTimeline } from "./MultitrackTimeline";
import { createFrameStore } from "../lib/frame-store";

afterEach(cleanup);

const clip = (start: number, duration: number, patch: Partial<AafPictureClip> = {}): AafPictureClip => ({
  start_frame: start, duration_frames: duration, kind: "clip", name: "Interview A", master_mob_id: "master-a", file_mob_id: "file-a",
  tape_name: "TAPE A", source_start_frame: 86400 + 510, source_timecode_fps: 24, source_drop_frame: false, group: false, effect: null,
  descriptor: { kind: "CDCIDescriptor", sample_rate: "24000/1001", stored_width: 1920, stored_height: 1080, frame_layout: "FullFrame", compression: null },
  ...patch,
});
const track = (clips: AafPictureClip[], number: number | null = 1): AafPictureTrack => ({ slot_id: 4, physical_track_number: number, name: "V1", component: "Sequence", clips });

it("draws named blocks at their record positions and nothing else", () => {
  const view = render(<MultitrackPictureLane tracks={[track([clip(0, 100), clip(100, 300, { name: null, tape_name: "TAPE B" }), clip(400, 100, { name: null, tape_name: null })])]} viewStart={0} viewEnd={1000} span={1000} frames={createFrameStore(50)} />);
  const lane = screen.getByRole("list", { name: "Picture cuts on V1" });
  const blocks = screen.getAllByRole("listitem");
  expect(blocks.map((block) => block.textContent)).toEqual(["Interview A", "TAPE B", "Clip"]);
  expect(blocks.map((block) => [block.style.left, block.style.width])).toEqual([["0%", "10%"], ["10%", "30%"], ["40%", "10%"]]);
  expect(lane.querySelector("video, canvas, img")).toBeNull();
  expect(view.container.querySelector(".cp-multitrack-playhead")).toBeTruthy();
});

it("clips blocks to the zoomed view and marks muted and group clips", () => {
  render(<MultitrackPictureLane tracks={[track([clip(0, 100), clip(100, 300, { kind: "muted" }), clip(400, 100, { group: true })])]} viewStart={150} viewEnd={450} span={300} frames={createFrameStore(0)} />);
  const blocks = screen.getAllByRole("listitem");
  expect(blocks).toHaveLength(2);
  expect([blocks[0].style.left, blocks[0].style.width]).toEqual(["0%", `${250 / 300 * 100}%`]);
  expect(blocks[0].classList.contains("is-muted")).toBe(true);
  expect(blocks[1].classList.contains("is-group")).toBe(true);
  expect(blocks[1].title).toBe("Interview A · Tape TAPE A · Source 01:00:21:06 · Group clip");
});

it("counts every angle of a big unnamed group and names it by the angle that plays", () => {
  // Avid's menu for a real group listed 75 cameras; the lane said 16 and "Clip".
  const angles = Array.from({ length: 75 }, (_, n) => `CAM ${n + 1}`);
  const group = clip(0, 100, { name: null, tape_name: null, group: true, angles, source_start_frame: null });
  render(<MultitrackPictureLane tracks={[track([group])]} viewStart={0} viewEnd={100} span={100} frames={createFrameStore(0)} />);
  const block = screen.getByRole("listitem");
  expect(block.querySelector(".cp-multitrack-picture-clip-name")?.textContent).toBe("CAM 1");
  expect(block.querySelector(".cp-multitrack-picture-angles")?.textContent).toBe("75");
  expect(block.title).toBe(`CAM 1 · Group clip, 75 angles: ${angles.slice(0, 12).join(", ")}, and 63 more`);
});

it("renders nothing when the AAF carried no picture clips", () => {
  const view = render(<MultitrackPictureLane tracks={[track([])]} viewStart={0} viewEnd={10} span={10} frames={createFrameStore(0)} />);
  expect(view.container.innerHTML).toBe("");
  render(<MultitrackPictureLane viewStart={0} viewEnd={10} span={10} frames={createFrameStore(0)} />);
  expect(screen.queryByRole("list")).toBeNull();
});

it("prefers V1 and formats drop-frame source timecode", () => {
  render(<MultitrackPictureLane tracks={[track([clip(0, 10, { name: "V2 clip" })], 2), track([clip(0, 10)], 1)]} viewStart={0} viewEnd={10} span={10} frames={createFrameStore(0)} />);
  expect(screen.getByRole("listitem").textContent).toBe("Interview A");
  expect(pictureSourceTimecode(clip(0, 1, { source_start_frame: 1800, source_timecode_fps: 30, source_drop_frame: true }))).toBe("00:01:00;02");
  expect(pictureSourceTimecode(clip(0, 1, { source_start_frame: null }))).toBeNull();
  expect(pictureClipTitle(clip(0, 1, { kind: "muted", effect: "Resize", tape_name: null, source_start_frame: null }))).toBe("Interview A · Muted in Avid · Effect Resize");
  // A group names its angles, the one that plays first, and the group when it has a name.
  expect(pictureClipTitle(clip(0, 1, { group: true, group_name: "MG 3", angles: ["CAM A", "CAM B"], tape_name: null, source_start_frame: null })))
    .toBe("Interview A · Group MG 3, 2 angles: CAM A, CAM B");
});

it("sits above the audio lanes in the AAF Audio timeline", () => {
  const document = multitrackGroupFixture();
  document.manifest.graph!.picture_tracks = [track([clip(0, 24000)])];
  const view = render(<MultitrackTimeline document={document} waveforms={{}} waveformErrors={{}} selected={new Set()} solo={new Set()} onSelect={vi.fn()} onRename={vi.fn()} onSeek={vi.fn()} frames={createFrameStore(0)} />);
  const lanes = [...view.container.querySelectorAll(".cp-multitrack-lanes > .cp-multitrack-lane")];
  expect(lanes[0].classList.contains("cp-multitrack-picture-lane")).toBe(true);
  expect(lanes.length).toBeGreaterThan(1);
  expect(view.container.querySelector(".cp-multitrack-timeline-tools")?.textContent).toContain("3 tracks");
});
