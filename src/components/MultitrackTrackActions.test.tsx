// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MultitrackTrackActions } from "./MultitrackTrackActions";
import { multitrackGroupFixture, multitrackTranscript } from "../test/multitrack-fixture";

const download = vi.hoisted(() => vi.fn());
vi.mock("../hooks/use-multitrack-export", () => ({ useMultitrackExport: () => ({ phase: "idle", status: "", error: null, download }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("offers marker export for a saved offline alternative but not an empty microphone", () => {
  const doc = multitrackGroupFixture(); doc.transcripts = [multitrackTranscript("track-2")]; doc.manifest.graph!.lanes[1].availability = "offline";
  const props = { document: doc, disabled: false, onClose: vi.fn(), onRegenerate: vi.fn(), target: { id: "track-2", x: 20, y: 20 } };
  const view = render(<MultitrackTrackActions {...props} />);
  const button = screen.getByRole("menuitem", { name: "Export Avid markers…" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false); expect(button.title).toContain("parent sequence track");
  fireEvent.click(button); expect(download).toHaveBeenCalledWith("avid", ["track-2"], "Sam mic");
  expect((screen.getByRole("menuitem", { name: "Regenerate…" }) as HTMLButtonElement).disabled).toBe(true);
  view.rerender(<MultitrackTrackActions {...props} target={{ ...props.target, id: "track-3" }} />);
  expect((screen.getByRole("menuitem", { name: "Export Avid markers…" }) as HTMLButtonElement).disabled).toBe(true);
});
