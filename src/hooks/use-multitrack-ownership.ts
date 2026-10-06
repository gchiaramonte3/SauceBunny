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
 * Loads labels whenever the document changes (a new transcript, or the
 * editor's own call), from Rust's cache when nothing moved. `measure` builds
 * the waveforms of transcribed mics that have none, which reads their media
 * once, so it only runs when asked; its job id is held so Cancel can reach it.
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
  useEffect(() => {
    if (active && document.transcripts.length) void load(false);
  }, [active, document, load]);
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
  const setCue = useCallback(async (trackId: string, cueId: string, label: AafOwnershipLabel | null, heardOn: string | null) => {
    try { await invoke("aaf_set_cue_ownership", { documentId: document.id, trackId, cueId, label, heardOn }); await load(false); }
    catch (cause) { if (mounted.current) setError(formatError(cause)); }
  }, [document.id, load]);
  const index = useMemo(() => ownershipIndex(ownership), [ownership]);
  return { ownership, index, measuring, checking, error, measure: () => load(true), checkVoices, cancel, setCue };
}
