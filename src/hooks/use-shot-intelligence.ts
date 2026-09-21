import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVideoIntelligence } from "./use-video-intelligence";
import { startSceneAnalysis, type SceneJob } from "../lib/scene-analysis/client";
import { createAudioEvidence, createSceneEvidence, saveSceneEvidence, shotBatches, validateShotAnswers, type AudioEvidence, type SceneEvidence } from "../lib/scene-analysis/evidence";
import { parseSrt } from "../lib/srt";
import { formatError } from "../lib/error-format";
import type { VideoShotAnswer } from "../bindings/VideoShotAnswer";
import type { PictureModelId } from "../lib/picture-model";

const QUESTION = "Describe only what is visibly happening in this supplied shot. No dialogue or audio was supplied for picture analysis. Do not infer speech, music or other sounds, invent cuts, or change shot boundaries.";
type Run = { key: string; stopped: boolean; detector?: SceneJob };
export type ShotAudioState = { status: "not-started" | "analyzing" | "stopped" }
  | { status: "ready"; evidence: AudioEvidence }
  | { status: "unavailable"; error: string };
type State = { key: string; busy: boolean; stopping: boolean; phase: string; progress: number | null;
  evidence: SceneEvidence | null; answers: VideoShotAnswer[]; audio: ShotAudioState; error: string; complete: boolean; modelUsed?: string };
const empty = (key: string): State => ({ key, busy: false, stopping: false, phase: "", progress: null,
  evidence: null, answers: [], audio: { status: "not-started" }, error: "", complete: false });

export function useShotIntelligence(path: string | null, transcriptPath: string | null, sourceKey?: string | null, reloadToken = 0, foregroundBusy = false, modelId: PictureModelId = "qwen3.5-9b-video") {
  const key = JSON.stringify([path, transcriptPath, sourceKey, reloadToken]);
  const currentKey = useRef(key); currentKey.current = key;
  const mounted = useRef(true);
  const active = useRef<Run | null>(null);
  const native = useVideoIntelligence();
  const { run: nativeRun, stop: nativeStop } = native;
  const [state, setState] = useState<State>(() => empty(key));
  const stop = useCallback(() => {
    const job = active.current;
    if (!job) return;
    job.stopped = true;
    job.detector?.cancel(); nativeStop();
    if (mounted.current) setState(value => value.key === job.key ? { ...value, stopping: true } : value);
  }, [nativeStop]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); };
  }, [stop]);
  useEffect(() => {
    if (active.current?.key !== key) stop();
  }, [key, stop]);
  useEffect(() => {
    if (foregroundBusy && active.current && !active.current.stopped) {
      stop();
      setState(value => ({ ...value, error: "Analysis stopped to give playback or transcription priority. Run it again when ready." }));
    }
  }, [foregroundBusy, stop]);

  const start = useCallback(async () => {
    if (!path || foregroundBusy || active.current || !mounted.current) return;
    const job: Run = { key, stopped: false };
    active.current = job; // Own Stop before the first asynchronous operation.
    const current = () => mounted.current && active.current === job && !job.stopped && currentKey.current === job.key;
    const assertCurrent = () => { if (!current()) throw new Error("Analysis cancelled"); };
    const update = (changes: Partial<State>) => { if (current()) setState(value => ({ ...value, ...changes })); };
    setState({ ...empty(key), busy: true, phase: "Preparing analysis video…", modelUsed: modelId });
    try {
      const models = await nativeRun({ operation: "models" });
      assertCurrent();
      if (!models?.models.some(model => model.id === modelId && model.ready)) {
        throw new Error("Download the local video reasoning model in Models before analyzing. No download starts automatically.");
      }
      const musicModelReady = models.models.some(model => model.id === "ast-audioset" && model.ready);
      const prepared = await nativeRun({ operation: "prepare-shot-proxy", path });
      assertCurrent();
      if (!prepared?.scene_proxy) throw new Error("Could not prepare the analysis video. See the video runtime status below.");
      const proxy = prepared.scene_proxy;
      update({ phase: "Detecting shots…", progress: 0 });
      job.detector = startSceneAnalysis(proxy.path, progress => update({ progress: progress.progress * 100 }));
      const detection = await job.detector.result;
      job.detector = undefined;
      assertCurrent();
      update({ phase: "Checking source and transcript…", progress: null });
      const inspected = await nativeRun({ operation: "inspect-video", path });
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
      update({ evidence, phase: `Describing 0 of ${evidence.shots.length} shots…`, progress: 0 });
      const answers: VideoShotAnswer[] = [];
      for (const shots of shotBatches(evidence)) {
        assertCurrent();
        const response = await nativeRun({ operation: "analyze-shots", model_id: modelId, path, source_sha256: proxy.source.sha256,
          analysis_id: evidence.id, query: QUESTION, shots });
        assertCurrent();
        if (!response?.shot_analysis) throw new Error("Shot descriptions did not finish. The detected shots remain available.");
        validateShotAnswers(evidence, shots, response.shot_analysis);
        if (response.shot_analysis.model_id !== modelId) throw new Error("The worker used a different picture model. Run the analysis again.");
        answers.push(...response.shot_analysis.shots);
        update({ answers: [...answers], phase: `Described ${answers.length} of ${evidence.shots.length} shots`,
          progress: answers.length / evidence.shots.length * 100 });
      }
      // Sound is read from the verified original, never inferred from image
      // descriptions or the transcript. It is optional: retain useful visual
      // results if this decoder/classifier cannot analyze the source.
      update({ audio: { status: "analyzing" }, phase: "Analyzing source audio…", progress: null });
      try {
        const response = await nativeRun({ operation: musicModelReady ? "analyze-music" : "analyze-audio", path: proxy.source.path,
          source_sha256: proxy.source.sha256, analysis_id: evidence.id,
          origin_us: proxy.source.origin_us, duration_us: proxy.source.duration_us, audio_track_index: 0 });
        assertCurrent();
        const audio = musicModelReady ? response?.music_analysis : response?.audio_analysis;
        update({ audio: audio
          ? { status: "ready", evidence: createAudioEvidence(evidence, audio) }
          : { status: "unavailable", error: "" } });
      } catch (cause) {
        if (current()) update({ audio: { status: "unavailable", error: formatError(cause) } });
      }
      update({ complete: true });
    } catch (cause) {
      if (current()) update({ error: formatError(cause) });
    } finally {
      if (active.current === job) {
        active.current = null;
        if (mounted.current) setState(value => currentKey.current === job.key
          ? { ...value, busy: false, stopping: false,
            audio: value.audio.status === "analyzing" ? { status: "stopped" } : value.audio } : empty(currentKey.current));
      }
    }
  }, [key, path, transcriptPath, nativeRun, foregroundBusy, modelId]);

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
