import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { parseSrt, groupIntoTurns, fmtTime } from "../lib/srt";
import { loadSpeakerOverrides, resolveSpeakerName, SPEAKERS_CHANGED_EVENT } from "./transcript/helpers";
import { streamChat, type ChatMessage } from "../lib/ai-chat";
import { formatError } from "../lib/error-format";
import { scrollBehavior } from "../lib/motion";
import { Markdown } from "./Markdown";
import { AiChapters } from "./AiChapters";
import type { LlmModel } from "../bindings/LlmModel";
import type { LlmServerInfo } from "../bindings/LlmServerInfo";
import type { DoneEvent } from "../bindings/DoneEvent";
import type { ModelProgressEvent } from "../bindings/ModelProgressEvent";

/** Persisted "summary style" knobs (Settings → AI Summary). */
export type SummaryStyle = {
  /** Output shape the prompt asks for. */
  format: "bullets" | "numbered" | "prose";
  /** Rough length target. */
  length: "brief" | "standard" | "detailed";
};

type Props = {
  /** Path to the active transcript (SRT/VTT). Null when none is loaded. */
  transcriptPath: string | null;
  /** Bumped on every transcript arrival — re-read when the same path is overwritten. */
  reloadToken?: number;
  /** Model id chosen in Settings → AI Summary (persisted). */
  selectedModelId?: string | null;
  /** Output formatting preferences from Settings. */
  style?: SummaryStyle;
  /** Open Settings → AI Summary (manage / switch / download models). */
  onOpenSettings?: () => void;
  /** Seek playback to a timestamp (seconds) — makes summary [m:ss] clickable. */
  onSeek?: (seconds: number) => void;
  /** Auto-chapters: source identity to persist under (App's reviewSourceKey). */
  sourceKey?: string | null;
  /** Auto-chapters: source duration in seconds (clamps model timestamps). */
  durationSec?: number | null;
  /** Auto-chapters: notify the host after a generate/delete — the popped-out
   *  panel forwards this over the panel bus so main's timeline re-reads. */
  onChaptersChanged?: () => void;
};

const SUGGESTIONS = [
  "Summarize this transcript in a few bullet points.",
  "What are the key takeaways, with timestamps?",
  "Pull the most quotable lines (verbatim, with timestamps).",
  "List the main topics covered and when each starts.",
];

const DEFAULT_STYLE: SummaryStyle = { format: "bullets", length: "standard" };

function buildSystemPrompt(transcript: string, truncated: boolean, style: SummaryStyle, hasSpeakers: boolean): string {
  const fmt =
    style.format === "numbered"
      ? '- Structure lists as a numbered list using "1. ", "2. " — one item per line.'
      : style.format === "prose"
        ? "- Write in short, clear paragraphs. Use a list only when the user explicitly asks for one."
        : '- Structure lists as a bulleted list using "- " — one item per line.';
  const len =
    style.length === "brief"
      ? "- Keep it tight: at most ~5 points or ~120 words."
      : style.length === "detailed"
        ? "- Be thorough: cover every significant topic and supporting detail."
        : "- Give a focused summary of the key points.";
  return [
    "You are an assistant analyzing the transcript of a video. Follow these rules:",
    "- Answer ONLY using the transcript below. Never invent facts, names, or numbers.",
    "- When asked for quotes, copy the wording VERBATIM and include the [timestamp].",
    "- When you reference a moment, cite its [timestamp] (e.g. [7:23]).",
    "- If the transcript doesn't cover what's asked, say so plainly.",
    hasSpeakers
      ? "- Speakers are identified in the transcript (each line is prefixed with the speaker's name). Attribute key points, claims, and quotes to the correct speaker by name."
      : "",
    fmt,
    len,
    "- Format in GitHub-flavoured Markdown. Put a blank line between paragraphs and before any list.",
    "- Write plain prose. Do NOT use bold or italics. Never output the * or _ characters for emphasis.",
    "- Use \"## \" headings only to separate major sections of a long answer.",
    truncated
      ? "- NOTE: the transcript was too long for the context window and has been truncated; say so if the answer might depend on the cut portion."
      : "",
    "",
    "Example of the formatting expected:",
    "## Key points",
    "- The host introduces the topic and why it matters [0:42].",
    "- A demo follows, walking through the core workflow [4:10].",
    "",
    "=== TRANSCRIPT ===",
    transcript,
    "=== END TRANSCRIPT ===",
  ].filter(Boolean).join("\n");
}

export function AiSummary({
  transcriptPath, reloadToken, selectedModelId, style, onOpenSettings, onSeek,
  sourceKey, durationSec, onChaptersChanged,
}: Props) {
  // ── Transcript text (timestamped, model-friendly) ────────────────
  const [raw, setRaw] = useState<string | null>(null);
  const loadKey = transcriptPath ? `${transcriptPath}#${reloadToken ?? 0}` : null;
  useEffect(() => {
    if (!transcriptPath) { setRaw(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const text = await invoke<string>("read_text_file_capped", { path: transcriptPath, maxBytes: 8 * 1024 * 1024 });
        if (!cancelled) setRaw(text);
      } catch { if (!cancelled) setRaw(null); }
    })();
    return () => { cancelled = true; };
  }, [transcriptPath, loadKey]);

  // ── Model + server state ─────────────────────────────────────────
  const [models, setModels] = useState<LlmModel[] | null>(null);
  const [server, setServer] = useState<LlmServerInfo | null>(null);
  const [phase, setPhase] = useState<"idle" | "starting" | "ready" | "error">("idle");
  const [phaseMsg, setPhaseMsg] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadPct, setDownloadPct] = useState(0);
  const dlJobRef = useRef<string | null>(null);

  const refreshModels = useCallback(async () => {
    try { setModels(await invoke<LlmModel[]>("list_llm_models")); }
    catch (e) { setPhase("error"); setPhaseMsg(formatError(e)); }
  }, []);

  useEffect(() => {
    refreshModels();
    invoke<LlmServerInfo | null>("llm_server_status").then((s) => {
      if (s) { setServer(s); setPhase("ready"); }
    }).catch(() => { /* not running yet */ });
  }, [refreshModels]);

  // Model download events (shared channel; filter by our job id).
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let mounted = true;
    (async () => {
      unlisteners.push(await listen<ModelProgressEvent>("model-download-progress", (e) => {
        if (mounted && e.payload.job_id === dlJobRef.current) setDownloadPct(e.payload.percent);
      }));
      unlisteners.push(await listen<DoneEvent>("model-download-done", async (e) => {
        if (!mounted || e.payload.job_id !== dlJobRef.current) return;
        dlJobRef.current = null;
        setDownloadingId(null);
        setDownloadPct(0);
        // Await so the models list (and thus activeModel) reflects the new
        // model before the user can start a chat with it.
        if (e.payload.success) await refreshModels();
        else { setPhase("error"); setPhaseMsg(e.payload.error ?? "Download failed"); }
      }));
    })();
    return () => { mounted = false; unlisteners.forEach((u) => u()); };
  }, [refreshModels]);

  const downloaded = useMemo(() => (models ?? []).filter((m) => m.downloaded), [models]);
  const recommended = useMemo(() => (models ?? []).find((m) => m.recommended) ?? (models ?? [])[0], [models]);

  async function startDownload(modelId: string) {
    setPhase("idle"); setPhaseMsg(null);
    setDownloadingId(modelId);
    setDownloadPct(0);
    try {
      const id = await invoke<string>("new_job_id");
      dlJobRef.current = id;
      await invoke("download_llm_model", { args: { model_id: modelId, job_id: id } });
    } catch (e) {
      dlJobRef.current = null;
      setDownloadingId(null);
      setPhase("error"); setPhaseMsg(formatError(e));
    }
  }

  // The model to run: the Settings-chosen one if downloaded, else the
  // recommended/first downloaded as a fallback.
  const activeModel = useMemo(
    () =>
      downloaded.find((m) => m.id === selectedModelId)
      ?? downloaded.find((m) => m.recommended)
      ?? downloaded[0],
    [downloaded, selectedModelId],
  );
  // Track which model the resident server is actually running, so switching the
  // choice in Settings restarts the sidecar onto the new model.
  const serverModelRef = useRef<string | null>(null);

  // Bring the server up for the active model (idempotent backend-side; restarts
  // when the chosen model changed).
  const ensureServer = useCallback(async (): Promise<LlmServerInfo | null> => {
    const model = activeModel;
    if (!model) return null;
    if (server && serverModelRef.current === model.id) return server;
    setPhase("starting");
    setPhaseMsg(`Loading ${model.name} into memory…`);
    try {
      const info = await invoke<LlmServerInfo>("start_llm_server", { modelId: model.id });
      serverModelRef.current = model.id;
      setServer(info); setPhase("ready"); setPhaseMsg(null);
      return info;
    } catch (e) {
      setPhase("error"); setPhaseMsg(formatError(e));
      return null;
    }
  }, [server, activeModel]);

  // ── Chat ─────────────────────────────────────────────────────────
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  // Mutual exclusion with the chapters run, both directions: AiChapters gates
  // on `chatBusy`, and this mirrors its busy state back so the composer can't
  // fire a second request at the single llama-server mid-detection.
  const [chaptersBusy, setChaptersBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Rebuild the model context when speaker names/aliases change — the transcript
  // panel + caption overlay fire SPEAKERS_CHANGED_EVENT on every rename/merge.
  const [speakersTick, setSpeakersTick] = useState(0);
  useEffect(() => {
    const onChange = () => setSpeakersTick((t) => t + 1);
    window.addEventListener(SPEAKERS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SPEAKERS_CHANGED_EVENT, onChange);
  }, []);

  // Built per transcript: timestamped plain text, trimmed to ctx budget. When
  // diarization has run, each line is prefixed with the speaker's RESOLVED
  // display name (the same renames the panel/captions show) so the model can
  // attribute points by name — works for any model.
  const transcriptForModel = useMemo(() => {
    if (!raw) return null;
    let turns;
    try { turns = groupIntoTurns(parseSrt(raw)); } catch { return null; }
    if (!turns.length) return null;
    const overrides = loadSpeakerOverrides(transcriptPath);
    const hasSpeakers = turns.some((t) => !!t.speaker);
    const lines = turns.map((t) => {
      const name = t.speaker ? resolveSpeakerName(t.speaker, overrides) : null;
      const who = name ? `${name}: ` : "";
      return `[${fmtTime(t.start)}] ${who}${t.cues.map((c) => c.text).join(" ")}`;
    });
    const text = lines.join("\n");
    // Budget: ~3.5 chars/token, keep ~65% of ctx for the transcript, rest for chat.
    const ctx = server?.ctx ?? 16384;
    const budget = Math.floor(ctx * 3.5 * 0.65);
    const truncated = text.length > budget;
    let clipped = text;
    if (truncated) {
      clipped = text.slice(0, budget);
      // Don't end on a lone high surrogate (a split emoji / astral char) — it
      // would encode to a replacement char in the request body.
      const last = clipped.charCodeAt(clipped.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) clipped = clipped.slice(0, -1);
    }
    // `lines` is the UNCLIPPED per-turn list — the chapters run windows it
    // itself (sampled evenly across the duration, not head-truncated).
    return { text: clipped, truncated, hasSpeakers, lines };
  }, [raw, server?.ctx, transcriptPath, speakersTick]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: scrollBehavior() });
  }, [messages, streaming]);

  // Reset the conversation when the transcript changes.
  useEffect(() => { setMessages([]); }, [transcriptPath]);

  const send = useCallback(async (text: string) => {
    const content = text.trim();
    if (!content || streaming || chaptersBusy) return;
    setInput("");
    const info = await ensureServer();
    if (!info || !transcriptForModel) return;

    const history: ChatMessage[] = [...messages, { role: "user", content }];
    setMessages([...history, { role: "assistant", content: "" }]);
    setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const payload: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(transcriptForModel.text, transcriptForModel.truncated, style ?? DEFAULT_STYLE, transcriptForModel.hasSpeakers) },
      ...history,
    ];
    try {
      await streamChat(info, payload, (delta) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") next[next.length - 1] = { ...last, content: last.content + delta };
          return next;
        });
      }, ctrl.signal);
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant" && !last.content) next[next.length - 1] = { ...last, content: `⚠️ ${formatError(e)}` };
          return next;
        });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming, chaptersBusy, ensureServer, transcriptForModel, messages]);

  function stop() { abortRef.current?.abort(); setStreaming(false); }

  // If the chosen model changes (in Settings) mid-stream, abort the in-flight
  // run so the next turn starts cleanly on the newly-loaded model.
  useEffect(() => { abortRef.current?.abort(); }, [selectedModelId]);

  // ── Export (Copy / .md / .txt / PDF) — mirrors the transcript menu ─
  const [dlOpen, setDlOpen] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);
  const dlRef = useRef<HTMLDivElement>(null);
  const hasOutput = messages.some((m) => m.role === "assistant" && m.content.trim());

  useEffect(() => {
    if (!dlOpen) return;
    const onDown = (e: MouseEvent) => {
      if (dlRef.current && !dlRef.current.contains(e.target as Node)) setDlOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [dlOpen]);

  // Strip leaked emphasis for the plain-text export (the renderer does this for
  // the on-screen view; .txt has no renderer).
  const deEmphasize = (s: string) =>
    s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*/g, "");
  const buildExportMd = () =>
    messages.filter((m) => m.content.trim())
      .map((m) => `## ${m.role === "user" ? "You" : "AI"}\n\n${m.content.trim()}`)
      .join("\n\n");
  const buildExportTxt = () =>
    messages.filter((m) => m.content.trim())
      .map((m) => `${m.role === "user" ? "You" : "AI"}:\n${deEmphasize(m.content.trim())}`)
      .join("\n\n");

  async function copyAll() {
    setDlOpen(false);
    try { await navigator.clipboard.writeText(buildExportTxt()); } catch { /* ignore */ }
  }
  async function exportAs(format: "md" | "txt") {
    setDlOpen(false);
    try {
      const dest = await saveDialog({
        defaultPath: `summary.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!dest) return;
      const content = format === "md" ? buildExportMd() : buildExportTxt();
      const bytes = Array.from(new TextEncoder().encode(content));
      await invoke("write_bytes_to_path", { path: dest, bytes });
      setDlError(null);
    } catch (e) { setDlError(formatError(e)); }
  }
  function exportPdf() {
    setDlOpen(false);
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
    // Minimal markdown→HTML for the printed page (bullets / numbers / headings /
    // paragraphs); mirrors Markdown.tsx so the PDF reads like the on-screen view.
    const mdToHtml = (src: string) => {
      const lines = src.replace(/\r\n/g, "\n").split("\n");
      const out: string[] = [];
      const inline = (t: string) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*/g, "");
      let i = 0;
      while (i < lines.length) {
        const l = lines[i];
        if (!l.trim()) { i++; continue; }
        const h = /^(#{1,3})\s+(.*)$/.exec(l);
        if (h) { out.push(`<h3>${inline(h[2])}</h3>`); i++; continue; }
        if (/^\s*[-*+]\s+/.test(l)) {
          const items: string[] = [];
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>`); i++; }
          out.push(`<ul>${items.join("")}</ul>`); continue;
        }
        if (/^\s*\d+\.\s+/.test(l)) {
          const items: string[] = [];
          while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`); i++; }
          out.push(`<ol>${items.join("")}</ol>`); continue;
        }
        const para: string[] = [];
        while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s|^\s*[-*+]\s|^\s*\d+\.\s/.test(lines[i])) { para.push(lines[i]); i++; }
        out.push(`<p>${inline(para.join(" "))}</p>`);
      }
      return out.join("\n");
    };
    const body = messages.filter((m) => m.content.trim()).map((m) =>
      `<div class="turn"><div class="role">${m.role === "user" ? "You" : "AI"}</div>${mdToHtml(m.content)}</div>`
    ).join("\n");
    const doc = `<!doctype html>
<html><head><meta charset="utf-8"><title>AI summary</title>
<style>
  @page { margin: 0.75in; }
  body { font: 11pt/1.55 Georgia, serif; color: #111; }
  h1 { font: 600 18pt/1.2 -apple-system, sans-serif; margin: 0 0 18pt; }
  .meta { font: 9pt -apple-system, sans-serif; color: #666; margin-bottom: 24pt; }
  .turn { margin-bottom: 16pt; page-break-inside: avoid; }
  .role { font: 700 9pt -apple-system, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: #888; margin-bottom: 6pt; }
  h3 { font: 600 12pt -apple-system, sans-serif; margin: 10pt 0 4pt; }
  ul, ol { margin: 4pt 0 4pt 18pt; } li { margin: 2pt 0; }
  p { margin: 4pt 0; }
</style></head>
<body><h1>AI summary</h1><div class="meta">Generated by Sauce Bunny</div>${body}</body></html>`;
    const iframe = document.createElement("iframe");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    document.body.appendChild(iframe);
    const w = iframe.contentWindow, d = iframe.contentDocument;
    if (!w || !d) { document.body.removeChild(iframe); return; }
    d.open(); d.write(doc); d.close();
    setTimeout(() => {
      try { w.focus(); w.print(); }
      finally { setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* gone */ } }, 60000); }
    }, 120);
  }

  // ── Render ───────────────────────────────────────────────────────
  if (!transcriptPath) {
    return (
      <div className="cp-ai-empty">
        <IconBrain />
        <div className="cp-ai-empty-title">No transcript yet</div>
        <div className="cp-ai-empty-sub">Generate a transcript first, then chat with it here.</div>
      </div>
    );
  }

  // No model on disk → download card.
  if (models && downloaded.length === 0) {
    const m = recommended;
    return (
      <div className="cp-ai-wrap">
        <div className="cp-ai-setup">
          <IconBrain />
          <div className="cp-ai-empty-title">Set up local AI</div>
          <div className="cp-ai-empty-sub">
            Download a small AI model to summarize and pull quotes from your
            transcripts. Runs entirely on your Mac.
          </div>
          {m && (
            <div className="cp-ai-model-card">
              <div className="cp-ai-model-main">
                <div className="cp-ai-model-name">{m.name}{m.recommended && <span className="cp-ai-rec">Recommended</span>}</div>
                <div className="cp-ai-model-blurb">{m.blurb}</div>
              </div>
              {downloadingId === m.id ? (
                <div className="cp-ai-dl">
                  <div className="cp-ai-dl-bar"><div className="cp-ai-dl-fill" style={{ width: `${downloadPct}%` }} /></div>
                  <div className="cp-ai-dl-pct">{Math.round(downloadPct)}%</div>
                </div>
              ) : (
                <button className="btn btn-primary" onClick={() => startDownload(m.id)}>
                  Download · {(m.size_bytes / 1e9).toFixed(1)} GB
                </button>
              )}
            </div>
          )}
          {/* Other models (e.g. the lighter one) as secondary choices. */}
          {(models ?? []).filter((x) => !x.recommended).map((x) => (
            <button
              key={x.id}
              className="cp-ai-model-alt"
              disabled={!!downloadingId}
              onClick={() => startDownload(x.id)}
            >
              {downloadingId === x.id ? `Downloading ${Math.round(downloadPct)}%…` : `or ${x.name} · ${(x.size_bytes / 1e9).toFixed(1)} GB`}
            </button>
          ))}
          {phase === "error" && phaseMsg && <div className="cp-ai-error">{phaseMsg}</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="cp-ai-wrap">
      <div className="cp-ai-bar">
        <button
          className="cp-ai-model-pick"
          onClick={onOpenSettings}
          title="Choose or download the summarization model in Settings → AI Summary"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>{activeModel?.name ?? "AI model"}</span>
        </button>
        {hasOutput && (
          <div className="cp-ai-export" ref={dlRef}>
            <button className="btn btn-ghost cp-ai-export-btn" onClick={() => setDlOpen((p) => !p)} title="Export this summary">
              Export
              <svg className={"cp-ai-caret" + (dlOpen ? " open" : "")} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {dlOpen && (
              <div className="cp-ai-export-menu" role="menu">
                <button role="menuitem" onClick={copyAll}>Copy to clipboard</button>
                <div className="cp-ai-export-sep" />
                <button role="menuitem" onClick={() => exportAs("md")}>Save as .md</button>
                <button role="menuitem" onClick={() => exportAs("txt")}>Save as .txt</button>
                <button role="menuitem" onClick={exportPdf}>Print / Save as PDF…</button>
              </div>
            )}
          </div>
        )}
      </div>
      {dlError && <div className="cp-ai-error" role="alert">Save failed: {dlError}</div>}
      {/* Auto-chapters — detect with the same local model, list under the
          action (click → seek, × → delete), copy as YouTube chapter text.
          Persists per source; the Timeline draws these as top-edge ticks. */}
      <AiChapters
        sourceKey={sourceKey ?? null}
        durationSec={durationSec ?? null}
        lines={transcriptForModel?.lines ?? null}
        ensureServer={ensureServer}
        chatBusy={streaming}
        onBusyChange={setChaptersBusy}
        onSeek={onSeek}
        onChaptersChanged={onChaptersChanged}
      />
      <div className="cp-ai-thread" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="cp-ai-intro">
            <IconBrain />
            <div className="cp-ai-empty-title">Chat with this transcript</div>
            <div className="cp-ai-empty-sub">Answers come only from the words in the video, with timestamps.</div>
            <div className="cp-ai-suggest">
              {SUGGESTIONS.map((s, i) => (
                <button key={s} className="cp-ai-chip" style={{ animationDelay: `${i * 40}ms` }} onClick={() => send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`cp-ai-msg ${m.role}`}>
            <div className="cp-ai-msg-role">{m.role === "user" ? "You" : "AI"}</div>
            <div className="cp-ai-msg-body">
              {m.role === "assistant"
                ? (m.content
                    ? <Markdown source={m.content} onSeek={onSeek} />
                    : (streaming && i === messages.length - 1
                        ? <span className="cp-ai-typing"><span /><span /><span /></span>
                        : null))
                : m.content}
            </div>
          </div>
        ))}
        {phase === "starting" && (
          <div className="cp-ai-status">{phaseMsg ?? "Starting…"} <span className="cp-ai-typing"><span /><span /><span /></span></div>
        )}
        {phase === "error" && phaseMsg && <div className="cp-ai-error">{phaseMsg}</div>}
      </div>

      <form
        className="cp-ai-composer"
        onSubmit={(e) => { e.preventDefault(); send(input); }}
      >
        <input
          className="cp-ai-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={chaptersBusy ? "Detecting chapters…" : 'Ask about the transcript… e.g. "pull quotes about pricing"'}
          disabled={streaming || chaptersBusy}
          title={chaptersBusy ? "Detecting chapters. Chat resumes when it finishes" : undefined}
        />
        {streaming ? (
          <button type="button" className="btn btn-ghost" onClick={stop}>Stop</button>
        ) : (
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!input.trim() || chaptersBusy}
            title={chaptersBusy ? "Detecting chapters. Chat resumes when it finishes" : undefined}
          >Send</button>
        )}
      </form>
    </div>
  );
}

function IconBrain() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="cp-ai-icon" aria-hidden>
      <path d="M12 5a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V16a2 2 0 0 0 4 0" />
      <path d="M12 5a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V16a2 2 0 0 1-4 0" />
    </svg>
  );
}
