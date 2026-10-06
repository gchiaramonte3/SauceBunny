// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let finish: () => void = () => {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd === "parakeet_model_downloaded") return args.model === "parakeet-tdt-0.6b-v3";
    if (cmd === "download_parakeet_model") return new Promise<void>((resolve) => { finish = resolve; });
    return null;
  }),
}));

import { useParakeetModels } from "./use-parakeet-models";

beforeEach(() => { calls.length = 0; });

it("reads each model's readiness by id", async () => {
  const { result } = renderHook(() => useParakeetModels());
  await act(async () => { await result.current.check(); });
  expect(result.current.ready).toEqual({ "parakeet-ultra": false, "parakeet-tdt-0.6b-v3": true });
  expect(calls.filter((call) => call.cmd === "parakeet_model_downloaded").map((call) => call.args.model)).toEqual(["parakeet-ultra", "parakeet-tdt-0.6b-v3"]);
});

it("holds the download's job id so Cancel reaches the same job, and checks again when it ends", async () => {
  const { result } = renderHook(() => useParakeetModels());
  let done!: Promise<void>;
  act(() => { done = result.current.download("parakeet-ultra"); });
  expect(result.current.downloading).toBe("parakeet-ultra");
  const started = calls.find((call) => call.cmd === "download_parakeet_model")!;
  expect(started.args.model).toBe("parakeet-ultra");
  act(() => result.current.cancel());
  expect(calls.find((call) => call.cmd === "cancel_job")?.args.jobId).toBe(started.args.jobId);
  // A second download while one runs is not started.
  act(() => { void result.current.download("parakeet-tdt-0.6b-v3"); });
  expect(calls.filter((call) => call.cmd === "download_parakeet_model")).toHaveLength(1);
  await act(async () => { finish(); await done; });
  await waitFor(() => expect(result.current.downloading).toBeNull());
  expect(calls.filter((call) => call.cmd === "parakeet_model_downloaded").length).toBeGreaterThan(0);
});
