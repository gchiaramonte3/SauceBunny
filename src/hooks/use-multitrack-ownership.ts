import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafOwnership } from "../bindings/AafOwnership";
import type { AafOwnershipLabel } from "../bindings/AafOwnershipLabel";
import { newJobId } from "../lib/job-id";
import { formatError } from "../lib/error-format";
import { ownershipIndex } from "../lib/multitrack-ownership";

/**
 * The bleed resolver for one AAF Audio document (accuracy spec, phase 3).
 * Loads labels when what it reads changes (a transcript, or the editor's own
 * call), from Rust's cache when nothing moved. `measure` builds the waveforms
 * of transcribed mics that have none, which reads their media once, so it
 * only runs when asked; its job id is held so Cancel can reach it.
 */
export function useMultitrackOwnership(document: AafDocument, active = true) {
  const [ownership, setOwnership] = useState<AafOwnership | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const [checking, setChecking] = useState(false);
  const voiceJob = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadJob = useRef<string | null>(null);
  const measureJob = useRef<string | null>(null);
  const revision = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async (build: boolean) => {
    const mine = ++revision.current;
    const job = newJobId();
    if (build) { measureJob.current = job; setMeasuring(true); } else loadJob.current = job;
    setError(null);
    try {
      const result = await invoke<AafOwnership>("aaf_ownership", { documentId: document.id, build, jobId: job });
      // A malformed answer is no answer: the reader shows every line, as before.
      const valid = !!result && Array.isArray(result.words) && Array.isArray(result.measured) && Array.isArray(result.missing);
      if (mounted.current && mine === revision.current) setOwnership(valid ? result : null);
    } catch (cause) {
      const message = formatError(cause);
      if (mounted.current && mine === revision.current && !/cancel/i.test(message)) setError(message);
    } finally {
      if (build) { measureJob.current = null; if (mounted.current) setMeasuring(false); }
    }
  }, [document.id]);
  // Keyed on what the resolver reads, not on the document: a label save, a
  // shoot date or a relink checkpoint is a new document with every word where
  // it was, and each one ran the whole pass again (about 600 ms on a 20-mic
  // sequence, and every labelled word sent to the page). The document hook
  // keeps both arrays while their content is unchanged. One pass in flight:
  // showing the panel again while it runs does not start another.
  const { transcripts, ownership: calls } = document;
  const inFlight = useRef<{ transcripts: unknown; calls: unknown } | null>(null);
  useEffect(() => {
    if (!active || !transcripts.length || (inFlight.current?.transcripts === transcripts && inFlight.current.calls === calls)) return;
    const pass = { transcripts, calls };
    inFlight.current = pass;
    void load(false).finally(() => { if (inFlight.current === pass) inFlight.current = null; });
  }, [active, transcripts, calls, load]);
  const cancel = useCallback(() => {
    for (const job of [measureJob.current, voiceJob.current]) if (job) void invoke("cancel_job", { jobId: job }).catch(() => { /* already finished */ });
  }, []);
  // The voice check (phase 4): learns each owner's voice and settles unsure
  // words. Reads short clips of the mics, so it too runs only when asked.
  const checkVoices = useCallback(async () => {
    if (voiceJob.current) return;
    const mine = ++revision.current;
    const job = newJobId();
    voiceJob.current = job;
    setChecking(true); setError(null);
    try {
      const result = await invoke<AafOwnership>("aaf_check_voices", { documentId: document.id, jobId: job });
      if (mounted.current && mine === revision.current && result && Array.isArray(result.words)) setOwnership(result);
    } catch (cause) {
      const message = formatError(cause);
      if (mounted.current && !/cancel/i.test(message)) setError(message);
    } finally { voiceJob.current = null; if (mounted.current) setChecking(false); }
  }, [document.id]);
  // The call is saved into the document, whose change event re-reads it; the
  // new cue calls then load the labels once, above. Loading here as well was
  // a second pass for every call.
  const setCue = useCallback(async (trackId: string, cueId: string, label: AafOwnershipLabel | null, heardOn: string | null) => {
    try { await invoke("aaf_set_cue_ownership", { documentId: document.id, trackId, cueId, label, heardOn }); }
    catch (cause) { if (mounted.current) setError(formatError(cause)); }
  }, [document.id]);
  const index = useMemo(() => ownershipIndex(ownership), [ownership]);
  return { ownership, index, measuring, checking, error, measure: () => load(true), checkVoices, cancel, setCue };
}
