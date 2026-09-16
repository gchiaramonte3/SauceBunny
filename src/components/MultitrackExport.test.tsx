// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MultitrackExport } from "./MultitrackExport";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
const download = vi.hoisted(() => vi.fn());
vi.mock("../hooks/use-multitrack-export", () => ({ useMultitrackExport: () => ({ phase: "idle", status: "", error: null, download, downloadPeople: vi.fn(), clearResolution: vi.fn() }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it.each(["txt", "csv", "avid", "srt", "pdf"])("Entire transcript honors %s even when viewing one person", (format) => {
  const document = multitrackFixture(); document.transcripts = [multitrackTranscript(), multitrackTranscript("track-2")];
  render(<MultitrackExport document={document} person={{ id: "sam", name: "Sam", trackIds: ["track-2"], color: null }} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Transcript export format" }), { target: { value: format } });
  fireEvent.click(screen.getByRole("button", { name: "Entire transcript" }));
  expect(download).toHaveBeenLastCalledWith(format);
  fireEvent.click(screen.getByRole("button", { name: "Export Sam" }));
  expect(download).toHaveBeenLastCalledWith(format, ["track-2"], "Sam");
});
