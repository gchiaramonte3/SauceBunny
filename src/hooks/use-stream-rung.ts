import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_RUNG,
  initialRungState,
  isRungHeight,
  needsRebuild,
  reduceRung,
  rungBadge,
  type RungHeight,
  type RungPreference,
  type RungState,
} from "../lib/stream-rung";
import { loadJson, saveJson } from "../lib/storage";

const PREF_KEY = "saucebunny.streamRungPref";

/**
 * Tier B adaptive quality: the React shell around the pure policy in
 * `src/lib/stream-rung.ts`.
 *
 * All the decision-making lives in `reduceRung`, which is why this file is
 * short and has no rules of its own. What is here is the plumbing the policy
 * cannot be: persistence, a slow upshift timer, and the `active` gate.
 *
 * `active` is the whole reason this is a hook rather than always-on state. The
 * ladder applies to a PEER stream, where another Mac is encoding for us. A
 * YouTube stream has no rung — nobody is transcoding on our behalf and the
 * request must stay byte-identical to what every previous build sent, so the
 * hook reports `null` and the player omits the parameter entirely.
 */
export function useStreamRung(active: boolean) {
  const [pref, setPrefState] = useState<RungPreference>(() => {
    const raw = loadJson<unknown>(PREF_KEY, "auto");
    return isRungHeight(raw) ? raw : "auto";
  });
  const [state, setState] = useState<RungState>(() => initialRungState(Date.now(), pref));
  // How many consecutive replies came back as passthrough after we asked for
  // a rung. STATE, not a ref: it drives a user-visible notice, and a ref read
  // during render never triggers the re-render that would show it.
  const [unserved, setUnserved] = useState(0);

  // The playhead of this subsystem: `state.current` is what the player asks
  // for, and a change to it rebuilds the pipeline.
  const rung: RungHeight | null = active ? state.current : null;

  const dispatch = useCallback((make: (now: number) => Parameters<typeof reduceRung>[1]) => {
    setState((s) => reduceRung(s, make(Date.now())));
  }, []);

  /** The `<video>` ran dry. Raw signal; the policy decides what it means. */
  const onStall = useCallback(() => {
    dispatch((at) => ({ t: "stall", at }));
  }, [dispatch]);

  /**
   * What the presenter actually served. Two facts arrive here that the guest
   * cannot know any other way:
   *
   *  · `relayed` — the media is crossing n0's public relay rather than a
   *    direct link, which caps the ladder at its lowest rung (R6).
   *  · `rung` — what was really encoded. A host on an older build ignores the
   *    request and serves the source, and without noticing that the guest
   *    would keep downshifting against a host that was never going to comply,
   *    walking to the floor while nothing changed.
   */
  const onStreamInfo = useCallback((info: { rung: number | null; relayed: boolean }) => {
    dispatch((at) => ({ t: "path", relayed: info.relayed, at }));
    setUnserved((n) => (info.rung === null ? n + 1 : 0));
  }, [dispatch]);

  // Upshift is the only transition that needs a clock rather than an event,
  // because "nothing has gone wrong for a minute" is not something anything
  // fires. 15s is far finer than the 60s/120s windows the policy uses, so the
  // granularity is invisible, and it costs one comparison in a pure function.
  useEffect(() => {
    if (!active || pref !== "auto") return;
    const id = window.setInterval(() => {
      dispatch((at) => ({ t: "tick", at }));
    }, 15_000);
    return () => window.clearInterval(id);
  }, [active, pref, dispatch]);

  const setPref = useCallback((next: RungPreference) => {
    setPrefState(next);
    saveJson(PREF_KEY, next);
    setState((s) => reduceRung(s, { t: "prefer", pref: next, at: Date.now() }));
  }, []);

  // One chip, three things it can say. Folded together rather than exposed as
  // separate flags because a value nothing renders is not a feature — an
  // earlier draft returned `hostIgnoresRung` for a caller that never existed.
  const { badge, badgeTitle } = useMemo(() => {
    if (!active) return { badge: "", badgeTitle: "" };
    // Asked for a rung twice and got the source back both times: the host is
    // on a build without the ladder. Worth saying, because the stream will
    // not adapt however bad the connection gets, and the viewer would
    // otherwise read the stalling as our bug.
    if (unserved > 1) {
      return {
        badge: "source size",
        badgeTitle:
          "The presenter is on an older version that cannot reduce quality for you, "
          + "so this is playing at the file's original size.",
      };
    }
    const text = rungBadge(state);
    if (!text) return { badge: "", badgeTitle: "" };
    return {
      badge: text,
      badgeTitle: state.ceiling === state.current && text.includes("relayed")
        ? "This session could not connect directly, so the video is passing through a "
          + "public relay. Quality is held at the smallest size while that is true."
        : "Streaming quality. Change it in Settings under Co-review calls.",
    };
  }, [active, state, unserved]);

  return {
    /** Height to request, or null for passthrough / not a peer stream. */
    rung,
    /** Short status for the chip; empty when there is nothing worth saying. */
    badge,
    /** Tooltip explaining whatever `badge` is currently showing. */
    badgeTitle,
    pref,
    setPref,
    onStall,
    onStreamInfo,
  };
}

export { DEFAULT_RUNG, needsRebuild };
