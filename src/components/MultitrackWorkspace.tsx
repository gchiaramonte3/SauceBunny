import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useVideoForegroundPriority } from "../hooks/use-video-intelligence";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import { useMultitrackAudition } from "../hooks/use-multitrack-audition";
import { useMultitrackTranscription } from "../hooks/use-multitrack-transcription";
import { useMultitrackKeyboard } from "../hooks/use-multitrack-keyboard";
import { useMultitrackDetail } from "../hooks/use-multitrack-detail";
import { sequenceDurationTimecode, sequenceFps, sequenceRate, sequenceTimecode, trackOwner } from "../lib/multitrack";
import { GenerateButton } from "./GenerateButton";
import { IconPause, IconPlay, IconSkipBack, IconRewind, IconFastForward } from "./Icons";
import { VolumeControl } from "./VolumeControl";
import { MultitrackTimeline } from "./MultitrackTimeline";
import { MultitrackTranscript } from "./MultitrackTranscript";
import { MultitrackCast } from "./MultitrackCast";
import { MultitrackSettings } from "./MultitrackSettings";
import { usePaneWidth } from "../hooks/use-pane-width";
import { MultitrackModelPicker } from "./MultitrackModelPicker";
import { MultitrackTrackActions, type MultitrackMenuTarget } from "./MultitrackTrackActions";
import { MultitrackRegenerate } from "./MultitrackRegenerate";
import type { RenameMic } from "./CastMarkerFields";
import { MultitrackTimecodeDialog } from "./MultitrackTimecodeDialog";
import { alternativeLane, laneReady, laneSelectable, visibleLanes } from "../lib/multitrack-graph";

type Props = {
  document: AafDocument; active: boolean; waveforms: Record<string, number[][]>; waveformErrors: Record<string, string>;
  labelStatus: string; onRename: RenameMic; onTranscript: (transcript: AafTrackTranscript) => void;
  onOpenSettings?: () => void; onJobState?: (running: boolean) => void; settingsOpen?: boolean; onCloseSettings?: () => void;
  aiModelId?: string | null;
  onVisibleTracks?: (ids: string[]) => void;
  openRequest?: { id: string; tick: number; frame?: number; trackId?: string } | null;
};
export function MultitrackWorkspace({ document, active, waveforms, waveformErrors, labelStatus, onRename, onTranscript, onOpenSettings, onJobState, settingsOpen, onCloseSettings, aiModelId, openRequest, onVisibleTracks }: Props) {
  const [selected, setSelected] = useState(() => new Set(document.manifest.tracks.filter(track => !alternativeLane(document, track.id) && laneSelectable(document, track.id)).map((track) => track.id)));
  const [expanded, setExpanded] = useState(new Set<string>());
  const [relinking, setRelinking] = useState(false);
  const visible = visibleLanes(document, expanded).map(track => track.id);
  const visibleKey = visible.join("|");
  useEffect(() => { onVisibleTracks?.(visibleKey.split("|")); }, [visibleKey, onVisibleTracks]);
  const eligible = visible.filter(id => laneSelectable(document, id));
  const chosen = [...selected].filter(id => laneReady(document, id));
  const [showWaveforms, setShowWaveforms] = useState(true);
  const [timecodeEntry, setTimecodeEntry] = useState<string | null>(null);
  const closeTimecode = useCallback(() => setTimecodeEntry(null), []);
  const [castTrack, setCastTrack] = useState<string | null>(null);
  const [trackMenu, setTrackMenu] = useState<MultitrackMenuTarget | null>(null), [regenerate, setRegenerate] = useState<string | null>(null);
  const closeTrackMenu = useCallback(() => setTrackMenu(null), []);
  useEffect(() => { if (!active) { setTrackMenu(null); setRegenerate(null); setCastTrack(null); } }, [active]);
  useEffect(() => { closeTimecode(); }, [active, document.id, settingsOpen, closeTimecode]);
  const workspace = useRef<HTMLDivElement>(null);
  const [paneMax, setPaneMax] = useState(640);
  const pane = usePaneWidth({ key: "saucebunny.multitrackTranscriptWidth", min: 260, max: paneMax, fallback: 340, side: "right" });
  useEffect(() => {
    const element = workspace.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setPaneMax(Math.max(260, Math.min(640, Math.floor(entry.contentRect.width - 420))));
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const clampPane = pane.setWidth;
  useEffect(() => { clampPane((width) => width); }, [clampPane]);
  const [view, setView] = useState({ start: 0, span: document.manifest.duration_frames, enabled: false });
  const onView = useCallback((start: number, span: number, enabled: boolean) => setView((prior) => prior.start === start && prior.span === span && prior.enabled === enabled ? prior : { start, span, enabled }), []);
  const detail = useMultitrackDetail(document, view.start, view.span, active && view.enabled, visible);
  const audio = useMultitrackAudition(document, active && !relinking);
  useVideoForegroundPriority(audio.playing || audio.busy);
  const transcription = useMultitrackTranscription(document, onTranscript, active);
  useMultitrackKeyboard(active && !settingsOpen, audio, sequenceRate(document.manifest) ? setTimecodeEntry : undefined);
  useEffect(() => { onJobState?.(transcription.loading || relinking); }, [onJobState, transcription.loading, relinking]);
  const duration = document.manifest.duration_frames;
  const seek = (frame: number, trackId?: string) => { void audio.seek(frame, trackId); };
  const handledSeek = useRef<number | null>(null), seekAudio = audio.seek;
  useEffect(() => {
    if (!active || !openRequest || openRequest.id !== document.id || openRequest.frame == null || handledSeek.current === openRequest.tick) return;
    handledSeek.current = openRequest.tick;
    void seekAudio(openRequest.frame, openRequest.trackId, false);
  }, [active, document.id, openRequest, seekAudio]);
  const toggleTrack = (trackId: string) => setSelected((prior) => { const next = new Set(prior); if (next.has(trackId)) next.delete(trackId); else next.add(trackId); return next; });
  const cannotGenerate = !chosen.length || !transcription.ready || relinking;
  const transport = <div className="cp-multitrack-transport" aria-label="Multitrack playback controls">
    <div className="cp-multitrack-toolbar-options">
      <button className="btn btn-ghost" aria-pressed={audio.scrubbing} title="Hear short audio excerpts while scrubbing" onClick={() => audio.setScrubbing(!audio.scrubbing)}>Audio scrub</button>
      <button className="btn btn-ghost" aria-pressed={showWaveforms} onClick={() => setShowWaveforms(!showWaveforms)}>Waveforms</button>
    </div>
    <div className="cp-multitrack-transport-center">
      <button className="cp-tc cp-multitrack-tc" aria-label="Current timecode" aria-haspopup="dialog" title="Current timecode · Type 0-9, Enter to seek" disabled={!sequenceRate(document.manifest)} onClick={(event) => { event.currentTarget.focus(); setTimecodeEntry(""); }}>{sequenceTimecode(document.manifest, audio.frame)}</button>
      <div className="cp-multitrack-transport-buttons">
      <button className="cp-transport-btn" aria-label="Go to sequence start" onClick={() => seek(0)}><IconSkipBack /></button>
      <button className="cp-transport-btn" aria-label="Rewind tracks" title="Rewind (J)" onClick={() => audio.shuttle(-1)}><IconRewind /></button>
      <button className="cp-transport-btn play" aria-label={audio.playing || audio.busy ? "Pause audition" : "Play tracks"} onClick={audio.toggle}>{audio.playing || audio.busy ? <IconPause /> : <IconPlay />}</button>
      <button className="cp-transport-btn" aria-label="Fast-forward tracks" title="Fast-forward (L)" onClick={() => audio.shuttle(1)}><IconFastForward /></button>
      </div>
    </div>
    <div className="cp-multitrack-toolbar-end">
      <div className="cp-multitrack-trt" aria-label="Total runtime" title="Total runtime of the loaded sequence"><span>TRT</span><span>{sequenceDurationTimecode(document.manifest)}</span></div>
      <div className="cp-multitrack-audition-status"><span className="cp-multitrack-note" role="status">{audio.busy ? "Preparing audio…" : audio.rate && audio.rate !== 1 ? `${audio.rate}×` : audio.solo.size ? `${audio.solo.size} soloed` : "All mics"}</span>
      <VolumeControl volume={audio.volume} muted={audio.muted} onVolumeChange={audio.setVolume} onMutedChange={audio.setMuted} /></div></div>
  </div>;
  return <div ref={workspace} className="cp-multitrack-workspace" style={{ "--multitrack-transcript-width": `${Math.min(pane.width, paneMax)}px` } as CSSProperties}>
    <div className="cp-multitrack-editor">
      <div className="cp-multitrack-editor-content">
      <div className="cp-multitrack-sequence-head"><h2 title={document.manifest.name}>{document.manifest.name}</h2><span className="cp-multitrack-note">{sequenceFps(document.manifest).toFixed(3).replace(/\.?0+$/, "")} fps</span><span className="cp-multitrack-note" role="status">{labelStatus}</span></div>
      <MultitrackCast document={document} active={active} onRename={onRename} editTrack={castTrack} onCloseEdit={() => setCastTrack(null)} />
      <MultitrackTimeline document={document} waveforms={waveforms} waveformErrors={waveformErrors} selected={selected} onSelect={toggleTrack} onRename={onRename} onOwnerMenu={setCastTrack} onView={onView} detail={{ ...view, peaks: detail }}
        solo={audio.solo} muted={audio.mute} onSolo={audio.toggleSolo} onMute={audio.toggleMute} levels={audio.levels} onLevel={audio.setTrackLevel} onTrackMenu={(id, x, y) => setTrackMenu({ id, x, y })} frame={audio.frame} onSeek={seek} onScrub={audio.scrub}
        onScrubEnd={(frame, resume) => { void audio.seek(frame, undefined, resume); }} playing={audio.playing} showWaveforms={showWaveforms} transport={transport}
        expanded={expanded} onExpand={(id) => setExpanded(prior => { const next = new Set(prior); if (next.has(id)) next.delete(id); else next.add(id); return next; })} />
      {audio.error && <p className="cp-multitrack-error" role="alert">{audio.error}</p>}
      </div>
      <div className="cp-multitrack-generation">
        <div className="cp-multitrack-options"><MultitrackModelPicker choice={{ engine: transcription.engine, modelId: transcription.modelId, ...transcription.options }} models={transcription.models} disabled={transcription.loading} onChange={(choice) => { transcription.setEngine(choice.engine); transcription.setModelId(choice.modelId); transcription.setOptions({ fast: choice.fast === true, speechOnly: choice.speechOnly === true }); }} />
          <span className="cp-multitrack-note">Entire sequence</span><button className="btn btn-ghost" onClick={() => setSelected(new Set(eligible.every(id => selected.has(id)) ? [] : eligible))} disabled={transcription.loading || relinking}>{eligible.length > 0 && eligible.every(id => selected.has(id)) ? "Deselect all" : "Select all"}</button>
          <div className="cp-multitrack-generate-row"><GenerateButton idleLabel={`Generate ${chosen.length} ${chosen.length === 1 ? "track" : "tracks"}`} loadingLabel={transcription.status || "Preparing…"} loading={transcription.loading} progress={transcription.progress} resolution={transcription.resolution} onResolved={transcription.clearResolution} disabled={cannotGenerate} onClick={() => void transcription.start(chosen, 0, duration)} />
            {transcription.loading && <button className="btn btn-ghost" onClick={transcription.stop}>Stop</button>}</div>
        </div>
        {!transcription.ready && <p className="cp-multitrack-note">An installed model is required. {onOpenSettings && <button className="cp-multitrack-text-button" onClick={onOpenSettings}>Open model settings</button>}</p>}
        {!selected.size && <p className="cp-multitrack-note">Check at least one track to generate.</p>}
        {transcription.status && <p className="cp-multitrack-note" role="status">{transcription.status}</p>}
      </div>
    </div>
    <MultitrackTrackActions document={document} target={trackMenu} disabled={transcription.loading} onClose={closeTrackMenu} onRegenerate={(id) => { audio.pause(); setRegenerate(id); }} />
    {regenerate && active && <MultitrackRegenerate owner={trackOwner(document, regenerate)} generated={document.transcripts.some(item => item.track_id === regenerate)} initial={{ engine: transcription.engine, modelId: transcription.modelId, ...transcription.options }} models={transcription.models} parakeetReady={transcription.parakeetReady} onClose={() => setRegenerate(null)} onStart={(choice) => { const id = regenerate; setRegenerate(null); transcription.setOptions({ fast: choice.fast === true, speechOnly: choice.speechOnly === true }); void transcription.start([id], 0, duration, choice); }} />}
    <div className="cp-multitrack-transcript-pane">
      <div className={`cp-multitrack-resize cp-resize-handle vertical${pane.resizing ? " dragging" : ""}`} role="separator" aria-label="Resize track transcripts" aria-orientation="vertical" aria-valuemin={pane.min} aria-valuemax={pane.max} aria-valuenow={pane.width} tabIndex={0} onMouseDown={pane.onMouseDown} onKeyDown={pane.onKeyDown} onDoubleClick={() => pane.setWidth(340)} title="Drag to resize · arrow keys to nudge · Home to reset" />
      <MultitrackTranscript document={document} frame={audio.frame} solo={audio.solo} onSeek={seek} report={transcription.report} error={transcription.error} loading={transcription.loading} active={active} aiModelId={aiModelId} selectedTracks={selected} />
    </div>
    {settingsOpen && active && <MultitrackSettings document={document} waveformErrors={waveformErrors} onBusy={setRelinking} disabled={transcription.loading} onClose={() => onCloseSettings?.()} />}
    {timecodeEntry != null && active && !settingsOpen && <MultitrackTimecodeDialog key={document.id} manifest={document.manifest} initialDigits={timecodeEntry} onClose={closeTimecode} onSeek={(frame) => { void audio.seek(frame, undefined, false); }} />}
  </div>;
}
