import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  IDLE_KEEP, keepBadge, reduceKeep, shouldHandOff, shouldTransfer,
  type KeepEvent, type KeepState,
} from "../lib/stream-keep";
import { loadJson, saveJson } from "../lib/storage";

/** Standing per-machine preference. Default ON: the guest already consented at
 *  the moment it matters, because the Watch button names the write. */
const PREF_KEY = "saucebunny.streamKeep";

/**
 * "Watch it now" also keeps it: the React shell around the pure policy in
 * `src/lib/stream-keep.ts`.
 *
 * Every rule lives in `reduceKeep`, which is why this file has none of its own.
 * What is here is only what a pure function cannot be: the tick clock, the
 * Tier C invoke, and the one-shot handoff.
 *
 * THE CANCEL IS THE THROTTLE. There is no "pause" on a Tier C transfer, and
 * there does not need to be one: the fetch is resumable at byte granularity
 * (the receiver keeps a `.part` and folds it back into the hash), so cancelling
 * to yield and re-invoking to resume costs a round trip and nothing else. It
 * does mean the promise REJECTS every time we yield, which is why a rejection
 * we caused is not reported as a failure — a background copy politely getting
 * out of the way must never surface as something going wrong.
 */
export function useStreamKeep({
  watching, onHandOff, log,
}: {
  /** The peer stream on screen, or null when not watching one. */
  watching: { blake3: string; name: string; total: number } | null;
  /** Called once, when the copy has landed and is the file on screen. */
  onHandOff: (path: string, name: string) => void;
  log?: (level: "ok" | "info" | "err", msg: string) => void;
}) {
  const [enabled, setEnabledState] = useState<boolean>(
    () => loadJson<unknown>(PREF_KEY, true) !== false,
  );
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [state, setState] = useState<KeepState>(IDLE_KEEP);
  const dispatch = useCallback((make: (now: number) => KeepEvent) => {
    setState((s) => reduceKeep(s, make(Date.now())));
  }, []);

  // What the transport told us about the path. Held OUTSIDE the policy state
  // because it arrives from the player asynchronously and may land either side
  // of the watch starting; the policy is told at the moment it must decide.
  const relayedRef = useRef(false);
  /** The blake3 whose fetch we currently have in flight, so it starts once. */
  const inFlightRef = useRef<string | null>(null);
  /** Set while WE are cancelling, so the resulting rejection stays quiet. */
  const yieldingRef = useRef(false);
  /** Handed off already; the swap must happen exactly once. */
  const handedRef = useRef<string | null>(null);

  /** The `<video>` ran dry. Raw signal; the policy decides what it means. */
  const onStall = useCallback(() => {
    dispatch((at) => ({ t: "stall", at }));
  }, [dispatch]);

  /** Same payload the rung ladder reads; we only care about `relayed`. */
  const onStreamInfo = useCallback((info: { rung: number | null; relayed: boolean }) => {
    relayedRef.current = info.relayed;
  }, []);

  // Start / stop with the stream on screen. A source change is a `stop`, which
  // clears the blake3 — that is what stops a copy finishing later and handing
  // off a file the room has already moved on from.
  useEffect(() => {
    if (!watching) {
      dispatch((at) => ({ t: "stop", at }));
      return;
    }
    dispatch((at) => ({
      t: "watch", blake3: watching.blake3, total: watching.total,
      relayed: relayedRef.current, enabled: enabledRef.current, at,
    }));
    // `enabled` is a dep so flipping the setting mid-watch re-decides rather
    // than waiting for the next source: turning it off should stop the copy
    // that is running, which is the only reason someone reaches for it.
  }, [watching, enabled, dispatch]);

  // The delays are 10s and 30s, so 5s granularity is invisible against them
  // and costs one comparison in a pure function. Only runs while a copy is
  // pending or paused — an idle session has no timer at all.
  const ticking = state.phase === "waiting" || state.phase === "yielded";
  useEffect(() => {
    if (!ticking) return;
    const id = window.setInterval(() => dispatch((at) => ({ t: "tick", at })), 5_000);
    return () => window.clearInterval(id);
  }, [ticking, dispatch]);

  // Progress. The receiver already emits this for the explicit "Get the file"
  // button, so keeping reuses it rather than adding a second channel.
  useEffect(() => {
    const un = listen<{ phase: string; received: number; total: number }>(
      "session:transfer",
      (e) => {
        if (e.payload.phase !== "receiving") return;
        setState((s) => reduceKeep(s, {
          t: "progress", received: e.payload.received, total: e.payload.total,
        }));
      },
    );
    return () => { void un.then((f) => f()); };
  }, []);

  // The transfer itself. Driven off `shouldTransfer` so start and cancel read
  // the same one line and cannot drift into two different opinions.
  const wanted = shouldTransfer(state);
  const blake3 = state.blake3;
  const name = watching?.name ?? "";
  useEffect(() => {
    if (wanted && blake3 && inFlightRef.current !== blake3) {
      inFlightRef.current = blake3;
      yieldingRef.current = false;
      void invoke<string>("session_fetch_file", { blake3Hex: blake3, name })
        .then((path) => {
          inFlightRef.current = null;
          dispatch((at) => ({ t: "done", path, at }));
        })
        .catch(() => {
          inFlightRef.current = null;
          // A rejection we caused by yielding is the mechanism working, not a
          // failure — the partial is kept and the next tick resumes it.
          if (yieldingRef.current) { yieldingRef.current = false; return; }
          dispatch((at) => ({ t: "failed", at }));
        });
      return;
    }
    if (!wanted && inFlightRef.current) {
      yieldingRef.current = true;
      void invoke("session_cancel_fetch", { blake3Hex: inFlightRef.current }).catch(() => {});
    }
  }, [wanted, blake3, name, dispatch]);

  // The handoff. Guarded on the copy still being the file on screen, and
  // one-shot: a re-render must not swap the source a second time.
  useEffect(() => {
    if (!shouldHandOff(state, watching?.blake3 ?? null)) return;
    if (handedRef.current === state.blake3) return;
    handedRef.current = state.blake3;
    log?.("ok", `Saved "${watching?.name ?? "the file"}". Playing your own copy now.`);
    onHandOff(state.path!, watching?.name ?? "");
  }, [state, watching, onHandOff, log]);

  const badge = useMemo(() => keepBadge(state), [state]);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    saveJson(PREF_KEY, next);
  }, []);

  return { state, badge, enabled, setEnabled, onStall, onStreamInfo };
}
