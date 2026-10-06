import { useCallback, useEffect, useRef, useState } from "react";
import type { EditDocument } from "../bindings/EditDocument";
import { EditAudio, type EditAudioState } from "../lib/edit-audio";
import { fps } from "../lib/edit-document";
import { createFrameStore, type FrameStore } from "../lib/frame-store";

export type EditPlaybackOptions = {
  document: EditDocument;
  /** Edit track ids that sound, after solo and mute. */
  audible: string[];
  /** False parks the engine and releases its AudioContext. */
  active: boolean;
  /** Each source's sequence length in frames, when known. Without it a source is read only as far as the edit reaches into it. */
  sourceFrames?: Record<string, number>;
  /** Seconds of crossfade at each cut (View ▸ Audio), never under the 10 ms that keeps a cut from clicking. */
  joinFade?: number;
};

type Plan = { document: EditDocument; audibleKey: string; framesKey: string };
const apply = (target: EditAudio, plan: Plan) =>
  target.setDocument(plan.document, plan.audibleKey ? plan.audibleKey.split("|") : [], JSON.parse(plan.framesKey) as Record<string, number>);

type Status = Omit<EditAudioState, "frame">;

/**
 * Edit-list playback for one component: program frames on one audio clock.
 * The frame goes to `frames`, a store read by what draws it (lib/frame-store),
 * and only a change of rate, waiting or error is React state, so playing does
 * not re-render whoever holds the playback.
 */
export function useEditPlayback({ document, audible, active, sourceFrames, joinFade }: EditPlaybackOptions) {
  const [state, setState] = useState<Status>({ rate: 0, busy: false, error: null });
  const [frames] = useState<FrameStore>(() => createFrameStore(0)), sent = useRef(state);
  const [volume, setVolume] = useState(0.8), [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const rate = fps(document.edit_rate), audibleKey = audible.join("|"), framesKey = JSON.stringify(sourceFrames ?? {});
  const engine = useRef<EditAudio | null>(null), latest = useRef(state); latest.current = state;
  const settings = useRef({ document, audibleKey, framesKey, rate, active, volume, muted, levels, joinFade });
  settings.current = { document, audibleKey, framesKey, rate, active, volume, muted, levels, joinFade };
  const getEngine = useCallback(() => {
    const current = settings.current;
    if (!engine.current && current.active) {
      engine.current = new EditAudio(current.rate, (next) => {
        frames.set(next.frame);
        // Not even a same-value setState: React renders once more to find out it was the same.
        // Compared with what was last sent, not last rendered, so two changes before a render both land.
        const prior = sent.current;
        if (prior.rate !== next.rate || prior.busy !== next.busy || prior.error !== next.error) setState(sent.current = { rate: next.rate, busy: next.busy, error: next.error });
      });
      apply(engine.current, current); engine.current.setLevel(current.volume, current.muted); engine.current.setJoinFade(current.joinFade);
      for (const [id, level] of Object.entries(current.levels)) engine.current.setTrackLevel(id, level);
    }
    return engine.current;
  }, [frames]);
  // A new edit rate is a new clock; leaving the view releases the output.
  useEffect(() => () => { engine.current?.close(); engine.current = null; }, [rate, active]);
  useEffect(() => { if (engine.current) apply(engine.current, settings.current); }, [document, audibleKey, framesKey]);
  useEffect(() => { engine.current?.setLevel(volume, muted); }, [volume, muted]);
  useEffect(() => { engine.current?.setJoinFade(joinFade); }, [joinFade]);
  useEffect(() => { for (const [id, level] of Object.entries(levels)) engine.current?.setTrackLevel(id, level); }, [levels]);
  const seek = useCallback((frame: number, play = latest.current.rate !== 0) => getEngine()?.seek(frame, play ? 1 : 0) ?? Promise.resolve(), [getEngine]);
  const pause = useCallback(() => engine.current?.pause(), []);
  const toggle = useCallback(() => getEngine()?.toggle() ?? Promise.resolve(), [getEngine]);
  const scrub = useCallback((frame: number) => getEngine()?.scrub(frame), [getEngine]);
  const setTrackLevel = useCallback((id: string, level: number) => setLevels((prior) => ({ ...prior, [id]: level })), []);
  return { ...state, frames, playing: state.rate !== 0, seek, pause, toggle, scrub, volume, muted, setVolume, setMuted, levels, setTrackLevel };
}
