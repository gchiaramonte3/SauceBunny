import { useEffect, type DependencyList } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Subscribe to Tauri events for the life of a component, safely.
 *
 * Five hooks were extracted out of App.tsx this week and every one of them
 * carried the same twelve lines: an `unlistens` array, a `mounted` flag, an
 * async IIFE, a tail sweep, and a cleanup — plus a word-for-word identical
 * comment explaining the subtle part. Four identical copies of a rule is the
 * shape this codebase has already been bitten by twice (four `formatTalk`
 * copies that had drifted, two `formatBytes` that disagreed), so it is worth
 * collapsing while the copies still AGREE rather than after one of them stops.
 *
 * The subtle part, now in one place instead of four:
 *
 *  · `listen()` is async. A cleanup that runs while those promises are still
 *    in flight iterates an `unlistens` array that is still empty and
 *    unregisters nothing. Under StrictMode's double-mount that leaked every
 *    listener on each dev boot. So a subscription that resolves AFTER teardown
 *    releases itself instead of joining a list nobody will read again.
 *  · Handlers are gated on the same flag, so a late event cannot write state
 *    into an unmounted tree. Each caller used to repeat `if (!mounted) return`
 *    at the top of every handler; that is now automatic.
 *
 * Callers keep their own job-id filtering, which is per-handler policy rather
 * than lifecycle: `on("x", e => { if (e.job_id !== ref.current) return; ... })`.
 *
 * NOT every listener in the app goes through here, and that is deliberate.
 * `use-co-review`, `use-panel-bus` and `use-stream-keep` clean up with
 * `un.then((f) => f())` per listener — a simpler idiom that never grew the
 * array, the flag or the tail sweep, so there is no duplicated subtlety in
 * them to collapse. Moving them would be uniformity for its own sake. The one
 * thing this adds over that idiom is the handler gate: between unmount and a
 * pending `listen()` resolving, their handlers can still run. Harmless for a
 * setState, less so for anything that writes a ref or settles a promise — so
 * prefer this for new code, and leave those three alone until they need it.
 */
export function useTauriListeners(
  register: (on: <T>(event: string, handler: (payload: T) => void) => void) => void,
  deps: DependencyList,
): void {
  useEffect(() => {
    const unlistens: UnlistenFn[] = [];
    let mounted = true;

    const on = <T,>(event: string, handler: (payload: T) => void): void => {
      void listen<T>(event, (e) => { if (mounted) handler(e.payload); }).then((off) => {
        // Resolved after teardown: release it here, because the cleanup below
        // has already walked the array and will not walk it again.
        if (!mounted) { off(); return; }
        unlistens.push(off);
      });
    };

    register(on);

    return () => {
      mounted = false;
      unlistens.forEach((u) => u());
    };
    // The caller owns its dependency list; every current caller passes only
    // stable references, so these subscribe once. The menubar hook is the one
    // that deliberately re-subscribes, on a path string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
