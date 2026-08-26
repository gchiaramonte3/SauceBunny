/**
 * Mounts the REAL src/components/MSEStreamPlayer.tsx against the REAL Rust
 * stream proxy (booted by `harness_seek_session_server` in stream_proxy.rs)
 * and drives the two gestures a user makes, then reports the seek log.
 *
 * Everything here is real: a real MediaSource, a real fetch of a real
 * ffmpeg-remuxed fMP4, real rebuilds. The only thing the harness supplies is
 * the gestures, which is exactly the part a unit test has to fake.
 *
 * Harness only — nothing here is app code.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MSEStreamPlayer } from "../src/components/MSEStreamPlayer";
import type { PlayerHandle } from "../src/components/player-handle";

const params = new URLSearchParams(location.search);
const PATH = params.get("path") ?? "";
const DURATION = Number(params.get("duration") ?? "600");

type Line = { at: number; tag: string; msg: string };
const log: Line[] = [];
const t0 = Date.now();
const done: { value: unknown } = { value: null };
(globalThis as unknown as Record<string, unknown>).__SEEK_LOG__ = log;
(globalThis as unknown as Record<string, unknown>).__SEEK_DONE__ = done;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function Harness() {
  const ref = React.useRef<PlayerHandle>(null);
  React.useEffect(() => {
    void (async () => {
      // Wait for the first pipeline to open.
      for (let i = 0; i < 200 && !log.some((l) => l.msg.includes("pipeline open")); i++) await sleep(100);

      // ── Gesture 1: a CLICK, far from the playhead ───────────────
      ref.current?.seekTo(DURATION * 0.2255);   // 135.3s on a 600s source
      await sleep(2500);

      // ── Gesture 2: a DRAG, released well past where it began ────
      // One seek per frame, the way Timeline's rAF-coalesced scrub emits them.
      const from = DURATION * 0.44;
      const to = DURATION * 0.67;
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        ref.current?.seekTo(from + ((to - from) * i) / steps);
        await sleep(16);
      }
      await sleep(2500);

      // ── Gesture 3: a DRAG back to the very start ────────────────
      const back = DURATION * 0.85;
      ref.current?.seekTo(back);
      await sleep(16);
      for (let i = 10; i >= 0; i--) {
        ref.current?.seekTo((back * i) / 10);
        await sleep(16);
      }
      await sleep(2500);

      done.value = { ok: true, lines: log.length };
    })();
  }, []);

  if (!PATH) return React.createElement("pre", null, "no ?path=");
  return React.createElement(MSEStreamPlayer, {
    ref,
    path: PATH,
    hasVideo: true,
    initialVolume: 0,
    knownDuration: DURATION,
    // The scrub preview opens a SECOND mediabunny pipeline over the raw route.
    // Off here so the log is the seek machinery and nothing else.
    disableScrubPreview: true,
    onDiag: (tag: string, msg: string) => { log.push({ at: Date.now() - t0, tag, msg }); },
    onError: (m: string) => { log.push({ at: Date.now() - t0, tag: "err", msg: m }); },
  });
}

createRoot(document.getElementById("root")!).render(React.createElement(Harness));
