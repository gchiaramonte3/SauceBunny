import { useCallback, useEffect, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import { sequenceFps } from "../lib/multitrack";
import { alternativeLane, auditionLanes, mediaRevision } from "../lib/multitrack-graph";
import { MultitrackAudio, type AuditionState } from "../lib/multitrack-audio";
import { loadViewState, saveViewState } from "../lib/multitrack-view-state";

export function audibleTracks(ids: string[], solo: Set<string>, muted: Set<string>) {
  return ids.filter((id) => (!solo.size || solo.has(id)) && !muted.has(id));
}
export function useMultitrackAudition(document: AafDocument, active: boolean) {
  const [state, setState] = useState<AuditionState>({ frame: 0, rate: 0, busy: false, error: null });
  // The last mix for this sequence comes back; alternatives start muted only when there is none.
  const [saved] = useState(() => loadViewState(document.id, document.manifest.tracks.map(track => track.id)));
  const [solo, setSolo] = useState(() => new Set(saved?.solo ?? [])), [mute, setMute] = useState(() => new Set(saved?.mute ?? document.manifest.tracks.filter(track => alternativeLane(document, track.id)).map(track => track.id)));
  const [levels, setLevels] = useState<Record<string, number>>(() => saved?.levels ?? {});
  useEffect(() => { saveViewState(document.id, { solo: [...solo], mute: [...mute], levels }); }, [document.id, solo, mute, levels]);
  const [volume, setVolume] = useState(0.8), [muted, setMuted] = useState(false), [scrubbing, setScrubbing] = useState(true);
  const engine = useRef<MultitrackAudio | null>(null), latest = useRef(state); latest.current = state;
  const settings = useRef({ document, solo, mute, volume, muted, scrubbing, active }); settings.current = { document, solo, mute, volume, muted, scrubbing, active };
  const getEngine = useCallback(() => {
    const current = settings.current;
    if (!engine.current && current.active) {
      engine.current = new MultitrackAudio(current.document.id, sequenceFps(current.document.manifest), current.document.manifest.duration_frames,
        auditionLanes(current.document, current.solo, current.mute), setState);
      engine.current.setLevel(current.volume, current.muted); engine.current.setScrubbing(current.scrubbing);
    }
    return engine.current;
  }, []);
  const mediaKey = mediaRevision(document);
  const prepared = useRef(new Map<string, string>());
  useEffect(() => () => { engine.current?.close(); engine.current = null; prepared.current.clear(); }, [document.id]);
  useEffect(() => {
    const snapshot = settings.current.document;
    // Adding a newly verified mic must not destroy the clock or the buffers
    // already playing. Only changes to previously available audio invalidate it.
    const changed = [...prepared.current].some(([id, key]) => mediaRevision(snapshot, id) !== key);
    if (changed) engine.current?.suspend();
    prepared.current = new Map(snapshot.manifest.tracks.filter(track => !snapshot.manifest.graph || snapshot.manifest.graph.lanes.some(lane => lane.track_id === track.id && lane.availability === "ready"))
      .map(track => [track.id, mediaRevision(snapshot, track.id)]));
    if (active) void getEngine()?.warm(latest.current.frame);
  }, [active, document.id, mediaKey, getEngine]);
  useEffect(() => { if (!active) engine.current?.suspend(); }, [active]);
  useEffect(() => { engine.current?.setLevel(volume, muted); }, [volume, muted]);
  useEffect(() => { engine.current?.setScrubbing(scrubbing); }, [scrubbing]);
  useEffect(() => { for (const [id, level] of Object.entries(levels)) engine.current?.setTrackLevel(id, level); }, [levels, active]);
  const trackKey = auditionLanes(document, solo, mute).join("|");
  useEffect(() => { engine.current?.setTracks(trackKey ? trackKey.split("|") : []); }, [trackKey]);
  const seek = useCallback((frame: number, _trackId?: string, play = latest.current.rate !== 0) => getEngine()?.seek(frame, play ? 1 : 0) ?? Promise.resolve(), [getEngine]);
  const pause = useCallback(() => engine.current?.pause(), []);
  const toggle = useCallback(() => { if (latest.current.rate || latest.current.busy) pause(); else void getEngine()?.seek(latest.current.frame >= settings.current.document.manifest.duration_frames - 1 ? 0 : latest.current.frame, 1); }, [getEngine, pause]);
  const shuttle = useCallback((direction: 1 | -1) => { void getEngine()?.shuttle(direction); }, [getEngine]);
  const toggleSet = (set: typeof setSolo, id: string) => set((prior) => { const next = new Set(prior); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return { ...state, playing: state.rate !== 0, solo, mute, toggleSolo: (id: string) => { if (!solo.has(id)) setMute(prior => { const next = new Set(prior); next.delete(id); return next; }); toggleSet(setSolo, id); }, toggleMute: (id: string) => toggleSet(setMute, id),
    volume, muted, setVolume, setMuted, levels, setTrackLevel: (id: string, level: number) => setLevels((prior) => ({ ...prior, [id]: level })), scrubbing, setScrubbing, seek, pause, toggle, shuttle,
    scrub: (frame: number) => getEngine()?.scrub(frame) };
}
