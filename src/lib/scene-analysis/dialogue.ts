import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DoneEvent } from "../../bindings/DoneEvent";
import type { TranscriptPreviewEvent } from "../../bindings/TranscriptPreviewEvent";
import type { TranscriptPhaseEvent } from "../../bindings/TranscriptPhaseEvent";
import type { ProgressEvent } from "../../bindings/ProgressEvent";
import type { WhisperModel } from "../../bindings/WhisperModel";
import type { Defaults } from "../../components/SettingsModal";
import { loadJson } from "../storage";
import { newJobId } from "../job-id";
import { sanitizeFilename, truncateUtf8Bytes } from "../filename";
import { recordTranscript } from "../transcript-history";

export type DialogueResult = { raw: string; path: string; warning: string };
export type DialogueJob = { result: Promise<DialogueResult>; cancel: () => void };

/** The existing Clip recognizer, owned by this analysis rather than the Sidebar.
 * Listener registration precedes dispatch. Stop drains the native save boundary:
 * a committed transcript is recorded even if its consumer has navigated away. */
export function startShotDialogue(path: string, duration: number, observer: {
  preview: (raw: string) => void;
  phase: (label: string, percent: number | null) => void;
  note: (message: string) => void;
}): DialogueJob {
  const job = { id: newJobId(), stopped: false, dispatched: false, settled: false };
  const jobId = job.id;
  const cancel = () => {
    job.stopped = true;
    if (job.dispatched && !job.settled) void invoke("cancel_job", { jobId }).catch(() => {});
  };
  const check = () => { if (job.stopped) throw new Error("Dialogue cancelled"); };
  const result = (async () => {
    const unlisten: (() => void)[] = [];
    let previews = Promise.resolve(), phase = "Preparing dialogue…";
    try {
      const defaults = loadJson<Partial<Defaults>>("cp-defaults-v2", {});
      const models = await invoke<WhisperModel[]>("list_whisper_models"); check();
      // Preserve Clip's selected model. Never silently replace it or download weights.
      const modelId = defaults.whisperModel ?? "base.en";
      if (!models.some(model => model.id === modelId && model.downloaded)) {
        throw new Error("Download or select an installed Whisper model in Transcription settings to generate dialogue.");
      }
      const library = defaults.transcriptLibrary || await invoke<string>("default_transcript_library_path"); check();
      const month = new Date();
      const outputDir = `${library}/${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
      await invoke("ensure_dir_exists", { path: outputDir }); check();
      const title = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || "Video";
      const filename = `${truncateUtf8Bytes(sanitizeFilename(title), 100) || "Video"}-dialogue-${jobId}`;
      const expectedPath = `${outputDir}/${filename}.srt`;
      const read = (savedPath: string) => invoke<string>("read_text_file_capped", { path: savedPath, maxBytes: 8 * 1024 * 1024 });
      let finish!: (event: DoneEvent) => void;
      const done = new Promise<DoneEvent>(resolve => { finish = resolve; });
      unlisten.push(await listen<DoneEvent>("transcript-done", ({ payload }) => {
        if (payload.job_id === jobId) finish(payload);
      })); check();
      unlisten.push(await listen<TranscriptPreviewEvent>("transcript-preview", ({ payload }) => {
        if (payload.job_id !== jobId || payload.path !== expectedPath || job.stopped || job.settled) return;
        previews = previews.then(async () => {
          const raw = await read(payload.path);
          if (!job.stopped && !job.settled) observer.preview(raw);
        }).catch(() => {}); // Final committed read remains authoritative.
      })); check();
      unlisten.push(await listen<TranscriptPhaseEvent>("transcript-phase", ({ payload }) => {
        if (payload.job_id !== jobId || job.stopped || job.settled) return;
        const label = payload.phase.startsWith("diarize") ? "Detecting speakers…"
          : payload.phase === "whisper" ? "Transcribing dialogue…" : "Preparing dialogue…";
        if (phase !== label) { phase = label; observer.note(label); }
        observer.phase(label, null);
      })); check();
      unlisten.push(await listen<ProgressEvent>("transcript-progress", ({ payload }) => {
        if (payload.job_id === jobId && !job.stopped && !job.settled && Number.isFinite(payload.percent)) {
          observer.phase(phase, Math.max(0, Math.min(100, payload.percent)));
        }
      })); check();
      observer.note(`Transcribing dialogue with Whisper ${modelId}, fast decoding and local speaker detection.`);
      job.dispatched = true;
      await invoke<string>("transcribe_local_file", { args: {
        input_path: path, output_dir: outputDir, filename,
        model_id: modelId, job_id: jobId, detect_speakers: true,
        expected_speakers: defaults.expectedSpeakers && defaults.expectedSpeakers > 0 ? defaults.expectedSpeakers : null,
        engine: "whisper", language: defaults.transcriptionLanguage ?? "auto", speed: "fast",
        duration_seconds: duration, local_only: true,
      } });
      const saved = await done;
      job.settled = true;
      await previews;
      if (!saved.success || saved.path !== expectedPath) throw new Error(saved.error || "Dialogue was not saved.");
      // Recording a committed file is independent from showing it in a live panel.
      recordTranscript({ srtPath: saved.path, sourcePath: path, title, origin: "whisper" });
      const raw = await read(saved.path);
      check();
      return { raw, path: saved.path, warning: saved.error ?? "" };
    } finally {
      job.settled = true;
      unlisten.forEach(off => off());
    }
  })();
  return { result, cancel };
}
