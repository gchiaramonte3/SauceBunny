// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoIntelligenceSettings } from "./VideoIntelligenceSettings";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emit: vi.fn(async () => {}) }));
const model = { id: "qwen3-vl-embedding-2b", name: "Qwen3-VL Embedding 2B", role: "embedding", bytes: 1800000000, ready: false };
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks(); mocks.listen.mockResolvedValue(() => {});
  mocks.invoke.mockResolvedValue({ models: [model], sources: [], hits: [], answers: [] });
});
afterEach(cleanup);
it("groups models by role and only offers compatible installed picture models as defaults", async () => {
  const all = [
    { ...model, id: "qwen3.5-9b-video", name: "Qwen3.5 9B", role: "reasoning", ready: true },
    { ...model, id: "qwen3.5-4b-video", name: "Qwen3.5 4B", role: "reasoning", ready: true },
    { ...model, ready: true },
    { ...model, id: "ast-audioset", name: "AudioSet AST", role: "audio", ready: true },
    { ...model, id: "reranker", name: "Reranker", role: "reranker", ready: true },
  ];
  mocks.invoke.mockResolvedValue({ models: all, sources: [], hits: [], answers: [] });
  const { unmount } = render(<VideoIntelligenceSettings />);
  const picture = await screen.findByRole("region", { name: "Picture analysis" });
  const defaultButton = within(picture).getByRole("button", { name: "Use as default" });
  expect(defaultButton.closest(".cp-model-row")?.textContent).toContain("Qwen3.5 4B");
  expect(within(screen.getByRole("region", { name: "Audio analysis" })).queryByRole("button", { name: "Use as default" })).toBeNull();
  expect(within(screen.getByRole("region", { name: "Video search" })).queryByRole("button", { name: "Use as default" })).toBeNull();
  fireEvent.click(defaultButton);
  expect(screen.getByText("Default").closest(".cp-model-row")?.textContent).toContain("Qwen3.5 4B");
  expect(localStorage.getItem("saucebunny.pictureModel")).toBe("qwen3.5-4b-video");
  expect(mocks.invoke.mock.calls.every(call => call[1]?.request?.operation === "models")).toBe(true);
  unmount();
  // Deleting its installation never silently chooses a different default.
  mocks.invoke.mockResolvedValue({ models: all.map(item => item.id === "qwen3.5-4b-video" ? { ...item, ready: false } : item) });
  render(<VideoIntelligenceSettings />);
  await screen.findByText("Qwen3.5 4B");
  expect(screen.getByText("Default").closest(".cp-model-row")?.textContent).toContain("Qwen3.5 4B");
  expect(within(screen.getByText("Qwen3.5 4B").closest(".cp-model-row") as HTMLElement).queryByRole("button", { name: "Use as default" })).toBeNull();
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
});
it("offers the optional audio model through the same explicit download control", async () => {
  mocks.invoke.mockResolvedValue({ models: [{ ...model, id: "ast-audioset", role: "audio", name: "AudioSet AST", bytes: 346433173 }], sources: [], hits: [], answers: [] });
  render(<VideoIntelligenceSettings />);
  await screen.findByText("AudioSet AST");
  expect(screen.getByText(/Analyze music and sound/)).toBeTruthy();
  expect(mocks.invoke.mock.calls.every(call => call[1]?.request?.operation === "models")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("video_intelligence_run", expect.objectContaining({ request: { operation: "download", model_id: "ast-audioset" } })));
});
it("shows models in StrictMode without starting a download", async () => {
  render(<StrictMode><VideoIntelligenceSettings /></StrictMode>);
  await screen.findByText(model.name);
  expect(mocks.invoke.mock.calls.filter((call) => call[1]?.request?.operation === "models")).toHaveLength(1);
  expect(mocks.invoke.mock.calls.some((call) => call[1]?.request?.operation === "download")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("video_intelligence_run", expect.objectContaining({ request: { operation: "download", model_id: model.id } })));
});
it("requires a second named click to delete model files", async () => {
  mocks.invoke.mockResolvedValue({ models: [{ ...model, ready: true }], sources: [], hits: [], answers: [] });
  render(<VideoIntelligenceSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  expect(mocks.invoke.mock.calls.some((call) => call[1]?.request?.operation === "delete-model")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete 1.8 GB?" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("video_intelligence_run", expect.objectContaining({ request: { operation: "delete-model", model_id: model.id } })));
});
it("does not label model removal as a download", async () => {
  mocks.invoke.mockImplementation((_command, args) => args?.request?.operation === "delete-model"
    ? new Promise(() => {}) : Promise.resolve({ models: [{ ...model, ready: true }], sources: [], hits: [], answers: [] }));
  render(<VideoIntelligenceSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete 1.8 GB?" }));
  await screen.findByText("Removing…");
  expect(screen.queryByRole("progressbar")).toBeNull();
});
