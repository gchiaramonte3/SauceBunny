import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { NdiProgram, NdiState } from "../hooks/use-ndi-input";
import { NdiProgramMonitor, type NdiProgramAudio, type NdiProgramMonitorHandle, type NdiPlaybackRecovery } from "./NdiProgramMonitor";

export type ReviewProgramSurfacesHandle = { retryVisible: () => void };
type Props = {
  program: NdiProgram | null;
  state: NdiState;
  previewProgram: NdiProgram | null;
  previewState: NdiState;
  previewVisible: boolean;
  active: boolean;
  roomAudio: NdiProgramAudio;
  previewAudio: NdiProgramAudio;
  onFrameDecoded?: (id: string) => void;
  onPictureFailed?: (id: string) => void;
  onPreviewFrameDecoded?: (id: string) => void;
  onPreviewPictureFailed?: (id: string) => void;
  onRecoveryChange?: (recovery:NdiPlaybackRecovery|null) => void;
};
type Surface = { key: string; program: NdiProgram; state: NdiState; room: boolean; preview: boolean; painted: boolean; ready: boolean; revision: number };
type Pool = { surfaces: Surface[]; shownKey: string | null; sequence: number };

/** Keep the two owned inputs and, only during handoff, one last-painted input.
 * Keys follow capture identity, with a separate slot only when a stopped room
 * aliases a live private capture. Publication promotes the prepared slot, so
 * it never reconnects that reader or replaces its picture with an empty one. */
function reconcile(previous: Pool, props: Props): Pool {
  const surfaces: Surface[] = [];
  let sequence = previous.sequence;
  const append = (program: NdiProgram, state: NdiState, room: boolean, preview: boolean, old?: Surface) => {
    const next = { program, state, room, preview };
    if (!old) {
      const key = previous.surfaces.some(surface => surface.key === program.id) ? `${program.id}:${++sequence}` : program.id;
      surfaces.push({ key, ...next, painted: false, ready: false, revision: 0 });
      return;
    }
    // A new URL or resumed stopped decoder must prove its replacement frame.
    // Its last painted frame remains a valid visual fallback in the meantime.
    const restarting = old.program.url !== next.program.url || (!!old.program.stopped && !next.program.stopped);
    surfaces.push(old.program === program && old.state === state && old.room === room && old.preview === preview ? old
      : { ...old, ...next, ready: restarting ? false : old.ready });
  };
  if (props.program) {
    const id = props.program.id;
    // Prefer the prepared private decoder when publishing. A stopped room
    // and its still-running private receiver can share a capture ID but must
    // not share a video element: their last pictures have different meanings.
    const old = (!props.program.stopped ? previous.surfaces.find(surface => surface.program.id === id && surface.preview && !surface.program.stopped) : undefined)
      ?? previous.surfaces.find(surface => surface.program.id === id && surface.room)
      ?? previous.surfaces.find(surface => surface.program.id === id);
    const sameLiveCandidate = !props.program.stopped && props.previewProgram?.id === id;
    append(props.program, props.state, true, sameLiveCandidate, old);
  }
  if (props.previewProgram && !surfaces.some(surface => surface.preview)) {
    const old = previous.surfaces.find(surface => surface.program.id === props.previewProgram?.id && surface.preview
      && !surfaces.some(owned => owned.key === surface.key))
      ?? previous.surfaces.find(surface => surface.program.id === props.previewProgram?.id
        && !surfaces.some(owned => owned.key === surface.key));
    append(props.previewProgram, props.previewState, false, true, old);
  }
  const requested = surfaces.find(surface => props.previewVisible && props.previewProgram ? surface.preview : surface.room);
  let shownKey = requested?.painted ? requested.key : requested ? previous.shownKey : null;
  if (shownKey && !surfaces.some(surface => surface.key === shownKey)) {
    const held = previous.surfaces.find(surface => surface.key === shownKey && surface.painted);
    if (held) surfaces.push(held.room || held.preview ? { ...held, room: false, preview: false } : held);
    else shownKey = null;
  }
  if (shownKey === previous.shownKey && surfaces.length === previous.surfaces.length
    && surfaces.every((surface, index) => surface === previous.surfaces[index])) return previous;
  return { surfaces, shownKey, sequence };
}

export const ReviewProgramSurfaces = forwardRef<ReviewProgramSurfacesHandle, Props>(function ReviewProgramSurfaces(props, ref) {
  const [pool, setPool] = useState<Pool>({ surfaces: [], shownKey: null, sequence: 0 });
  const current = reconcile(pool, props);
  // Adjust the owned pool before committing children, so promotion never
  // commits a frame in which the old source's video has been unmounted.
  if (current !== pool) setPool(current);
  const latest = useRef({ props, pool: current }); latest.current = { props, pool: current };
  const monitors = useRef(new Map<string, NdiProgramMonitorHandle>());
  const inspectingPreview = props.previewVisible && !!props.previewProgram;
  const requested = current.surfaces.find(surface => inspectingPreview ? surface.preview : surface.room);
  const requestedKey = requested?.key ?? null;
  useImperativeHandle(ref, () => ({ retryVisible() {
    const { props: now, pool: owned } = latest.current;
    const next = owned.surfaces.find(surface => now.previewVisible && now.previewProgram ? surface.preview : surface.room);
    if (next) monitors.current.get(next.key)?.retry();
  } }), []);
  const decoded = useCallback((key: string, id: string) => {
    const { props: now, pool: owned } = latest.current;
    const target = owned.surfaces.find(surface => surface.key === key);
    if (!target || (!target.room && !target.preview)) return;
    setPool(old => ({ ...old, surfaces: old.surfaces.map(surface => surface.key === key
      ? { ...surface, painted: true, ready: true, revision: surface.revision + 1 } : surface) }));
    if (target.preview) now.onPreviewFrameDecoded?.(id);
  }, []);
  const failed = useCallback((key: string, id: string) => {
    const { props: now, pool: owned } = latest.current;
    const target = owned.surfaces.find(surface => surface.key === key);
    if (!target || (!target.room && !target.preview)) return;
    setPool(old => ({ ...old, surfaces: old.surfaces.map(surface => surface.key === key
      ? { ...surface, ready: false } : surface) }));
    if (target.preview) now.onPreviewPictureFailed?.(id);
    if (target.room) now.onPictureFailed?.(id);
  }, []);
  const announced = useRef<string | null>(null);
  const shown = current.surfaces.find(surface => surface.key === current.shownKey);
  const { program, active, onFrameDecoded } = props;
  useLayoutEffect(() => {
    if (!program) { announced.current = null; return; }
    // Candidate readiness is not room readiness. Announce only after React
    // has made this very same, already-decoded surface the room picture.
    if (!active || inspectingPreview || !shown?.room || shown.program.id !== program.id || !shown.ready) return;
    const stamp = `${shown.key}:${shown.revision}`;
    if (stamp === announced.current) return;
    announced.current = stamp;
    onFrameDecoded?.(shown.program.id);
  }, [program, active, inspectingPreview, onFrameDecoded, shown]);
  return <>{current.surfaces.map(surface => {
    const key = surface.key;
    const visible = props.active && current.shownKey === key;
    const selected = props.active && requestedKey === key;
    return <div key={key} className="cp-review-program-surface" aria-hidden={(!visible && !selected) || undefined}
      style={{ position: "absolute", inset: 0, visibility: visible || selected ? "visible" : "hidden", pointerEvents: visible || selected ? "auto" : "none" }}>
      <NdiProgramMonitor ref={handle => { if (handle) monitors.current.set(key, handle); else monitors.current.delete(key); }}
        program={surface.program} state={surface.state} chrome={false} active={selected} pictureVisible={visible}
        audio={inspectingPreview ? props.previewAudio : props.roomAudio}
        onRecoveryChange={selected ? props.onRecoveryChange : undefined}
        onFrameDecoded={id => decoded(key, id)} onPictureFailed={id => failed(key, id)}/>
    </div>;
  })}</>;
});
