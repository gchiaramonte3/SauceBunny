import { invoke } from "@tauri-apps/api/core";
import type { LlmModel } from "../bindings/LlmModel";
import type { LlmServerInfo } from "../bindings/LlmServerInfo";

/** The same installed-model preference in Summary and transcript search. */
export function selectLocalAiModel(models: LlmModel[], selected?: string | null): LlmModel | undefined {
  const installed = models.filter((model) => model.downloaded);
  return installed.find((model) => model.id === selected) ?? installed.find((model) => model.recommended) ?? installed[0];
}

type Startup = { modelId: string; users: Set<symbol>; controller: AbortController; result: Promise<LlmServerInfo>; done: Promise<void> };
let startup: Startup | null = null;
const aborted = () => new DOMException("Aborted", "AbortError");

/** Cancel this caller's wait, not a resident model another feature is using. */
function waitFor<T>(work: Promise<T>, signal?: AbortSignal, release?: () => void): Promise<T> {
  if (signal?.aborted) { release?.(); return Promise.reject(aborted()); }
  return new Promise((resolve, reject) => {
    const cancel = () => { release?.(); reject(aborted()); };
    signal?.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => signal?.removeEventListener("abort", cancel));
  });
}

/** Share in-flight loads. A different model waits for the old attempt's cleanup.
 * Only the last cancelled waiter stops a cold load; cancelling a chat never
 * kills a ready server. No downloads, persistence or new transport here.
 */
export async function ensureLocalAiServer(modelId: string, signal?: AbortSignal): Promise<LlmServerInfo> {
  signal?.throwIfAborted();
  if (startup && (startup.modelId !== modelId || startup.controller.signal.aborted)) {
    await waitFor(startup.done, signal);
    return ensureLocalAiServer(modelId, signal);
  }
  if (!startup) {
    const controller = new AbortController();
    const result = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const resident = await invoke<LlmServerInfo | null>("llm_server_status");
      controller.signal.throwIfAborted();
      if (resident?.model_id === modelId) return resident;
      let stopping: Promise<unknown> | undefined;
      const cancel = () => { stopping ??= invoke("stop_llm_server").catch(() => undefined); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      try {
        const info = await invoke<LlmServerInfo>("start_llm_server", { modelId });
        controller.signal.throwIfAborted();
        return info;
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        // Do not let a new start race the previous attempt's stop command.
        await stopping;
      }
    });
    const entry: Startup = { modelId, controller, users: new Set(), result,
      done: result.then(() => undefined, () => undefined).finally(() => { if (startup === entry) startup = null; }),
    };
    startup = entry;
  }
  const entry = startup, user = Symbol();
  entry.users.add(user);
  const release = () => { entry.users.delete(user); if (!entry.users.size) entry.controller.abort(); };
  try { return await waitFor(entry.result, signal, release); }
  finally { entry.users.delete(user); }
}
