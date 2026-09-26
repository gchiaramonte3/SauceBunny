// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { multitrackFixture } from "../test/multitrack-fixture";
import { MultitrackPage } from "./MultitrackPage";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../hooks/use-multitrack-document", () => ({ useMultitrackDocument: () => ({ document: multitrackFixture(), saved: [{ id: "sequence-test", name: "Interview" }], loading: false, error: null, labelStatus: "", waveforms: {}, waveformErrors: {}, load: mocks.load, rename: vi.fn(), acceptTranscript: vi.fn() }) }));
vi.mock("./MultitrackWorkspace", () => ({ MultitrackWorkspace: ({ onJobState }: { onJobState: (running: boolean) => void }) => <><button onClick={() => onJobState(true)}>Start test job</button><button onClick={() => onJobState(false)}>Stop test job</button></> }));
beforeEach(() => vi.clearAllMocks());

it("prevents replacing the source while transcription owns a job and unlocks after Stop", () => {
  render(<MultitrackPage active />);
  const imported = screen.getByRole("button", { name: "Import AAF…" }) as HTMLButtonElement;
  const saved = screen.getByRole("combobox", { name: "Open saved AAF" }) as HTMLSelectElement;
  fireEvent.click(screen.getByRole("button", { name: "Start test job" }));
  expect(imported.disabled).toBe(true); expect(saved.disabled).toBe(true);
  fireEvent.click(imported); expect(mocks.load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop test job" }));
  expect(imported.disabled).toBe(false); expect(saved.disabled).toBe(false);
  fireEvent.click(imported); expect(mocks.load).toHaveBeenCalledTimes(1);
});
