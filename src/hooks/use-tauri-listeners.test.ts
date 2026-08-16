// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useTauriListeners } from "./use-tauri-listeners";

/**
 * The twelve lines four hooks each carried, now tested once.
 *
 * The case that mattered and that none of the four copies could check on its
 * own is the LATE RESOLVE: `listen()` is async, so a component that unmounts
 * while those promises are in flight runs a cleanup over an empty array and
 * unregisters nothing. Under StrictMode's double-mount that leaked every
 * listener on each dev boot — a bug the copies described in a comment and left
 * to be believed.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  unlistened: [] as string[],
  /** Parks `listen()` so a test can unmount mid-flight. */
  gate: null as null | { wait: Promise<void>; release: () => void },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    if (h.gate) await h.gate.wait;
    h.handlers.set(name, cb);
    return () => { h.unlistened.push(name); };
  },
}));

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  return { wait, release };
}

const fire = (name: string, payload: unknown) => h.handlers.get(name)?.({ payload });

beforeEach(() => { h.handlers.clear(); h.unlistened.length = 0; h.gate = null; });
afterEach(() => vi.clearAllMocks());

describe("subscribe and clean up", () => {
  it("registers what the caller asks for and releases it on unmount", async () => {
    const seen: unknown[] = [];
    const { unmount } = renderHook(() =>
      useTauriListeners((on) => {
        on<string>("a", (p) => seen.push(p));
        on<string>("b", (p) => seen.push(p));
      }, []));
    await waitFor(() => expect(h.handlers.size).toBe(2));
    fire("a", 1); fire("b", 2);
    expect(seen).toEqual([1, 2]);
    unmount();
    await waitFor(() => expect(h.unlistened.sort()).toEqual(["a", "b"]));
  });

  it("hands the handler the PAYLOAD, not the envelope", async () => {
    // Callers used to unwrap `e.payload` themselves in every handler.
    const seen: unknown[] = [];
    renderHook(() => useTauriListeners((on) => { on<{ x: number }>("e", (p) => seen.push(p)); }, []));
    await waitFor(() => expect(h.handlers.size).toBe(1));
    fire("e", { x: 7 });
    expect(seen).toEqual([{ x: 7 }]);
  });
});

describe("a subscription that resolves AFTER teardown", () => {
  it("releases itself instead of leaking", async () => {
    // The StrictMode leak, reproduced: unmount while listen() is still
    // pending, then let it resolve. Without the self-release the listener
    // stays registered for the life of the process.
    h.gate = deferred();
    const { unmount } = renderHook(() => useTauriListeners((on) => { on("late", () => {}); }, []));
    unmount();                     // cleanup runs over an empty array
    h.gate.release();              // ...and only now does listen() resolve
    await waitFor(() => expect(h.unlistened).toEqual(["late"]));
  });

  it("does not invoke a handler after unmount", async () => {
    const seen: unknown[] = [];
    const { unmount } = renderHook(() =>
      useTauriListeners((on) => { on<number>("x", (p) => seen.push(p)); }, []));
    await waitFor(() => expect(h.handlers.size).toBe(1));
    unmount();
    fire("x", 1);   // a late event from a channel not yet released
    expect(seen).toEqual([]);
  });
});

describe("re-subscription follows the caller's deps", () => {
  it("does not re-subscribe when the deps are stable", async () => {
    const { rerender } = renderHook(() => useTauriListeners((on) => { on("s", () => {}); }, []));
    await waitFor(() => expect(h.handlers.size).toBe(1));
    rerender(); rerender();
    expect(h.unlistened).toEqual([]);
  });

  it("re-subscribes when a dep changes, releasing the old one first", async () => {
    // The menubar hook depends on a path STRING and must rebind when it
    // changes, so this is behaviour, not an edge case.
    const { rerender } = renderHook(({ k }) => useTauriListeners((on) => { on("s", () => {}); }, [k]),
      { initialProps: { k: 1 } });
    await waitFor(() => expect(h.handlers.size).toBe(1));
    rerender({ k: 2 });
    await waitFor(() => expect(h.unlistened).toEqual(["s"]));
  });
});
