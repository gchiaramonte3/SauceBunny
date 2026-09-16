import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { LlmModel } from "../bindings/LlmModel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const info = { base_url: "http://127.0.0.1:1234", api_key: "test", model_id: "qwen", ctx: 8192 };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { vi.resetModules(); vi.mocked(invoke).mockReset(); });

it("uses the selected installed model, then recommended, then first; never downloads", async () => {
  const { selectLocalAiModel } = await import("./local-ai-server");
  const models = [{ id: "first", downloaded: true }, { id: "recommended", recommended: true, downloaded: true }, { id: "missing", downloaded: false }] as LlmModel[];
  expect(selectLocalAiModel(models, "first")?.id).toBe("first");
  expect(selectLocalAiModel(models, "missing")?.id).toBe("recommended");
  expect(selectLocalAiModel(models.slice(0, 1))?.id).toBe("first");
  expect(selectLocalAiModel([])).toBeUndefined();
});
it("reuses the actual resident server and does not stop it when a completed caller aborts", async () => {
  const { ensureLocalAiServer } = await import("./local-ai-server");
  vi.mocked(invoke).mockResolvedValue(info);
  const ctrl = new AbortController();
  expect(await ensureLocalAiServer("qwen", ctrl.signal)).toEqual(info);
  ctrl.abort();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("llm_server_status");
});
it("shares a cold start and cancelling one waiter does not cancel the other", async () => {
  const { ensureLocalAiServer } = await import("./local-ai-server");
  const load = deferred<typeof info>();
  vi.mocked(invoke).mockImplementation((command) => command === "start_llm_server" ? load.promise : Promise.resolve(null));
  const a = new AbortController(), b = new AbortController();
  const first = ensureLocalAiServer("qwen", a.signal), second = ensureLocalAiServer("qwen", b.signal);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("start_llm_server", { modelId: "qwen" }));
  const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" }); a.abort(); await cancelled;
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "stop_llm_server")).toHaveLength(0);
  load.resolve(info); expect(await second).toEqual(info);
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "start_llm_server")).toHaveLength(1);
});
it("cancels the last cold waiter and waits for stop completion before another start", async () => {
  const { ensureLocalAiServer } = await import("./local-ai-server");
  const load = deferred<typeof info>(), stop = deferred<void>();
  vi.mocked(invoke).mockImplementation((command) => command === "start_llm_server" ? load.promise : command === "stop_llm_server" ? stop.promise : Promise.resolve(null));
  const ctrl = new AbortController(), first = ensureLocalAiServer("qwen", ctrl.signal);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("start_llm_server", { modelId: "qwen" }));
  const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" }); ctrl.abort(); await cancelled;
  const next = ensureLocalAiServer("next");
  load.resolve(info); await Promise.resolve(); await Promise.resolve();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "start_llm_server")).toHaveLength(1);
  stop.resolve(); await next;
  expect(invoke).toHaveBeenCalledWith("start_llm_server", { modelId: "next" });
});
it("an already-cancelled caller or cancellation during status checking cannot start or stop a model", async () => {
  const { ensureLocalAiServer } = await import("./local-ai-server");
  const ctrl = new AbortController(); ctrl.abort();
  await expect(ensureLocalAiServer("qwen", ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(invoke).not.toHaveBeenCalled();
  const status = deferred<null>(), next = new AbortController(); vi.mocked(invoke).mockReturnValue(status.promise);
  const result = ensureLocalAiServer("qwen", next.signal);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const cancelled = expect(result).rejects.toMatchObject({ name: "AbortError" }); next.abort(); await cancelled;
  status.resolve(null); await Promise.resolve(); await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(1);
});
