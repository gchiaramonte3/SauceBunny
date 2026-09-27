import { invoke } from "@tauri-apps/api/core";
import type { AafSpeech } from "../bindings/AafSpeech";

/**
 * One AAF Audio track's speech analysis (src-tauri/src/speech.rs): where its
 * mic is open, loud moments no word covers, and word boundaries inside its
 * saved transcript. All positions are 16 kHz samples, like transcript cues.
 * The job id is minted by the caller and kept, so the build can be cancelled.
 */
export function loadSpeech(documentId: string, trackId: string, jobId: string): Promise<AafSpeech> {
  return invoke<AafSpeech>("aaf_speech", { documentId, trackId, jobId });
}
