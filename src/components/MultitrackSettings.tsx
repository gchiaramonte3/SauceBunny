import { useRef } from "react";
import { createPortal } from "react-dom";
import type { AafDocument } from "../bindings/AafDocument";
import { useModalFocus } from "../hooks/use-modal-focus";
import { MultitrackShootDate } from "./MultitrackShootDate";
import { MultitrackMedia } from "./MultitrackMedia";

export function MultitrackSettings({ document, waveformErrors, onClose, disabled, onBusy }: { document: AafDocument; waveformErrors: Record<string, string>; onClose: () => void; disabled?: boolean; onBusy?: (busy: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null); useModalFocus(true, ref);
  const warnings = [...new Set([...document.manifest.warnings, ...document.manifest.tracks.flatMap((track) => track.warnings), ...document.transcripts.flatMap((track) => track.warnings), ...Object.values(waveformErrors)])];
  return createPortal(<div className="cp-modal-scrim" onMouseDown={onClose}>
    <div ref={ref} className="cp-multitrack-settings" role="dialog" aria-modal="true" aria-label="Multitrack settings" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header><h2>Multitrack settings</h2><button className="btn btn-ghost" aria-label="Close multitrack settings" onClick={onClose}>×</button></header>
      <MultitrackShootDate document={document} />
      <MultitrackMedia document={document} disabled={disabled} onBusy={onBusy} />
      {!!document.manifest.graph?.lanes.some(lane => lane.parent_track_id) && <details><summary>Group microphones</summary><p>Expand a sequence track to reveal alternative microphones. Alternatives begin muted and unchecked. Solo a microphone to hear it alone, or unmute it to include it in the mix. Identical parent and alternative source mappings play only once. Expanding alone does not add voices to playback or transcription.</p><p>Group alternatives retain their source identity when you rename a person. Avid marker export is available only for original sequence lanes.</p></details>}
      <details open><summary>Transcription and audition</summary><p>Generate processes the entire sequence for the checked tracks. Re-running replaces only those tracks’ previous results.</p><p>Solo and Mute affect listening only. Multiple mics can be soloed together. All imported microphone tracks remain available.</p><p>Audition uses raw microphone audio. Avid clip gain is not applied. Multiple enabled mics are averaged to prevent clipping.</p></details>
      <details><summary>Keyboard and timing</summary><p>J / L shuttle backward / forward; repeat to increase speed. K stops. Hold K with J or L to step one frame. Space plays or pauses. Arrow keys step one frame, Shift + arrow steps ten.</p><p>Text overlays use the engine’s transcript segment timing, not verified word-by-word timing. Mic owner labels do not verify who is speaking.</p></details>
      <details><summary>Transcript exports</summary><p>Choose plain text, CSV, Avid markers, SRT captions or PDF / Print. Entire transcript uses the selected format, regardless of the person being viewed. Text, CSV and PDF retain passages needing timing review.</p><p>Avid markers use original sequence timecode, the mic owner's name and the source audio track (A1, A2, and so on). Older imports use the lane numbers shown in Sauce Bunny. Same-frame passages are combined only on the same track. Speech timing is estimated by the transcription engine, not verified word alignment.</p><p>SRT timing starts at sequence zero. Simultaneous voices share captions. Untimed passages are omitted from SRT and Avid markers rather than assigned invented positions.</p><p>Avid files by person saves one file per named owner with timed text, preserving existing files. In Avid, open the matching sequence in the Record Monitor, open the Markers window, then right-click and choose Import Markers. Import the exported .txt file.</p></details>
      <details><summary>Import and timing notes ({warnings.length})</summary>{warnings.length ? <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p>No additional import notes.</p>}</details>
      <footer><button className="btn btn-ghost" onClick={onClose}>Done</button></footer>
    </div>
  </div>, window.document.body);
}
