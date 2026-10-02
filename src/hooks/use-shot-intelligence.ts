import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVideoIntelligence } from "./use-video-intelligence";
import { startSceneAnalysis, type SceneJob } from "../lib/scene-analysis/client";
import { createAudioEvidence, createSceneEvidence, saveSceneEvidence, shotBatches, validateShotAnswers, type AudioEvidence, type SceneEvidence } from "../lib/scene-analysis/evidence";
import { parseSrt } from "../lib/srt";
import { formatError } from "../lib/error-format";
import type { VideoShotAnswer } from "../bindings/VideoShotAnswer";
import type { PictureModelId } from "../lib/picture-model";
import type { VideoRequest } from "../bindings/VideoRequest";
import { createAnalysisPipeline } from "../lib/scene-analysis/pipeline";
import { startShotDialogue, type DialogueJob, type DialogueResult } from "../lib/scene-analysis/dialogue";
import type { VideoShotAnalysis } from "../bindings/VideoShotAnalysis";
import type { Cue } from "../lib/srt";

const QUESTION = "Describe only what is visibly happening in this supplied shot. No dialogue or audio was supplied for picture analysis. Do not infer speech, music or other sounds, invent cuts, or change shot boundaries.";
type Run = { key: string; stopped: boolean; detector?: SceneJob; dialogue?: DialogueJob; trace: ReturnType<typeof createAnalysisPipeline>; stopReason?: string };
export type ShotDialogueState = { status: "not-started" | "analyzing" | "ready" | "unavailable" | "stopped";
  text: Record<number, string>; error: string; path?: string };
export type ShotAudioState = { status: "not-started" | "analyzing" | "stopped" }
  | { status: "ready"; evidence: AudioEvidence }
  | { status: "unavailable"; error: string };
type State = { key: string; busy: boolean; stopping: boolean; phase: string; progress: number | null;
  evidence: SceneEvidence | null; answers: VideoShotAnswer[]; audio: ShotAudioState; dialogue: ShotDialogueState; error: string; complete: boolean; modelUsed?: string };
const empty = (key: string): State => ({ key, busy: false, stopping: false, phase: "", progress: null,
  evidence: null, answers: [], audio: { status: "not-started" }, dialogue: { status: "not-started", text: {}, error: "" }, error: "", complete: false });

function dialogueByShot(evidence: SceneEvidence, cues: Cue[]): Record<number, string> {
  return Object.fromEntries(evidence.shots.map(shot => [shot.id, cues
    .filter(cue => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start
      && Math.round(cue.end * 1e6) > shot.start_us && Math.round(cue.start * 1e6) < shot.end_us)
    .map(cue => `${cue.speaker ? `${cue.speaker}: ` : ""}${cue.text}`).join("\n")]));
}

export function useShotIntelligence(path: string | null, transcriptPath: string | null, sourceKey?: string | null, reloadToken = 0, foregroundBusy = false, modelId: PictureModelId = "qwen3.5-9b-video") {
  const key = JSON.stringify([path, transcriptPath, sourceKey, reloadToken]);
  const currentKey = useRef(key); currentKey.current = key;
  const mounted = useRef(true);
  const active = useRef<Run | null>(null);
  const dialogueCache = useRef<{ hash: string; result: DialogueResult } | null>(null);
  const native = useVideoIntelligence();
  const { run: nativeRun, stop: nativeStop } = native;
  const [state, setState] = useState<State>(() => empty(key));
  const stopWithReason = useCallback((reason: string) => {
    const job = active.current;
    if (!job || job.stopped) return;
    job.stopped = true; job.stopReason = reason; job.trace.stopping(reason);
    job.detector?.cancel(); job.dialogue?.cancel(); nativeStop();
    if (mounted.current) setState(value => value.key === job.key ? { ...value, stopping: true } : value);
  }, [nativeStop]);
  const stop = useCallback(() => stopWithReason("requested by user."), [stopWithReason]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stopWithReason("analysis panel closed."); };
  }, [stopWithReason]);
  useEffect(() => {
    if (active.current?.key !== key) stopWithReason("source or transcript changed.");
  }, [key, stopWithReason]);
  useEffect(() => {
    if (foregroundBusy && active.current && !active.current.stopped) {
      stopWithReason("playback, transcription, or a queue job took priority. Run analysis again when ready.");
      setState(value => ({ ...value, error: "Analysis stopped to give playback or transcription priority. Run it again when ready." }));
    }
  }, [foregroundBusy, stopWithReason]);

  const start = useCallback(async () => {
    if (!path || foregroundBusy || active.current || !mounted.current) return;
    const job: Run = { key, stopped: false, trace: createAnalysisPipeline(path, modelId) };
    active.current = job; // Own Stop before the first asynchronous operation.
    const current = () => mounted.current && active.current === job && !job.stopped && currentKey.current === job.key;
    const assertCurrent = () => { if (!current()) throw new Error("Analysis cancelled"); };
    const update = (changes: Partial<State>) => { if (current()) setState(value => ({ ...value, ...changes })); };
    const run = async (request: VideoRequest, start = 0, total = 0, audio = false, onShot?: (answer: VideoShotAnalysis) => void) => {
      let failure = "";
      const response = await nativeRun(request, false, {
        progress: event => {
          if (!current() || failure) return;
          try {
            if (event.shot_analysis) onShot?.(event.shot_analysis);
            job.trace.native(event, start, total, audio);
          } catch (cause) { failure = formatError(cause); nativeStop(); }
        },
        error: message => { failure = message; },
      });
      if (failure) throw new Error(failure);
      return response;
    };
    let stage = "Checking model installation";
    const stageLog = (message: string) => { stage = message; job.trace.note(message); };
    setState({ ...empty(key), busy: true, phase: "Preparing analysis video…", modelUsed: modelId });
    try {
      stageLog(stage);
      const models = await run({ operation: "models" });
      assertCurrent();
      if (!models?.models.some(model => model.id === modelId && model.ready)) {
        throw new Error("Download the local video reasoning model in Models before analyzing. No download starts automatically.");
      }
      const musicModelReady = models.models.some(model => model.id === "ast-audioset" && model.ready);
      stageLog("Preparing or reusing the H.264 analysis copy; the original is unchanged.");
      const prepared = await run({ operation: "prepare-shot-proxy", path });
      assertCurrent();
      if (!prepared?.scene_proxy) throw new Error("Could not prepare the analysis video. See the video runtime status below.");
      const proxy = prepared.scene_proxy;
      job.trace.note(`Analysis copy ready · ${proxy.frame_count} frames · ${(proxy.source.duration_us / 1_000_000).toFixed(2)}s; source timing verified.`, "ok");
      update({ phase: "Detecting shots…", progress: 0 });
      stageLog("Detecting shot boundaries…");
      job.detector = startSceneAnalysis(proxy.path, progress => {
        if (current()) { update({ progress: progress.progress * 100 }); job.trace.detector(progress.progress); }
      });
      const detection = await job.detector.result;
      job.detector = undefined;
      assertCurrent();
      job.trace.note(`Detected ${detection.boundaries.length} cuts.`, "ok");
      update({ phase: "Checking source and transcript…", progress: null });
      stageLog("Checking source identity and supplied transcript…");
      const inspected = await run({ operation: "inspect-video", path });
      assertCurrent();
      if (inspected?.analysis_source?.sha256 !== proxy.source.sha256
        || inspected.analysis_source.duration_us !== proxy.source.duration_us
        || inspected.analysis_source.origin_us !== proxy.source.origin_us) throw new Error("The source changed. Detect its shots again.");
      const raw = transcriptPath ? await invoke<string>("read_text_file_capped", { path: transcriptPath, maxBytes: 8 * 1024 * 1024 }) : "";
      assertCurrent();
      const evidence = await createSceneEvidence(proxy, detection, parseSrt(raw));
      assertCurrent();
      await saveSceneEvidence(evidence);
      assertCurrent(); // Stop during storage must not adopt an obsolete result.
      job.trace.note(`Saved shot boundaries · ${evidence.shots.length} shots. ${transcriptPath ? "Supplied transcript checked; dialogue stays separate from picture descriptions." : "No transcript supplied; checking local Whisper for dialogue."}`, "ok");
      update({ evidence, phase: `Describing 0 of ${evidence.shots.length} shots…`, progress: 0 });
      let dialogueReady = !!transcriptPath;
      if (transcriptPath) {
        update({ dialogue: { status: "ready", text: {}, error: "", path: transcriptPath } });
      } else {
        update({ dialogue: { status: "analyzing", text: {}, error: "" }, phase: "Preparing dialogue…", progress: null });
        stageLog("Preparing local dialogue before picture inference…");
        try {
          const cached = dialogueCache.current?.hash === proxy.source.sha256 ? dialogueCache.current.result : null;
          if (!cached) job.dialogue = startShotDialogue(path, proxy.source.duration_us / 1e6, {
            preview: text => {
              update({ dialogue: { status: "analyzing", text: dialogueByShot(evidence, parseSrt(text)), error: "" } });
              if (current()) job.trace.note("Whisper dialogue ready; speaker labels pending.", "ok");
            },
            phase: (phase, progress) => update({ phase, progress }),
            note: message => { if (current()) job.trace.note(message); },
          });
          const dialogue = cached ?? await job.dialogue!.result;
          job.dialogue = undefined;
          assertCurrent();
          const checked = await run({ operation: "inspect-video", path });
          assertCurrent();
          if (checked?.analysis_source?.sha256 !== proxy.source.sha256
            || checked.analysis_source.origin_us !== proxy.source.origin_us
            || checked.analysis_source.duration_us !== proxy.source.duration_us) {
            // Never carry dialogue from a changed file into the picture request.
            update({ dialogue: { status: "unavailable", text: {}, error: "The source changed during transcription." } });
            throw new Error("The source changed during transcription. Detect its shots again.");
          }
          dialogueReady = !dialogue.warning;
          dialogueCache.current = dialogueReady ? { hash: proxy.source.sha256, result: dialogue } : null;
          update({ dialogue: { status: "ready", text: dialogueByShot(evidence, parseSrt(dialogue.raw)), path: dialogue.path, error: dialogue.warning } });
          job.trace.note(dialogue.warning || "Dialogue saved and matched to shots; picture inference starts next.", dialogue.warning ? "warn" : "ok");
        } catch (cause) {
          assertCurrent();
          const message = formatError(cause);
          update({ dialogue: { status: "unavailable", text: {}, error: message } });
          if (message.includes("source changed")) throw cause;
          job.trace.note(`Dialogue unavailable: ${message} Picture analysis will continue.`, "warn");
        } finally { job.dialogue = undefined; }
      }
      const answers: VideoShotAnswer[] = [];
      for (const shots of shotBatches(evidence)) {
        assertCurrent();
        const batchStart = answers.length;
        let received = 0;
        update({ phase: `Describing ${batchStart} of ${evidence.shots.length} shots…`, progress: batchStart / evidence.shots.length * 100 });
        stageLog(`Describing shots ${batchStart + 1} through ${batchStart + shots.length} of ${evidence.shots.length}.`);
        const response = await run({ operation: "analyze-shots", model_id: modelId, path, source_sha256: proxy.source.sha256,
          analysis_id: evidence.id, query: QUESTION, shots }, batchStart, evidence.shots.length, false, partial => {
            const expected = shots[received];
            if (!expected || partial.model_id !== modelId) throw new Error("Unexpected live shot result.");
            validateShotAnswers(evidence, [expected], partial);
            received++;
            answers.push(...partial.shots);
            update({ answers: [...answers], phase: `Described ${answers.length} of ${evidence.shots.length} shots`,
              progress: answers.length / evidence.shots.length * 100 });
          });
        assertCurrent();
        if (!response?.shot_analysis) throw new Error("Shot descriptions did not finish. The detected shots remain available.");
        validateShotAnswers(evidence, shots, response.shot_analysis);
        if (response.shot_analysis.model_id !== modelId) throw new Error("The worker used a different picture model. Run the analysis again.");
        if (received && (received !== shots.length || JSON.stringify(answers.slice(batchStart)) !== JSON.stringify(response.shot_analysis.shots))) {
          throw new Error("The final descriptions do not match their live results.");
        }
        if (!received) answers.push(...response.shot_analysis.shots);
        job.trace.note(`Received ${answers.length} of ${evidence.shots.length} shot descriptions.`, "ok");
        update({ answers: [...answers], phase: `Described ${answers.length} of ${evidence.shots.length} shots`,
          progress: answers.length / evidence.shots.length * 100 });
      }
      // Sound is read from the verified original, never inferred from image
      // descriptions or the transcript. It is optional: retain useful visual
      // results if this decoder/classifier cannot analyze the source.
      update({ audio: { status: "analyzing" }, phase: "Analyzing source audio…", progress: null });
      stageLog(`Analyzing original source audio${musicModelReady ? " with the AST sound classifier" : " with measured audio evidence"}…`);
      let audioReady = false;
      try {
        const response = await run({ operation: musicModelReady ? "analyze-music" : "analyze-audio", path: proxy.source.path,
          source_sha256: proxy.source.sha256, analysis_id: evidence.id,
          origin_us: proxy.source.origin_us, duration_us: proxy.source.duration_us, audio_track_index: 0 }, 0, 0, true);
        assertCurrent();
        const audio = musicModelReady ? response?.music_analysis : response?.audio_analysis;
        update({ audio: audio
          ? { status: "ready", evidence: createAudioEvidence(evidence, audio) }
          : { status: "unavailable", error: "" } });
        audioReady = !!audio;
        job.trace.note(audio ? (audio.status === "no-audio" ? "Audio check complete: no audio track." : `Audio analysis complete · ${audio.windows.length} evidence windows.`)
          : "Audio analysis returned no result; picture descriptions remain available.", audio ? "ok" : "warn");
      } catch (cause) {
        if (current()) {
          update({ audio: { status: "unavailable", error: formatError(cause) } });
          job.trace.note(`Audio analysis unavailable: ${formatError(cause)}`, "warn");
        }
      }
      update({ complete: true });
      if (current()) job.trace.finish(`${audioReady && dialogueReady ? "Analysis complete" : "Picture analysis complete; some audio or dialogue results need attention"} · ${answers.length} shot descriptions.`, audioReady && dialogueReady ? "ok" : "warn");
    } catch (cause) {
      if (current()) {
        update({ error: formatError(cause) });
        job.trace.finish(`Analysis failed during ${stage}: ${formatError(cause)}`, "err");
      }
    } finally {
      if (job.stopped) job.trace.finish(`Analysis stopped: ${job.stopReason}`, "warn");
      else job.trace.finish("Analysis ended before completion; the source or panel changed.", "warn");
      if (active.current === job) {
        active.current = null;
        if (mounted.current) setState(value => currentKey.current === job.key
          ? { ...value, busy: false, stopping: false,
            audio: value.audio.status === "analyzing" ? { status: "stopped" } : value.audio,
            dialogue: value.dialogue.status === "analyzing" ? { ...value.dialogue, status: "stopped" } : value.dialogue } : empty(currentKey.current));
      }
    }
  }, [key, path, transcriptPath, nativeRun, nativeStop, foregroundBusy, modelId]);

  // A new source hides the old result in its first render, before effects run.
  const visible = state.key === key ? state : empty(key);
  const nativeError = state.key === key ? native.error : "";
  const audioStage = visible.audio.status !== "not-started";
  const audioProgress = visible.audio.status === "analyzing" && native.progress?.phase === "analyzing-audio"
    && native.progress.total > 0 ? native.progress.completed / native.progress.total * 100 : null;
  return { ...visible, start, stop, progress: audioStage ? audioProgress : visible.progress,
    nativeError: audioStage ? "" : nativeError,
    audioError: audioStage ? (visible.audio.status === "unavailable" ? visible.audio.error : "") || nativeError : "",
    draining: !!active.current && active.current.key !== key };
}
