import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { streamChat, type ChatMessage } from "../lib/ai-chat";
import { parseSrt, groupIntoTurns, fmtTime } from "../lib/srt";
import { loadSpeakerOverrides, resolveSpeakerName } from "./transcript/helpers";
import { formatError } from "../lib/error-format";
import { Markdown } from "./Markdown";
import { IconSparkles, IconSpinnerArc, IconRefresh, IconAlert } from "./Icons";
import { buildSystemPrompt, type SummaryStyle } from "./AiSummary";
import { loadAiProvider, cloudChat, loadCloudModel } from "../lib/ai-provider";
import { loadAnalysis, saveAnalysis, analysisIsStale, type TranscriptAnalysis } from "../lib/transcript-analysis";
import { TRANSCRIPTS_CHANGED_EVENT } from "../lib/transcript-history";
import type { LlmServerInfo } from "../bindings/LlmServerInfo";

const DEFAULT_STYLE: SummaryStyle = { format: "bullets", length: "standard" };

/** Timestamped plain text for the model, speaker-attributed + ctx-budgeted.
 *  A lean twin of AiSummary's transcriptForModel (pure — kept local per the
 *  "duplicate before a 3rd consumer" rule; the two never share stateful logic). */
function buildTranscriptForModel(raw: string, ctx: number, srtPath: string) {
  let turns;
  try { turns = groupIntoTurns(parseSrt(raw)); } catch { return null; }
  if (!turns.length) return null;
  const overrides = loadSpeakerOverrides(srtPath);
  const hasSpeakers = turns.some((t) => !!t.speaker);
  const text = turns.map((t) => {
    const name = t.speaker ? resolveSpeakerName(t.speaker, overrides) : null;
    return `[${fmtTime(t.start)}] ${name ? name + ": " : ""}${t.cues.map((c) => c.text).join(" ")}`;
  }).join("\n");
  const budget = Math.floor(ctx * 3.5 * 0.65);
  const truncated = text.length > budget;
  let clipped = truncated ? text.slice(0, budget) : text;
  const last = clipped.charCodeAt(clipped.length - 1);
  if (truncated && last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
  return { text: clipped, truncated, hasSpeakers };
}

type Props = {
  /** The open transcript's SRT path (the analysis sidecar keys on it). */
  transcriptPath: string | null;
  /** True while the Analysis tab is the shown pane — gates the load. */
  visible: boolean;
  /** Persisted AI-summary model id (Settings ▸ AI Summary). */
  selectedModelId?: string | null;
  style?: SummaryStyle;
  /** Seek playback from a clicked [m:ss] in the rendered analysis. */
  onSeek?: (seconds: number) => void;
  /** Open Settings ▸ AI Summary (to download / pick a model). */
  onOpenSettings?: () => void;
};

/**
 * The reader's saved AI-analysis pane — the Analysis half of the Document ↔
 * Analysis tabs. It reuses the local llama-server (same model the AI Summary
 * tab uses) to generate ONE analysis document, then persists it to the
 * `<base>.analysis.json` sidecar so re-opening the transcript shows it
 * instantly instead of re-running the model. A saved analysis made against an
 * older SRT (edited / re-diarized since) is flagged stale with a Regenerate.
 */
export function ReaderAnalysis({ transcriptPath, visible, selectedModelId, style, onSeek, onOpenSettings }: Props) {
  const [analysis, setAnalysis] = useState<TranscriptAnalysis | null>(null);
  const [stale, setStale] = useState(false);
  const [phase, setPhase] = useState<"loading" | "idle" | "starting" | "generating" | "error">("idle");
  const [stream, setStream] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rawRef = useRef<string | null>(null);
  const sizeRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Load the saved analysis + current SRT (for staleness + generation) when the
  // tab is shown or the transcript changes.
  useEffect(() => {
    if (!visible || !transcriptPath) return;
    let alive = true;
    setPhase("loading"); setError(null); setStream("");
    (async () => {
      const [saved, raw] = await Promise.all([
        loadAnalysis(transcriptPath),
        invoke<string>("read_text_file_capped", { path: transcriptPath, maxBytes: 8 * 1024 * 1024 }).catch(() => null),
      ]);
      if (!alive) return;
      rawRef.current = raw;
      sizeRef.current = raw ? new TextEncoder().encode(raw).length : 0;
      setAnalysis(saved);
      setStale(saved ? analysisIsStale(saved, sizeRef.current, 0) : false);
      setPhase("idle");
    })();
    return () => { alive = false; };
  }, [visible, transcriptPath]);

  const analyze = useCallback(async () => {
    if (!transcriptPath || phase === "generating" || phase === "starting") return;
    const raw = rawRef.current;
    if (!raw) { setError("Couldn't read the transcript."); setPhase("error"); return; }
    setError(null); setStream("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const provider = loadAiProvider();
    const userTurn = "Write a complete analysis of this transcript: a short overview, the key topics with their [timestamps], and any notable quotes or takeaways.";
    try {
      setPhase("starting");
      let full = "";
      let modelUsed: string;
      if (provider === "local") {
        let info = await invoke<LlmServerInfo | null>("llm_server_status");
        if (!info) {
          if (!selectedModelId) {
            setError("No local AI model is set up yet. Open AI settings to download one.");
            setPhase("error"); return;
          }
          info = await invoke<LlmServerInfo>("start_llm_server", { modelId: selectedModelId });
        }
        const built = buildTranscriptForModel(raw, info.ctx, transcriptPath);
        if (!built) { setError("This transcript has no readable content to analyze."); setPhase("error"); return; }
        setPhase("generating");
        const messages: ChatMessage[] = [
          { role: "system", content: buildSystemPrompt(built.text, built.truncated, style ?? DEFAULT_STYLE, built.hasSpeakers) },
          { role: "user", content: userTurn },
        ];
        await streamChat(info, messages, (delta) => { full += delta; setStream((s) => s + delta); }, ctrl.signal);
        modelUsed = info.model_id;
      } else {
        // Cloud provider (Claude / ChatGPT) — one-shot via Rust (non-streaming).
        // A generous budget: cloud contexts are large; this bounds cost, not the model.
        const built = buildTranscriptForModel(raw, 32000, transcriptPath);
        if (!built) { setError("This transcript has no readable content to analyze."); setPhase("error"); return; }
        setPhase("generating");
        const system = buildSystemPrompt(built.text, built.truncated, style ?? DEFAULT_STYLE, built.hasSpeakers);
        full = await cloudChat(provider, system, [{ role: "user", content: userTurn }]);
        if (ctrl.signal.aborted) { setPhase("idle"); return; }
        modelUsed = loadCloudModel(provider);
      }
      const doc: TranscriptAnalysis = {
        schemaVersion: 1,
        model: modelUsed,
        generatedAt: Date.now(),
        style: style ?? DEFAULT_STYLE,
        markdown: full.trim(),
        srtSizeBytes: sizeRef.current,
        srtModifiedMs: 0,
      };
      await saveAnalysis(transcriptPath, doc);
      setAnalysis(doc); setStale(false); setStream(""); setPhase("idle");
      // Re-scan so the row's "Analyzed" chip lights up.
      try { window.dispatchEvent(new CustomEvent(TRANSCRIPTS_CHANGED_EVENT)); } catch { /* non-DOM */ }
    } catch (e) {
      if (ctrl.signal.aborted) { setPhase("idle"); return; }
      setError(formatError(e)); setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }, [transcriptPath, phase, selectedModelId, style]);

  const busy = phase === "starting" || phase === "generating";
  function stop() { abortRef.current?.abort(); }

  if (!transcriptPath) {
    return <div className="cp-analysis-empty"><p>Pick a transcript to analyze.</p></div>;
  }

  return (
    <div className="cp-analysis">
      {busy ? (
        <div className="cp-analysis-run">
          <div className="cp-analysis-runhead">
            <IconSpinnerArc size={14} />
            <span>{phase === "starting" ? "Loading the model…" : "Analyzing the transcript…"}</span>
            <button type="button" className="btn btn-ghost cp-tx-iconbtn" onClick={stop}>Stop</button>
          </div>
          {stream && <div className="cp-analysis-body"><Markdown source={stream} onSeek={onSeek} /></div>}
        </div>
      ) : analysis ? (
        <>
          <div className="cp-analysis-head">
            <span className="cp-analysis-meta">
              {stale ? "Transcript changed since this analysis" : "Saved analysis"}
            </span>
            <button type="button" className="btn btn-ghost cp-tx-iconbtn" onClick={analyze} title="Regenerate the analysis">
              <IconRefresh size={12} /><span>Regenerate</span>
            </button>
          </div>
          {stale && (
            <div className="cp-analysis-stale">
              <IconAlert size={13} />
              <span>This ran against an earlier version of the transcript. Regenerate to refresh it.</span>
            </div>
          )}
          <div className="cp-analysis-body"><Markdown source={analysis.markdown} onSeek={onSeek} /></div>
        </>
      ) : phase === "loading" ? (
        <div className="cp-analysis-empty"><IconSpinnerArc size={18} /></div>
      ) : (
        <div className="cp-analysis-empty">
          <IconSparkles size={22} />
          <p>No analysis yet. Generate a saved AI summary of this transcript: an overview, key topics with timestamps, and notable quotes.</p>
          {error && <p className="cp-analysis-err"><IconAlert size={13} /> {error}</p>}
          <div className="cp-analysis-actions">
            <button type="button" className="btn cp-tx-iconbtn" onClick={analyze}>
              <IconSparkles size={13} /><span>Analyze transcript</span>
            </button>
            {onOpenSettings && (
              <button type="button" className="btn btn-ghost cp-tx-iconbtn" onClick={onOpenSettings}>AI settings…</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
