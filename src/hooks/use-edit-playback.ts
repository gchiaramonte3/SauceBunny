import { useCallback, useEffect, useRef, useState } from "react";
import type { EditDocument } from "../bindings/EditDocument";
import { EditAudio, type EditAudioState } from "../lib/edit-audio";
import { fps } from "../lib/edit-document";

export type EditPlaybackOptions = {
  document: EditDocument;
  /** Edit track ids that sound, after solo and mute. */
  audible: string[];
  /** False parks the engine and releases its AudioContext. */
  active: boolean;
  /** Each source's sequence length in frames, when known. Without it a source is read only as far as the edit reaches into it. */
  sourceFrames?: Record<string, number>;
};

type Plan = { document: EditDocument; audibleKey: string; framesKey: string };
const apply = (target: EditAudio, plan: Plan) =>
  target.setDocument(plan.document, plan.audibleKey ? plan.audibleKey.split("|") : [], JSON.parse(plan.framesKey) as Record<string, number>);

/** Edit-list playback for one component: program frames on one audio clock. */
export function useEditPlayback({ document, audible, active, sourceFrames }: EditPlaybackOptions) {
  const [state, setState] = useState<EditAudioState>({ frame: 0, rate: 0, busy: false, error: null });
  const [volume, setVolume] = useState(0.8), [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState<Record<string, number>>({});
  const rate = fps(document.edit_rate), audibleKey = audible.join("|"), framesKey = JSON.stringify(sourceFrames ?? {});
  const engine = useRef<EditAudio | null>(null), latest = useRef(state); latest.current = state;
  const settings = useRef({ document, audibleKey, framesKey, rate, active, volume, muted, levels });
  settings.current = { document, audibleKey, framesKey, rate, active, volume, muted, levels };
  const getEngine = useCallback(() => {
    const current = settings.current;
    if (!engine.current && current.active) {
      engine.current = new EditAudio(current.rate, setState);
      apply(engine.current, current); engine.current.setLevel(current.volume, current.muted);
      for (const [id, level] of Object.entries(current.levels)) engine.current.setTrackLevel(id, level);
    }
    return engine.current;
  }, []);
  // A new edit rate is a new clock; leaving the view releases the output.
  useEffect(() => () => { engine.current?.close(); engine.current = null; }, [rate, active]);
  useEffect(() => { if (engine.current) apply(engine.current, settings.current); }, [document, audibleKey, framesKey]);
  useEffect(() => { engine.current?.setLevel(volume, muted); }, [volume, muted]);
  useEffect(() => { for (const [id, level] of Object.entries(levels)) engine.current?.setTrackLevel(id, level); }, [levels]);
  const seek = useCallback((frame: number, play = latest.current.rate !== 0) => getEngine()?.seek(frame, play ? 1 : 0) ?? Promise.resolve(), [getEngine]);
  const pause = useCallback(() => engine.current?.pause(), []);
  const toggle = useCallback(() => getEngine()?.toggle() ?? Promise.resolve(), [getEngine]);
  const scrub = useCallback((frame: number) => getEngine()?.scrub(frame), [getEngine]);
  const setTrackLevel = useCallback((id: string, level: number) => setLevels((prior) => ({ ...prior, [id]: level })), []);
  return { ...state, playing: state.rate !== 0, seek, pause, toggle, scrub, volume, muted, setVolume, setMuted, levels, setTrackLevel };
}
