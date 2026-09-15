import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafTrackTranscript } from "../bindings/AafTrackTranscript";
import { useMultitrackAudition } from "../hooks/use-multitrack-audition";
import { useMultitrackTranscription } from "../hooks/use-multitrack-transcription";
import { useMultitrackKeyboard } from "../hooks/use-multitrack-keyboard";
import { useMultitrackDetail } from "../hooks/use-multitrack-detail";
import { sequenceFps, sequenceTimecode, trackOwner } from "../lib/multitrack";
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

type Props = {
  document: AafDocument; active: boolean; waveforms: Record<string, number[][]>; waveformErrors: Record<string, string>;
  labelStatus: string; onRename: (trackId: string, owner: string, memberId?: string | null, color?: string | null) => void; onTranscript: (transcript: AafTrackTranscript) => void;
  onOpenSettings?: () => void; onJobState?: (running: boolean) => void; settingsOpen?: boolean; onCloseSettings?: () => void;
};
export function MultitrackWorkspace({ document, active, waveforms, waveformErrors, labelStatus, onRename, onTranscript, onOpenSettings, onJobState, settingsOpen, onCloseSettings }: Props) {
  const [selected, setSelected] = useState(() => new Set(document.manifest.tracks.map((track) => track.id)));
  const [showWaveforms, setShowWaveforms] = useState(true);
  const [trackMenu, setTrackMenu] = useState<MultitrackMenuTarget | null>(null), [regenerate, setRegenerate] = useState<string | null>(null);
  const closeTrackMenu = useCallback(() => setTrackMenu(null), []);
  useEffect(() => { if (!active) { setTrackMenu(null); setRegenerate(null); } }, [active]);
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
  const detail = useMultitrackDetail(document, view.start, view.span, active && view.enabled);
  const audio = useMultitrackAudition(document, active);
  const transcription = useMultitrackTranscription(document, onTranscript, active);
  useMultitrackKeyboard(active && !settingsOpen, audio);
  useEffect(() => { onJobState?.(transcription.loading); }, [onJobState, transcription.loading]);
  const duration = document.manifest.duration_frames;
  const seek = (frame: number, trackId?: string) => { void audio.seek(frame, trackId); };
  const toggleTrack = (trackId: string) => setSelected((prior) => { const next = new Set(prior); if (next.has(trackId)) next.delete(trackId); else next.add(trackId); return next; });
  const cannotGenerate = !selected.size || !transcription.ready;
  const transport = <div className="cp-multitrack-transport" aria-label="Multitrack playback controls">
    <div className="cp-multitrack-toolbar-options">
      <button className="btn btn-ghost" aria-pressed={audio.scrubbing} title="Hear short audio excerpts while scrubbing" onClick={() => audio.setScrubbing(!audio.scrubbing)}>Audio scrub</button>
      <button className="btn btn-ghost" aria-pressed={showWaveforms} onClick={() => setShowWaveforms(!showWaveforms)}>Waveforms</button>
    </div>
    <div className="cp-multitrack-transport-center"><span className="cp-tc cp-multitrack-tc">{sequenceTimecode(document.manifest, audio.frame)}</span>
      <button className="cp-transport-btn" aria-label="Go to sequence start" onClick={() => seek(0)}><IconSkipBack /></button>
      <button className="cp-transport-btn" aria-label="Rewind tracks" title="Rewind (J)" onClick={() => audio.shuttle(-1)}><IconRewind /></button>
      <button className="cp-transport-btn play" aria-label={audio.playing || audio.busy ? "Pause audition" : "Play tracks"} onClick={audio.toggle}>{audio.playing || audio.busy ? <IconPause /> : <IconPlay />}</button>
      <button className="cp-transport-btn" aria-label="Fast-forward tracks" title="Fast-forward (L)" onClick={() => audio.shuttle(1)}><IconFastForward /></button>
    </div>
    <div className="cp-multitrack-toolbar-end"><span className="cp-multitrack-note" role="status">{audio.busy ? "Preparing audio…" : audio.rate && audio.rate !== 1 ? `${audio.rate}×` : audio.solo.size ? `${audio.solo.size} soloed` : "All mics"}</span>
      <VolumeControl volume={audio.volume} muted={audio.muted} onVolumeChange={audio.setVolume} onMutedChange={audio.setMuted} /></div>
  </div>;
  return <div ref={workspace} className="cp-multitrack-workspace" style={{ "--multitrack-transcript-width": `${Math.min(pane.width, paneMax)}px` } as CSSProperties}>
    <div className="cp-multitrack-editor">
      <div className="cp-multitrack-editor-content">
      <div className="cp-multitrack-sequence-head"><h2 title={document.manifest.name}>{document.manifest.name}</h2><span className="cp-multitrack-note">{sequenceFps(document.manifest).toFixed(3).replace(/\.?0+$/, "")} fps</span><span className="cp-multitrack-note" role="status">{labelStatus}</span></div>
      <MultitrackCast document={document} active={active} onRename={onRename} />
      <MultitrackTimeline document={document} waveforms={waveforms} waveformErrors={waveformErrors} selected={selected} onSelect={toggleTrack} onRename={onRename} onView={onView} detail={{ ...view, peaks: detail }}
        solo={audio.solo} muted={audio.mute} onSolo={audio.toggleSolo} onMute={audio.toggleMute} levels={audio.levels} onLevel={audio.setTrackLevel} onTrackMenu={(id, x, y) => setTrackMenu({ id, x, y })} frame={audio.frame} onSeek={seek} onScrub={audio.scrub}
        onScrubEnd={(frame, resume) => { void audio.seek(frame, undefined, resume); }} playing={audio.playing} showWaveforms={showWaveforms} transport={transport} />
      {audio.error && <p className="cp-multitrack-error" role="alert">{audio.error}</p>}
      </div>
      <div className="cp-multitrack-generation">
        <div className="cp-multitrack-options"><MultitrackModelPicker choice={{ engine: transcription.engine, modelId: transcription.modelId }} models={transcription.models} disabled={transcription.loading} onChange={(choice) => { transcription.setEngine(choice.engine); transcription.setModelId(choice.modelId); }} />
          <span className="cp-multitrack-note">Entire sequence</span><button className="btn btn-ghost" onClick={() => setSelected(new Set(selected.size === document.manifest.tracks.length ? [] : document.manifest.tracks.map((track) => track.id)))} disabled={transcription.loading}>{selected.size === document.manifest.tracks.length ? "Deselect all" : "Select all"}</button>
          <div className="cp-multitrack-generate-row"><GenerateButton idleLabel={`Generate ${selected.size} ${selected.size === 1 ? "track" : "tracks"}`} loadingLabel={transcription.status || "Preparing…"} loading={transcription.loading} progress={transcription.progress} resolution={transcription.resolution} onResolved={transcription.clearResolution} disabled={cannotGenerate} onClick={() => void transcription.start([...selected], 0, duration)} />
            {transcription.loading && <button className="btn btn-ghost" onClick={transcription.stop}>Stop</button>}</div>
        </div>
        {!transcription.ready && <p className="cp-multitrack-note">An installed model is required. {onOpenSettings && <button className="cp-multitrack-text-button" onClick={onOpenSettings}>Open model settings</button>}</p>}
        {!selected.size && <p className="cp-multitrack-note">Check at least one track to generate.</p>}
        {transcription.status && <p className="cp-multitrack-note" role="status">{transcription.status}</p>}
      </div>
    </div>
    <MultitrackTrackActions document={document} target={trackMenu} disabled={transcription.loading} onClose={closeTrackMenu} onRegenerate={(id) => { audio.pause(); setRegenerate(id); }} />
    {regenerate && active && <MultitrackRegenerate owner={trackOwner(document, regenerate)} initial={{ engine: transcription.engine, modelId: transcription.modelId }} models={transcription.models} parakeetReady={transcription.parakeetReady} onClose={() => setRegenerate(null)} onStart={(choice) => { const id = regenerate; setRegenerate(null); void transcription.start([id], 0, duration, choice); }} />}
    <div className="cp-multitrack-transcript-pane">
      <div className={`cp-multitrack-resize cp-resize-handle vertical${pane.resizing ? " dragging" : ""}`} role="separator" aria-label="Resize track transcripts" aria-orientation="vertical" aria-valuemin={pane.min} aria-valuemax={pane.max} aria-valuenow={pane.width} tabIndex={0} onMouseDown={pane.onMouseDown} onKeyDown={pane.onKeyDown} onDoubleClick={() => pane.setWidth(340)} title="Drag to resize · arrow keys to nudge · Home to reset" />
      <MultitrackTranscript document={document} frame={audio.frame} solo={audio.solo} onSeek={seek} report={transcription.report} error={transcription.error} loading={transcription.loading} />
    </div>
    {settingsOpen && active && <MultitrackSettings document={document} waveformErrors={waveformErrors} onClose={() => onCloseSettings?.()} />}
  </div>;
}
