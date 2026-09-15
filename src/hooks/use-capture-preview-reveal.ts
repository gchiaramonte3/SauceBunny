import { useCallback, useEffect, useRef, useState } from "react";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { NdiLocalProgram } from "../lib/ndi-program-coordinator";
import { copyCaptureSelection, sameProgramSource, type NdiProgramSource } from "../lib/ndi-program-source";

/** Dismiss setup only for the picture explicitly requested in this visit.
 * Receiver startup is not proof of a decoded picture. This observes readiness;
 * it never owns capture or publication. */
export function useCapturePreviewReveal({ open, candidate, busy, error, onReveal }: {
  open: boolean;
  candidate: NdiLocalProgram | null;
  busy: boolean;
  error: string | null;
  onReveal: () => void;
}) {
  const generation = useRef(0);
  const matchedCandidate = useRef<string | null>(null);
  const [request, setRequest] = useState<{ generation: number; source: NdiProgramSource; completed: boolean } | null>(null);
  const invalidate = useCallback(() => { generation.current++; }, []);
  const cancel = useCallback(() => {
    invalidate();
    matchedCandidate.current = null;
    setRequest(null);
  }, [invalidate]);
  useEffect(() => {
    if (!open) cancel();
    return invalidate;
  }, [open, cancel, invalidate]);

  const preview = useCallback(async (selection: ObsSelection, start: () => Promise<void>) => {
    const turn = ++generation.current;
    const source: NdiProgramSource = { kind: "capture", selection: copyCaptureSelection(selection) };
    matchedCandidate.current = candidate && !candidate.retired && !candidate.telemetry.error && candidate.telemetry.phase !== "error"
      && sameProgramSource(source, candidate.source) ? candidate.id : null;
    setRequest({ generation: turn, source, completed: false });
    try {
      await start();
      if (turn === generation.current) setRequest(current => current?.generation === turn ? { ...current, completed: true } : current);
    } catch (cause) {
      if (turn === generation.current) cancel();
      throw cause;
    }
  }, [cancel, candidate]);

  useEffect(() => {
    if (!open || !request || request.generation !== generation.current) return;
    // Bind before startup settles: an obsolete same-source receiver must not
    // close setup because its replacement later became ready.
    if (matchedCandidate.current !== null && matchedCandidate.current !== candidate?.id) { cancel(); return; }
    if (matchedCandidate.current !== null && (error || candidate?.retired || candidate?.telemetry.error
      || candidate?.telemetry.phase === "error")) { cancel(); return; }
    if (candidate && !candidate.retired && !candidate.telemetry.error && candidate.telemetry.phase !== "error"
      && sameProgramSource(request.source, candidate.source)) matchedCandidate.current = candidate.id;
    if (!request.completed || busy) return;
    if (error || !candidate || candidate.retired || candidate.telemetry.error || candidate.telemetry.phase === "error"
      || !sameProgramSource(request.source, candidate.source)) {
      cancel();
      return;
    }
    matchedCandidate.current = candidate.id;
    if (!candidate.decodedReady || !candidate.encodedReady || candidate.telemetry.phase === "off"
      || candidate.telemetry.connectionCount === 0) return;
    cancel();
    onReveal();
  }, [open, request, candidate, busy, error, onReveal, cancel]);

  return { preview, cancel };
}
