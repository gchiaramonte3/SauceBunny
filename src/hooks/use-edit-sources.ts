import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafSpeech } from "../bindings/AafSpeech";
import type { AafWaveform } from "../bindings/AafWaveform";
import type { EditDocument } from "../bindings/EditDocument";
import { audibleSpans, toSeconds, wordsFromSpeech } from "../lib/edit-document";
import type { TimelineWord } from "../lib/edit-model";
import { loadSpeech } from "../lib/edit-speech";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";

export type EditSourceData = {
  documents: Map<string, AafDocument>;
  /** Every analysed word, in edit source/lane ids and source seconds. */
  words: TimelineWord[];
  /** Per source: where ANY of its mics is audible, in source seconds. */
  audible: Map<string, [number, number][]>;
  /** Per `source:lane`: the mic's overview peaks, for clip waveforms. */
  peaks: Map<string, [number, number][]>;
  durations: Record<string, number>;
  loading: boolean;
  errors: string[];
};

type Loaded = { documents: Map<string, AafDocument>; speech: Map<string, AafSpeech>; peaks: Map<string, [number, number][]>; errors: string[] };

/**
 * Everything the editor reads from its sources: each AAF Audio sequence, and
 * for each lane's mic its analysed words (aaf_speech) and waveform overview.
 * Loads when the edit's sources or lane mapping change, never on an edit step.
 * Every backend job holds its id from the start, and leaving cancels them.
 */
export function useEditSources(document: EditDocument | null): EditSourceData {
  const [loaded, setLoaded] = useState<Loaded>({ documents: new Map(), speech: new Map(), peaks: new Map(), errors: [] });
  const [loading, setLoading] = useState(false);
  // One lane loads at a time, so at most one speech job and one waveform job
  // are ever in flight; these hold them for the cleanup's cancel.
  const speechJob = useRef<string | null>(null), waveJob = useRef<string | null>(null);
  const key = document ? JSON.stringify([document.sources, document.tracks.map((track) => track.source_tracks)]) : "";

  useEffect(() => {
    if (!document) return;
    let live = true;
    setLoading(true);
    void (async () => {
      const next: Loaded = { documents: new Map(), speech: new Map(), peaks: new Map(), errors: [] };
      for (const source of document.sources) {
        try {
          const aaf = await invoke<AafDocument>("aaf_open", { documentId: source.document_id });
          if (!live) return;
          next.documents.set(source.id, aaf);
          for (const lane of document.tracks) {
            const trackId = lane.source_tracks[source.id];
            if (!trackId) continue;
            const speechId = newJobId();
            speechJob.current = speechId;
            const waveId = newJobId();
            waveJob.current = waveId;
            const [speech, wave] = await Promise.allSettled([
              loadSpeech(source.document_id, trackId, speechId),
              invoke<AafWaveform>("aaf_waveform", { documentId: source.document_id, trackId, jobId: waveId, startFrame: null, durationFrames: null }),
            ]);
            speechJob.current = null; waveJob.current = null;
            if (!live) return;
            if (speech.status === "fulfilled") next.speech.set(`${source.id}:${lane.id}`, speech.value);
            else next.errors.push(`${source.name} · ${lane.name}: ${formatError(speech.reason)}`);
            if (wave.status === "fulfilled") next.peaks.set(`${source.id}:${lane.id}`, wave.value.peaks);
          }
        } catch (cause) {
          next.errors.push(`${source.name}: ${formatError(cause)}`);
        }
      }
      if (live) { setLoaded(next); setLoading(false); }
    })();
    return () => {
      live = false;
      for (const held of [speechJob, waveJob]) {
        if (held.current) void invoke("cancel_job", { jobId: held.current }).catch(() => undefined);
        held.current = null;
      }
    };
    // The key captures what matters; `document` itself changes on every step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return useMemo(() => {
    const words: TimelineWord[] = [];
    const audible = new Map<string, [number, number][]>();
    for (const [pair, speech] of loaded.speech) {
      const [source, lane] = pair.split(":");
      words.push(...wordsFromSpeech(speech, source, lane));
      audible.set(source, [...(audible.get(source) ?? []), ...audibleSpans(speech)]);
    }
    const durations: Record<string, number> = {};
    for (const [source, aaf] of loaded.documents) durations[source] = toSeconds(aaf.manifest.duration_frames, aaf.manifest.edit_rate);
    return { documents: loaded.documents, words, audible, peaks: loaded.peaks, durations, loading, errors: loaded.errors };
  }, [loaded, loading]);
}
