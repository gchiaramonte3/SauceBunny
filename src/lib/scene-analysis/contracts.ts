import type {
  SceneAnalysisConfig,
  SceneAnalysisErrorCode,
  SceneAnalysisProgress,
  SceneAnalysisResult,
} from './mediabunny-scene-analysis.js';

export interface WorkerCapabilities {
  worker: true;
  mediaBunny: true;
  mediaBunnyVersion: '1.52.3';
  videoDecoder: boolean;
  offscreenCanvas: boolean;
  fullFrame: boolean;
}

export type WorkerInboundMessage =
  | { type: 'PROBE'; runId: string }
  | { type: 'START'; runId: string; file: File | Blob | { name: string; size: number; native: true }; config?: Partial<SceneAnalysisConfig> }
  | { type: 'CANCEL'; runId: string }
  | { type: 'RANGE_RESULT'; runId: string; requestId: number; bytes: ArrayBuffer }
  | { type: 'RANGE_ERROR'; runId: string; requestId: number; message: string };

export type WorkerOutboundMessage =
  | { type: 'READ_RANGE'; runId: string; requestId: number; start: number; end: number }
  | { type: 'CAPABILITIES'; runId: string; capabilities: WorkerCapabilities }
  | { type: 'PROGRESS'; runId: string; progress: SceneAnalysisProgress }
  | { type: 'RESULT'; runId: string; result: SceneAnalysisResult }
  | { type: 'CANCELLED'; runId: string }
  | {
    type: 'ERROR';
    runId: string;
    error: { code: SceneAnalysisErrorCode | 'BUSY' | 'INVALID_MESSAGE' | 'UNKNOWN_ERROR'; message: string };
  };
