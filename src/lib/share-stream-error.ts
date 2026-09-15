import { invoke } from "@tauri-apps/api/core";
import type { StreamFailure } from "../bindings/StreamFailure";

/** Read only the current share's fixed native diagnosis. No retries of the
 * capture itself and no permission work. Native EOF cleanup and stderr drain
 * may finish just after the fetch ends, so allow one bounded delayed lookup. */
export async function describeShareStreamError(url: string, error: unknown, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return error;
  let requestId: string | null = null;
  try { requestId = new URL(url).searchParams.get("request"); } catch { return error; }
  if (!requestId || !/^[a-zA-Z0-9_-]{1,64}$/.test(requestId)) return error;
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let cancel: () => void = () => {};
  const stopped = new Promise<null>(resolve => {
    cancel = () => resolve(null);
    signal.addEventListener("abort", cancel, { once: true });
    deadline = setTimeout(cancel, 250);
  });
  const read = () => invoke<StreamFailure | null>("get_stream_failure", { requestId }).catch(() => null);
  try {
    let failure = await Promise.race([read(), stopped]);
    if (!failure && !signal.aborted) {
      await Promise.race([new Promise<void>(resolve => { retry = setTimeout(resolve, 100); }), stopped]);
      if (!signal.aborted) failure = await Promise.race([read(), stopped]);
    }
    return !signal.aborted && failure?.requestId === requestId && failure.kind.startsWith("share_")
      ? new Error(failure.message) : error;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (deadline !== null) clearTimeout(deadline);
    if (retry !== null) clearTimeout(retry);
  }
}
