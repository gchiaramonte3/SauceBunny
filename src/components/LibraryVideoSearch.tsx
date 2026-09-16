import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { VideoSource } from "../bindings/VideoSource";
import type { VideoHit } from "../bindings/VideoHit";
import type { VideoAnswer } from "../bindings/VideoAnswer";
import { useVideoIntelligence } from "../hooks/use-video-intelligence";
import { pathKey } from "../lib/repath";
import { findForSource } from "../lib/transcript-history";
import { fmtTime, parseSrt } from "../lib/srt";
import { formatError } from "../lib/error-format";
import "../styles/video-intelligence.css";

const phases: Record<string, string> = { "loading-model": "Loading local model…", inspecting: "Checking videos…",
  indexing: "Indexing moments…", searching: "Finding moments…", ranking: "Refining matches…", analyzing: "Describing moment…" };

export function LibraryVideoSearch({ paths, scopeLabel, onOpenMoment, onSettings }: {
  paths: readonly string[]; scopeLabel: string;
  onOpenMoment: (path: string, seconds: number) => void; onSettings: () => void;
}) {
  const [sources, setSources] = useState<VideoSource[]>([]);
  const [query, setQuery] = useState("");
  const [rerank, setRerank] = useState(false);
  const [hits, setHits] = useState<VideoHit[]>([]);
  const [answers, setAnswers] = useState<VideoAnswer[]>([]);
  const [note, setNote] = useState("");
  const [readingContext, setReadingContext] = useState(false);
  const [forgetArmed, setForgetArmed] = useState(false);
  const generation = useRef(0);
  const contextPending = useRef(false);
  const { run, stop, busy, progress, error } = useVideoIntelligence();
  const working = busy || readingContext;
  const signature = paths.map(pathKey).sort().join("\n");
  const scope = useMemo(() => {
    const selected = new Set(signature.split("\n"));
    return sources.filter((source) => selected.has(pathKey(source.path)) && source.available);
  }, [signature, sources]);
  useEffect(() => {
    let current = true;
    const lifecycle = generation;
    // Microtask avoids a StrictMode probe starting and cancelling a native job.
    void Promise.resolve().then(async () => {
      if (!current) return;
      const result = await run({ operation: "sources" });
      if (current && result) setSources(result.sources);
    });
    return () => { current = false; lifecycle.current++; stop(); };
  }, [run, stop]);
  useEffect(() => {
    generation.current++; contextPending.current = false; stop();
    setReadingContext(false); setHits([]); setAnswers([]); setNote(""); setForgetArmed(false);
  }, [signature, stop]);
  function cancel() {
    generation.current++; contextPending.current = false; setReadingContext(false);
    stop(); setNote("Stopped. Completed index work is kept.");
  }
  async function index() {
    if (working) return;
    const expected = generation.current;
    setNote(""); setHits([]); setAnswers([]);
    const result = await run({ operation: "index", paths: [...paths] });
    if (result && expected === generation.current) { setSources(result.sources); setNote("Index ready."); }
    else {
      // Stop may arrive after a segment committed. Re-read durable checkpoints.
      const refreshed = await run({ operation: "sources" }, true);
      if (refreshed) setSources(refreshed.sources);
    }
  }
  async function search() {
    if (working || !query.trim() || !scope.length) return;
    const expected = generation.current;
    setNote(""); setAnswers([]); setHits([]);
    const result = await run({ operation: "search", query, scope: scope.map((source) => source.key), rerank });
    if (result && expected === generation.current) { setHits(result.hits); setNote(result.hits.length ? "" : "No matching moments in this selection."); }
  }
  async function describe(hit: VideoHit) {
    if (busy || contextPending.current) return;
    const expected = generation.current;
    const question = query;
    contextPending.current = true; setReadingContext(true);
    setNote("");
    const transcripts: Record<string, string> = {};
    const transcript = findForSource({ sourcePath: hit.path });
    if (transcript) {
      try {
        const text = await invoke<string>("read_text_file_capped", { path: transcript.srtPath, maxBytes: 8 * 1024 * 1024 });
        transcripts[String(hit.id)] = parseSrt(text).filter((cue) => cue.start < hit.end && cue.end > hit.start)
          .map((cue) => `[${fmtTime(cue.start)}] ${cue.text}`).join("\n").slice(0, 12000);
      } catch (cause) { if (expected === generation.current) setNote(`Transcript unavailable; using picture only. ${formatError(cause)}`); }
    }
    if (expected !== generation.current) return;
    contextPending.current = false; setReadingContext(false);
    const result = await run({ operation: "reason", query: question.trim() ? `Describe this moment in relation to: ${question}`.slice(0, 1000) : "Describe this moment.", segments: [hit.id], transcripts });
    if (result && expected === generation.current) setAnswers((old) => [...old.filter((answer) => answer.id !== hit.id), ...result.answers]);
  }
  async function forget() {
    if (!forgetArmed) { setForgetArmed(true); return; }
    const expected = generation.current;
    setForgetArmed(false); setHits([]); setAnswers([]);
    for (const source of scope) {
      if (expected !== generation.current) break;
      const result = await run({ operation: "forget", source_key: source.key });
      if (!result) break;
      setSources(result.sources);
    }
  }
  return <section className="cp-video-search" aria-label="Video Intelligence">
    <div className="cp-video-search-row">
      <span className="cp-video-scope">{scopeLabel} · {scope.filter((source) => source.complete).length} indexed{scope.some((source) => !source.complete) ? " · partial work saved" : ""}</span>
      <button type="button" className="btn btn-ghost" onClick={onSettings}>Models…</button>
      <button type="button" className="btn btn-sm" disabled={working || !paths.length} onClick={() => void index()}>Index {paths.length || "selected"} {paths.length === 1 ? "video" : "videos"}</button>
      {!!scope.length && <button type="button" className="btn btn-ghost" disabled={working} title="Remove this selection’s search index. Original videos stay unchanged." onClick={() => void forget()} onKeyDown={(event) => { if (event.key === "Escape") setForgetArmed(false); }}>{forgetArmed ? "Remove index?" : "Remove index"}</button>}
    </div>
    <form className="cp-video-search-row" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <input className="cp-input" aria-label="Describe a video moment" placeholder="Describe a moment…" maxLength={1000} value={query} disabled={working} onChange={(event) => setQuery(event.target.value)} />
      <label className="cp-video-rerank"><input type="checkbox" checked={rerank} disabled={working} onChange={(event) => setRerank(event.target.checked)} />Refine matches</label>
      <button type="submit" className="btn btn-sm" disabled={working || !query.trim() || !scope.length}>Search</button>
      {working && <button type="button" className="btn btn-ghost" onClick={cancel}>Stop</button>}
    </form>
    {busy && <p className="cp-video-note" role="status">{phases[progress?.phase ?? ""] ?? "Working locally…"}{progress?.total ? ` ${progress.completed} / ${progress.total}` : ""}</p>}
    {(note || error) && <p className="cp-video-note" role={error ? "alert" : "status"}>{error || note}</p>}
    {!!hits.length && <ol className="cp-video-hits">{hits.map((hit) => <li key={hit.id}>
      <div className="cp-video-search-row">
        <button type="button" className="btn btn-ghost cp-video-hit" onClick={() => onOpenMoment(hit.path, hit.start)}>
          <span>{hit.path.split("/").pop()}</span><time>{fmtTime(hit.start)} to {fmtTime(hit.end)}</time>
        </button>
        <button type="button" className="btn btn-ghost" disabled={working} onClick={() => void describe(hit)}>Describe</button>
      </div>
      {answers.find((answer) => answer.id === hit.id)?.text && <p className="cp-video-answer">{answers.find((answer) => answer.id === hit.id)?.text}</p>}
    </li>)}</ol>}
  </section>;
}
