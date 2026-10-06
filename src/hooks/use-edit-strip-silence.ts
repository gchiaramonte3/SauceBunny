import { pipelineInvoke } from "../lib/pipeline";
import { useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafWaveform } from "../bindings/AafWaveform";
import type { OpenEdit } from "../lib/edit-document";
import type { TimelineWord } from "../lib/edit-model";
import { silentStretches, stripMutes, stripTargets, type LevelWindow, type StripSilenceOptions, type StripTarget } from "../lib/edit-strip-silence";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { sequenceFps } from "../lib/multitrack";
import type { EditChange } from "./use-edit-session";
const invoke = pipelineInvoke("String Outs");

type Options = {
  open: OpenEdit; documents: Map<string, AafDocument>; words: TimelineWord[];
  commit: (label: string, change: (open: OpenEdit) => EditChange, group?: string | null) => Promise<boolean>;
  nameOf: (lane: string) => string;
};
/** What to strip: program In to Out, on these lanes. */
export type StripRequest = { from: number; to: number; lanes: string[]; sourceLanes: Record<string, string[]> };

/** Seconds of a mic read per request: the reader returns 2048 points a read, so about 10 ms each. */
const CHUNK_SECONDS = 20;

/**
 * Strip Silence over the cut: reads each selected mic's levels where the cut
 * plays it (from the waveform it already measured), finds the quiet stretches
 * (edit-strip-silence.ts) and silences them in one undo step. Stop cancels the
 * reads; nothing is changed until every read is in.
 */
export function useEditStripSilence({ open, documents, words, commit, nameOf }: Options) {
  const [busy, setBusy] = useState(false);
  const job = useRef<string | null>(null);
  const read = async (target: StripTarget, jobId: string): Promise<LevelWindow[]> => {
    const source = open.document.sources.find((item) => item.id === target.source);
    const aaf = source ? documents.get(source.id) : undefined, mic = open.document.tracks.find((track) => track.id === target.lane)?.source_tracks[target.source];
    if (!source || !aaf || !mic) return [];
    const rate = sequenceFps(aaf.manifest), windows: LevelWindow[] = [];
    for (let at = target.from; at < target.to - 1e-6; at += CHUNK_SECONDS) {
      if (job.current !== jobId) throw new Error("stopped");
      const startFrame = Math.max(0, Math.floor(at * rate));
      const durationFrames = Math.min(aaf.manifest.duration_frames - startFrame, Math.max(1, Math.ceil(Math.min(target.to, at + CHUNK_SECONDS) * rate) - startFrame));
      if (durationFrames <= 0) break;
      const wave = await invoke<AafWaveform>("aaf_waveform", { documentId: source.document_id, trackId: mic, jobId, startFrame, durationFrames });
      windows.push({ ...target, from: startFrame / rate, to: (startFrame + durationFrames) / rate, peaks: wave.peaks as [number, number][] });
    }
    return windows;
  };
  const run = async (request: StripRequest, options: StripSilenceOptions): Promise<string> => {
    const jobId = newJobId();
    job.current = jobId;
    setBusy(true);
    try {
      const found: StripTarget[] = [];
      for (const target of stripTargets(open.timeline, request.from, request.to, request.lanes, request.sourceLanes)) {
        const own = words.filter((word) => word.source === target.source && word.track === target.lane);
        for (const [a, b] of silentStretches(await read(target, jobId), own, options)) {
          const from = Math.max(a, target.from), to = Math.min(b, target.to);
          if (to > from) found.push({ ...target, from, to });
        }
      }
      if (job.current !== jobId) return "Strip Silence stopped.";
      if (!found.length) return `No stretch under ${options.thresholdDb} dB lasts ${options.minimum} s on those tracks.`;
      await commit("Strip Silence", (state) => ({ timeline: stripMutes(state.timeline, found) }));
      const seconds = found.reduce((sum, item) => sum + item.to - item.from, 0), who = [...new Set(found.map((item) => nameOf(item.lane)))];
      return `Stripped ${found.length} ${found.length === 1 ? "silence" : "silences"}, ${seconds.toFixed(1)} s, on ${who.join(", ")}.`;
    } catch (cause) {
      return job.current === jobId ? `Strip Silence failed: ${formatError(cause)}` : "Strip Silence stopped.";
    } finally {
      if (job.current === jobId) job.current = null;
      setBusy(false);
    }
  };
  const stop = () => {
    const running = job.current;
    job.current = null;
    if (running) void invoke("cancel_job", { jobId: running }).catch(() => undefined);
  };
  return { busy, run, stop };
}
