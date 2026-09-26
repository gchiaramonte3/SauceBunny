// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { MultitrackTrackActions } from "./MultitrackTrackActions";
import { MultitrackRegenerate } from "./MultitrackRegenerate";
vi.mock("../hooks/use-multitrack-export", () => ({ useMultitrackExport: () => ({ phase: "idle" }) }));
afterEach(cleanup);
it.each([false, true])("uses committed result existence, including no speech: %s", generated => {
  const document = multitrackFixture();
  if (generated) document.transcripts = [{ ...multitrackTranscript(), status: "empty", cues: [] }];
  render(<MultitrackTrackActions document={document} target={{ id: "track-1", x: 10, y: 10 }} disabled={false} onClose={vi.fn()} onRegenerate={vi.fn()} />);
  const action = generated ? "Regenerate" : "Generate";
  expect(screen.getByRole("menuitem", { name: `${action}…` })).toBeDefined();
  render(<MultitrackRegenerate owner="Alex" generated={generated} initial={{ engine: "parakeet", modelId: "parakeet-tdt-0.6b-v3" }} models={[]} parakeetReady onClose={vi.fn()} onStart={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: `${action} Alex` })).toBeDefined();
  expect(screen.getByRole("button", { name: `${action} track` })).toBeDefined();
});
it("keeps placeholder-only committed tracks generated while disabling empty exports", () => {
  const document = multitrackFixture(), track = multitrackTranscript();
  track.cues[0].text = "[BLANK_AUDIO]";
  document.transcripts = [track];
  render(<MultitrackTrackActions document={document} target={{ id: "track-1", x: 10, y: 10 }} disabled={false} onClose={vi.fn()} onRegenerate={vi.fn()} />);
  expect((screen.getByRole("menuitem", { name: "Regenerate…" }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole("menuitem", { name: "Download text file…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("menuitem", { name: "Export Avid markers…" }) as HTMLButtonElement).disabled).toBe(true);
});
