import type { FrameStore } from "../lib/frame-store";
import { useEffect, useRef } from "react";
import type { EditHead } from "../bindings/EditHead";
import type { EditHistory } from "../bindings/EditHistory";
import { msText, pipelineLog, setPipelineContext } from "../lib/pipeline";
import type { EditSourceData } from "./use-edit-sources";

const STAGE = "String Outs";
/** Playback waiting this long for its audio is worth a row. */
const AUDIO_WAIT_MS = 3_000;

export type EditPipelineState = {
  editId: string; head: EditHead; history: EditHistory | null; data: EditSourceData; waveforms: boolean; inSource: boolean;
  playback: { frames: FrameStore; rate: number; busy: boolean; error: string | null };
};

const short = (id: string) => id.slice(0, 8);
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * What the open string out is doing, in counts and ids, for the Pipeline's
 * export. Never a title, a person's name or a word of transcript: those are
 * the editor's material, and an id is enough to match a row to the backend's.
 */
export function describeStringOut(state: EditPipelineState): string {
  const { editId, head, history, data, playback } = state;
  const document = head.document;
  const sound = document.tracks.filter((track) => track.kind === "sound").length;
  const lanes = new Set(data.words.map((word) => `${word.source}:${word.track}`)).size;
  return [
    `String out ${short(editId)} · history state ${head.state} of ${history?.states.length ?? "?"} · ${state.inSource ? "Source" : "Record"} side showing`,
    `Sources: ${document.sources.length}${document.sources.length ? ` (${document.sources.map((source) => `AAF Audio ${short(source.document_id)}${data.documents.has(source.id) ? "" : " NOT LOADED"}`).join(", ")})` : ""}`,
    `Tracks: ${sound} sound, ${document.tracks.length - sound} other`,
    `Record: ${count(document.segments.length, "clip")}, ${count(document.mutes.length, "mute")}, ${count(document.markers.length, "marker")}`,
    `Words: ${count(data.words.length, "word")} on ${count(lanes, "mic")} · ${data.loading ? `READING ${data.read ? `${data.read.done} of ${data.read.total}` : ""}`.trim() : "read"} · speech measured: ${data.measured ? "yes" : "no"}${data.measuring ? " (measuring now)" : ""}`,
    `Waveforms: ${state.waveforms ? `on, ${data.peaks.size} drawn` : "off"}`,
    `Playback: ${playback.rate ? `playing at ${playback.rate}x` : "stopped"} at frame ${playback.frames.get()}${playback.busy ? " · WAITING FOR AUDIO" : ""}${playback.error ? ` · error: ${playback.error}` : ""}`,
    ...(data.errors.length ? ["Source problems:", ...data.errors.map((error) => `  ${error}`)] : []),
  ].join("\n");
}

/**
 * The open string out's part of the Pipeline: its snapshot for the export,
 * and rows for the moments a hang hides in (reading every mic's words, a
 * source that failed, playback waiting on its audio).
 */
export function useEditPipeline(state: EditPipelineState) {
  const latest = useRef(state);
  latest.current = state;
  const { editId, data, playback } = state;

  useEffect(() => {
    setPipelineContext(STAGE, () => ({ text: describeStringOut(latest.current), documentIds: latest.current.head.document.sources.map((source) => source.document_id) }));
    const document = latest.current.head.document;
    pipelineLog(STAGE, `Opened string out ${short(editId)}: ${count(document.sources.length, "source")}, ${count(document.tracks.length, "track")}, ${count(document.segments.length, "clip")}.`);
    return () => setPipelineContext(STAGE, null);
  }, [editId]);

  const reading = useRef<number | null>(null);
  useEffect(() => {
    if (data.loading && reading.current === null) {
      reading.current = performance.now();
      pipelineLog(STAGE, `Reading every mic's words for ${count(latest.current.head.document.sources.length, "source")}.`);
    } else if (!data.loading && reading.current !== null) {
      const ms = performance.now() - reading.current;
      reading.current = null;
      const { words } = latest.current.data;
      pipelineLog(STAGE, `Read ${count(words.length, "word")} in ${msText(ms)}.`, ms >= 30_000 ? "warn" : "info");
    }
  }, [data.loading]);

  const reported = useRef(new Set<string>());
  useEffect(() => {
    for (const error of data.errors) {
      if (reported.current.has(error)) continue;
      reported.current.add(error);
      pipelineLog(STAGE, `Source problem: ${error}`, "err");
    }
  }, [data.errors]);

  useEffect(() => { if (playback.error) pipelineLog(STAGE, `Playback stopped: ${playback.error}`, "err"); }, [playback.error]);

  useEffect(() => {
    if (!playback.busy) return;
    const started = performance.now();
    let warned = false;
    const timer = window.setTimeout(() => {
      warned = true;
      pipelineLog(STAGE, `Playback has waited ${msText(AUDIO_WAIT_MS)} for its audio at frame ${latest.current.playback.frames.get()}.`, "warn");
    }, AUDIO_WAIT_MS);
    return () => {
      window.clearTimeout(timer);
      if (warned) pipelineLog(STAGE, `Playback's audio arrived after ${msText(performance.now() - started)}.`, "ok");
    };
  }, [playback.busy]);
}
