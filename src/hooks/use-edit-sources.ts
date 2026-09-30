import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafSpeech } from "../bindings/AafSpeech";
import type { AafWaveform } from "../bindings/AafWaveform";
import type { EditDocument } from "../bindings/EditDocument";
import { audibleSpans, toSeconds, wordsFromSpeech } from "../lib/edit-document";
import { onTrack } from "../lib/edit-new";
import { alternativeLane } from "../lib/multitrack-graph";
import type { TimelineWord } from "../lib/edit-model";
import { loadSpeech } from "../lib/edit-speech";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";

export type EditSourceData = {
  documents: Map<string, AafDocument>;
  /** Every analysed word, in edit source/lane ids and source seconds. */
  words: TimelineWord[];
  /** Per source: where ANY of its mics on a track is audible, in source seconds. */
  audible: Map<string, [number, number][]>;
  /** Per `source:lane`: the mic's overview peaks, for clip waveforms. */
  peaks: Map<string, [number, number][]>;
  durations: Record<string, number>;
  loading: boolean;
  /** While the words pass runs: mics read so far of all of them (0 of 0 while the sequences are still opening), so a pane can say so rather than look empty. */
  read: { done: number; total: number } | null;
  /** Every mic on a track has a measured waveform, so `audible` is complete. */
  measured: boolean;
  /** Waveforms are being built for lanes that have none. */
  measuring: boolean;
  errors: string[];
};

type Loaded = { documents: Map<string, AafDocument>; speech: Map<string, AafSpeech>; peaks: Map<string, [number, number][]>; errors: string[] };
type Lane = { pair: string; source: string; documentId: string; trackId: string; label: string; frames: number };

/**
 * Every mapped lane of every loaded source, in the order they are shown; with
 * `tracked`, only the mics that are heard: people on a record track, and each
 * sequence's own main tracks, which its Source view shows and plays. A group
 * angle on no track is neither, so its waveform would be built for nothing.
 */
function lanesOf(document: EditDocument, documents: Map<string, AafDocument>, tracked = false): Lane[] {
  return document.sources.flatMap((source) => {
    const aaf = documents.get(source.id);
    if (!aaf) return [];
    const heard = (lane: EditDocument["tracks"][number]) => onTrack(lane) || !alternativeLane(aaf, lane.source_tracks[source.id] ?? "");
    return document.tracks.filter((lane) => !tracked || heard(lane)).flatMap((lane) => {
      const trackId = lane.source_tracks[source.id];
      return trackId ? [{ pair: `${source.id}:${lane.id}`, source: source.id, documentId: source.document_id, trackId,
        label: `${source.name} · ${lane.name}`, frames: aaf.manifest.duration_frames }] : [];
    });
  });
}

/** What the words pass reads: the sources and each person's mics. */
const keyOf = (document: EditDocument | null) => document ? JSON.stringify([document.sources, document.tracks.map((track) => track.source_tracks)]) : "";

/** A lane's overview if it has already been built; never starts a build. */
async function cachedPeaks(lane: Lane, jobId: string): Promise<[number, number][] | null> {
  try {
    // The whole sequence as a range is the overview, and a range request is
    // the one aaf_waveform will not build for.
    const wave = await invoke<AafWaveform>("aaf_waveform", { documentId: lane.documentId, trackId: lane.trackId, jobId, startFrame: 0, durationFrames: lane.frames });
    return wave.peaks as [number, number][];
  } catch { return null; }
}

/**
 * Everything the editor reads from its sources: each AAF Audio sequence, and
 * for each lane's mic its analysed words (aaf_speech) and waveform overview.
 *
 * Words come first and never wait on a waveform. A waveform is built only when
 * `waveforms` is on (View ▸ Waveforms): building one reads every file the mic
 * uses, and measured on NEXIS that was ~115 s a track, one at a time, so a
 * 99-mic sequence used to sit at "Reading each microphone's words…" for about
 * three hours before a single word appeared. Until a lane is measured its words
 * are placed by length and it reports no audible spans, which `measured`
 * says, so nothing reads that silence as a fact.
 *
 * Loads when the edit's sources or lane mapping change, never on an edit step.
 * Every backend job holds its id from the start, and leaving cancels them.
 */
export function useEditSources(document: EditDocument | null, waveforms = false): EditSourceData {
  const [loaded, setLoaded] = useState<Loaded>({ documents: new Map(), speech: new Map(), peaks: new Map(), errors: [] });
  const [loading, setLoading] = useState(false);
  const [read, setRead] = useState<{ done: number; total: number } | null>(null);
  const [measuring, setMeasuring] = useState(false);
  // Bumped each time the words pass lands, so the waveform pass starts from it.
  const [generation, setGeneration] = useState(0);
  const latest = useRef(loaded); latest.current = loaded;
  // Which sources `loaded` describes, so a waveform pass never runs on the
  // previous mapping while the words pass for a new one is still reading.
  const publishedKey = useRef("");
  const documentRef = useRef(document); documentRef.current = document;
  // One lane loads at a time, so at most one speech job and one waveform job
  // are ever in flight per pass; these hold them for the cleanup's cancel.
  const wordsJob = useRef<string | null>(null);
  const measureSpeechJob = useRef<string | null>(null), measureWaveJob = useRef<string | null>(null);
  const key = keyOf(document);
  // Who is on a track changes without changing what is read: a person given
  // a track is measured next, and nobody's words are read again.
  const tracked = document ? document.tracks.filter(onTrack).map((track) => track.id).join("\n") : "";
  // A waveform pass reads who is on a track at every step, so a change mid-pass
  // is picked up without cancelling the build in flight; one that lands after
  // the pass has finished starts another.
  const passing = useRef(false);
  const [rescan, setRescan] = useState(0);
  useEffect(() => { if (waveforms && !passing.current) setRescan((value) => value + 1); }, [tracked, waveforms]);

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
        } catch (cause) {
          next.errors.push(`${source.name}: ${formatError(cause)}`);
        }
      }
      // Words are shown as they arrive, a mic at a time (at most a few times a
      // second, since every publish re-reads every word): on a 20-mic sequence
      // the pane used to say "No transcripts" until the last mic was read.
      const lanes = lanesOf(document, next.documents);
      let shown = 0;
      const publish = (done: number) => { shown = performance.now(); setLoaded({ ...next, speech: new Map(next.speech) }); setRead({ done, total: lanes.length }); };
      publish(0);
      for (const [index, lane] of lanes.entries()) {
        const jobId = newJobId();
        wordsJob.current = jobId;
        try {
          next.speech.set(lane.pair, await loadSpeech(lane.documentId, lane.trackId, false, jobId));
        } catch (cause) {
          if (live) next.errors.push(`${lane.label}: ${formatError(cause)}`);
        } finally { wordsJob.current = null; }
        if (!live) return;
        if (performance.now() - shown > 250) publish(index + 1);
      }
      if (live) { publishedKey.current = key; setLoaded(next); setRead(null); setLoading(false); setGeneration((value) => value + 1); }
    })();
    return () => {
      live = false;
      if (wordsJob.current) void invoke("cancel_job", { jobId: wordsJob.current }).catch(() => undefined);
      wordsJob.current = null;
    };
    // The key captures what matters; `document` itself changes on every step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // With View ▸ Waveforms on: draw what is already built, then build the rest
  // lane by lane, replacing each lane's length-placed words with measured ones
  // as it lands rather than holding everything back for the slowest mic.
  useEffect(() => {
    const document = documentRef.current;
    if (!waveforms || !document || generation === 0 || publishedKey.current !== key) return;
    let live = true;
    passing.current = true;
    setMeasuring(true);
    void (async () => {
      const tried = new Set<string>();
      for (;;) {
        const now = documentRef.current;
        if (!live || !now || keyOf(now) !== key) return;
        const lane = lanesOf(now, latest.current.documents, true).find((item) => !tried.has(item.pair));
        if (!lane) break;
        tried.add(lane.pair);
        const had = latest.current.speech.get(lane.pair);
        const waveId = newJobId();
        measureWaveJob.current = waveId;
        let peaks = latest.current.peaks.get(lane.pair) ?? await cachedPeaks(lane, waveId);
        let speech = had;
        if (!live) return;
        if (!peaks || !had?.measured) {
          const speechId = newJobId();
          measureSpeechJob.current = speechId;
          try {
            speech = await loadSpeech(lane.documentId, lane.trackId, true, speechId);
          } catch (cause) {
            if (live) setLoaded((prior) => ({ ...prior, errors: [...prior.errors, `${lane.label}: ${formatError(cause)}`] }));
          } finally { measureSpeechJob.current = null; }
          if (!live) return;
          const afterId = newJobId();
          measureWaveJob.current = afterId;
          peaks = peaks ?? await cachedPeaks(lane, afterId);
          if (!live) return;
        }
        measureWaveJob.current = null;
        if (speech === had && (!peaks || latest.current.peaks.get(lane.pair) === peaks)) continue;
        setLoaded((prior) => {
          const nextSpeech = new Map(prior.speech), nextPeaks = new Map(prior.peaks);
          if (speech) nextSpeech.set(lane.pair, speech);
          if (peaks) nextPeaks.set(lane.pair, peaks);
          return { ...prior, speech: nextSpeech, peaks: nextPeaks };
        });
      }
      if (live) { passing.current = false; setMeasuring(false); }
    })();
    return () => {
      live = false;
      passing.current = false;
      setMeasuring(false);
      for (const held of [measureSpeechJob, measureWaveJob]) {
        if (held.current) void invoke("cancel_job", { jobId: held.current }).catch(() => undefined);
        held.current = null;
      }
    };
  }, [waveforms, generation, key, rescan]);

  return useMemo(() => {
    const words: TimelineWord[] = [];
    const audible = new Map<string, [number, number][]>();
    const heard = new Set(tracked.split("\n"));
    for (const [pair, speech] of loaded.speech) {
      const [source, lane] = pair.split(":");
      words.push(...wordsFromSpeech(speech, source, lane));
      if (heard.has(lane)) audible.set(source, [...(audible.get(source) ?? []), ...audibleSpans(speech)]);
    }
    // Complete only when every mic on a track has its measured words: not
    // while they are still being read, and not when a sequence or a mic
    // failed to load, whose missing spans would read as silence.
    const document = documentRef.current;
    const measured = !loading && !!document && document.sources.every((source) => loaded.documents.has(source.id))
      && lanesOf(document, loaded.documents, true).every((lane) => loaded.speech.get(lane.pair)?.measured === true);
    const durations: Record<string, number> = {};
    for (const [source, aaf] of loaded.documents) durations[source] = toSeconds(aaf.manifest.duration_frames, aaf.manifest.edit_rate);
    return { documents: loaded.documents, words, audible, peaks: loaded.peaks, durations, loading, read: loading ? read ?? { done: 0, total: 0 } : null, measured, measuring, errors: loaded.errors };
    // `key` and `tracked` say everything the document contributes here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, loading, read, measuring, key, tracked]);
}
