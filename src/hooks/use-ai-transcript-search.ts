import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LlmModel } from "../bindings/LlmModel";
import { ensureLocalAiServer, selectLocalAiModel } from "../lib/local-ai-server";
import { searchTranscriptWithAi, type SearchPassage } from "../lib/ai-transcript-search";
import { formatError } from "../lib/error-format";
import { loadAiProvider, loadScanModel } from "../lib/ai-provider";
import type { TranscriptScanResult } from "../bindings/TranscriptScanResult";

/**
 * Where a cloud search looks (docs/ASK-RANGE-SPEC-2026-10-06.md, section 9):
 * the sequence, the people (the person tab), the In and Out as timecode, and
 * how a found line's address names its passage in this list.
 */
export type ScanScope = { sequence: string; people: string[]; from: string | null; to: string | null; keyOf: (address: string) => string | null };

type Result = { phase: "idle" | "loading" | "ready" | "error" | "stopped"; matches: Set<string> | null; message: string };
const idle: Result = { phase: "idle", matches: null, message: "" };

/** Owns one explicit search, never a playback tick or a per-keystroke model job. */
export function useAiTranscriptSearch(passages: SearchPassage[], active: boolean, selectedModelId?: string | null, scope?: ScanScope | null) {
  const [query, setQuery] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [result, setResult] = useState<Result>(idle);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    abortRef.current?.abort(); abortRef.current = null; setResult(idle);
    return () => { abortRef.current?.abort(); abortRef.current = null; };
  }, [passages, active, selectedModelId]);

  function reset() { abortRef.current?.abort(); abortRef.current = null; setResult(idle); }
  function changeQuery(value: string) { reset(); setQuery(value); }
  function changeEnabled(value: boolean) { reset(); setEnabled(value); }
  function stop() {
    abortRef.current?.abort(); abortRef.current = null;
    setResult((prior) => ({ ...prior, phase: "stopped", message: "Search stopped. Results shown may be incomplete." }));
  }
  async function search() {
    if (!enabled || !active || !query.trim() || !passages.length || abortRef.current) return;
    const ctrl = new AbortController(); abortRef.current = ctrl;
    const current = () => !ctrl.signal.aborted && abortRef.current === ctrl;
    // With Claude or ChatGPT chosen in Settings, the scan runs there: chunks at once, only in the range and the person's lines.
    const provider = loadAiProvider();
    if (provider !== "local" && scope) {
      const model = loadScanModel(provider), requestId = crypto.randomUUID();
      const onAbort = () => { void invoke("cloud_chat_cancel", { requestId }).catch(() => { /* already done */ }); };
      ctrl.signal.addEventListener("abort", onAbort, { once: true });
      setResult({ phase: "loading", matches: null, message: `Scanning with ${model}…` });
      try {
        const found = await invoke<TranscriptScanResult>("transcript_scan", { args: { provider, model, sequence: scope.sequence, question: query, people: scope.people,
          from: scope.from, to: scope.to, request_id: requestId } });
        if (!current()) return;
        const matches = new Set(found.hits.map((hit) => scope.keyOf(hit.line)).filter((key): key is string => !!key));
        setResult({ phase: "ready", matches, message: `${matches.size} ${matches.size === 1 ? "matching passage" : "matching passages"} · ${model}${found.failed ? ` · ${found.failed} of ${found.chunks} sections could not be read` : ""}` });
      } catch (error) {
        if (current()) setResult({ phase: "error", matches: null, message: formatError(error) });
      } finally {
        ctrl.signal.removeEventListener("abort", onAbort);
        if (abortRef.current === ctrl) abortRef.current = null;
      }
      return;
    }
    setResult({ phase: "loading", matches: null, message: "Loading local AI…" });
    try {
      const models = await invoke<LlmModel[]>("list_llm_models");
      if (!current()) return;
      const model = selectLocalAiModel(models, selectedModelId);
      if (!model) throw new Error("No local AI model is installed. Download one in Settings → AI Summary, or turn off Search with AI to search text.");
      const server = await ensureLocalAiServer(model.id, ctrl.signal);
      if (!current()) return;
      setResult({ phase: "loading", matches: null, message: "Searching transcript…" });
      const matches = await searchTranscriptWithAi(passages, query, server, ctrl.signal, (partial, completed, total) => {
        if (current()) setResult({ phase: "loading", matches: partial, message: `Searching section ${completed} of ${total}…` });
      });
      if (current()) setResult({ phase: "ready", matches, message: `${matches.size} ${matches.size === 1 ? "matching passage" : "matching passages"} · Local AI` });
    } catch (error) {
      if (current()) setResult((prior) => ({ ...prior, phase: "error", message: `${formatError(error)}${prior.matches ? " Results shown may be incomplete." : ""}` }));
    } finally { if (abortRef.current === ctrl) abortRef.current = null; }
  }
  return { query, enabled, result, changeQuery, changeEnabled, search, stop, busy: result.phase === "loading" };
}
