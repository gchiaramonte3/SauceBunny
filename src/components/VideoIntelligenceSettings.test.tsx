// @vitest-environment jsdom
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoIntelligenceSettings } from "./VideoIntelligenceSettings";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen, emit: vi.fn(async () => {}) }));
const model = { id: "qwen3-vl-embedding-2b", name: "Qwen3-VL Embedding 2B", role: "embedding", bytes: 1800000000, ready: false };
beforeEach(() => {
  vi.resetAllMocks(); mocks.listen.mockResolvedValue(() => {});
  mocks.invoke.mockResolvedValue({ models: [model], sources: [], hits: [], answers: [] });
});
afterEach(cleanup);
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
