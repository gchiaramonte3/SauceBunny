// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { streamChat } from "../lib/ai-chat";
import { MultitrackTranscript } from "./MultitrackTranscript";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../lib/ai-chat", () => ({ streamChat: vi.fn() }));
const server = { base_url: "http://127.0.0.1:1234", api_key: "test", model_id: "chosen", ctx: 8192 };
beforeEach(() => {
  vi.mocked(streamChat).mockReset(); vi.mocked(streamChat).mockResolvedValue('{"matches":[0]}');
  vi.mocked(invoke).mockReset(); vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_llm_models") return [{ id: "recommended", downloaded: true, recommended: true }, { id: "chosen", downloaded: true }];
    if (command === "llm_server_status" || command === "start_llm_server") return server;
    return null;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup() {
  const document = multitrackFixture(), first = multitrackTranscript();
  first.cues[0].text = "We had to postpone the picnic because it was pouring.";
  first.cues.push({ ...first.cues[0], id: "cue-2", start_sample: 320000, end_sample: 360000, text: "The production budget is approved." });
  first.timing_issues = [{ id: "untimed", text: "The storm knocked out the power.", reported_timing: "invalid", reason: "Unknown timing", chunk_start_frame: 0 }];
  document.transcripts = [first, { ...multitrackTranscript("track-2"), cues: [{ ...first.cues[0], text: "Sam's unrelated words." }] }];
  const props = { document, frame: 0, solo: new Set<string>(), onSeek: vi.fn(), aiModelId: "chosen" };
  return { props, ...render(<MultitrackTranscript {...props} />) };
}
function submit(query = "bad weather") {
  fireEvent.click(screen.getByRole("checkbox", { name: "Search with AI" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
  fireEvent.submit(screen.getByRole("searchbox").closest("form")!);
}
it("leaves ordinary text search instant and does not start AI on mount, toggle or typing", () => {
  setup();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "budget" } });
  expect(screen.getByText("The production budget is approved.")).toBeTruthy();
  expect(screen.queryByText(/postpone the picnic/)).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Search with AI" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bad weather" } });
  expect(invoke).not.toHaveBeenCalled(); expect(streamChat).not.toHaveBeenCalled();
});
it("searches by meaning with the chosen model, preserves exact seek and leaves untimed results unclickable", async () => {
  const { props } = setup(); vi.mocked(streamChat).mockResolvedValue('{"matches":[0,2]}'); submit();
  await screen.findByText("2 matching passages · Local AI");
  expect(screen.queryByText("The production budget is approved.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /postpone the picnic/ }));
  expect(props.onSeek).toHaveBeenCalledWith(239, "track-1");
  expect(screen.getByText("The storm knocked out the power.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /storm knocked/ })).toBeNull();
  expect(vi.mocked(streamChat).mock.calls[0][0]).toEqual(server);
  expect(vi.mocked(streamChat).mock.calls[0][1][0].content).not.toContain("Sam's unrelated words");
  fireEvent.click(screen.getByRole("checkbox", { name: "Search with AI" }));
  expect(screen.getByText("No matching transcript text.")).toBeTruthy();
});
it("scopes All voices to all original passages and uses the existing cloud setting neither for upload nor inference", async () => {
  localStorage.setItem("saucebunny.ai.provider", "openai"); setup();
  fireEvent.click(screen.getByRole("tab", { name: "All voices" })); submit();
  await screen.findByText("1 matching passage · Local AI");
  expect(vi.mocked(streamChat).mock.calls[0][1][0].content).toContain("Sam's unrelated words");
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "cloud_chat")).toBe(false);
  localStorage.removeItem("saucebunny.ai.provider");
});
it.each(["edit", "toggle", "tab", "hide", "replace", "unmount", "stop"])("rejects a late AI response after %s", async (change) => {
  let finish!: (reply: string) => void;
  vi.mocked(streamChat).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  const view = setup(); submit(); await waitFor(() => expect(streamChat).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(streamChat).mock.calls[0][3];
  if (change === "edit") fireEvent.change(screen.getByRole("searchbox"), { target: { value: "budget" } });
  if (change === "toggle") fireEvent.click(screen.getByRole("checkbox", { name: "Search with AI" }));
  if (change === "tab") fireEvent.change(screen.getByRole("combobox", { name: "Choose transcript" }), { target: { value: "track:track-2" } });
  if (change === "hide") view.rerender(<MultitrackTranscript {...view.props} active={false} />);
  if (change === "replace") view.rerender(<MultitrackTranscript {...view.props} document={{ ...view.props.document, transcripts: [] }} />);
  if (change === "unmount") view.unmount();
  if (change === "stop") fireEvent.click(screen.getByRole("button", { name: "Stop search" }));
  expect(signal.aborted).toBe(true);
  await act(async () => finish('{"matches":[1]}'));
  expect(screen.queryByText("1 matching passage · Local AI")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "stop_llm_server")).toBe(false);
});
it("shows Stop before model discovery resolves and cannot start a model after Stop", async () => {
  let finish!: (models: unknown) => void;
  vi.mocked(invoke).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  setup(); submit(); fireEvent.click(screen.getByRole("button", { name: "Stop search" }));
  await act(async () => finish([{ id: "chosen", downloaded: true }]));
  expect(streamChat).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(1);
});
it("keeps failures actionable, never mistakes invalid output or absent models for an empty match set", async () => {
  setup(); vi.mocked(streamChat).mockResolvedValue("I think so."); submit();
  await screen.findByRole("alert"); expect(screen.getByRole("alert").textContent).toContain("unreadable search result");
  vi.mocked(invoke).mockResolvedValue([]);
  fireEvent.click(screen.getByRole("button", { name: /^Search$/ }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No local AI model is installed"));
  expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "download_llm_model")).toBe(false);
});
