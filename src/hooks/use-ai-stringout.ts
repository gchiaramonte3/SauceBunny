import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { LlmModel } from "../bindings/LlmModel";
import { loadAiProvider } from "../lib/ai-provider";
import { biteRecords, proposeStringout } from "../lib/edit-ai-stringout";
import { editFromSequence } from "../lib/edit-new";
import { laneBites, type LaneBite } from "../lib/edit-stringout";
import { formatError } from "../lib/error-format";
import { ensureLocalAiServer, selectLocalAiModel } from "../lib/local-ai-server";

export type AiStringout = { document: AafDocument; title: string; bites: LaneBite[]; names: Record<string, string> };

/**
 * One request for a string-out, on the model the user chose (local Qwen by
 * default). The AbortController is armed before the first await, so Stop
 * works during a cold model load as well as during the answer.
 */
export function useAiStringout(modelId?: string | null) {
  const [status, setStatus] = useState<{ busy: boolean; message: string }>({ busy: false, message: "" });
  const [proposal, setProposal] = useState<AiStringout | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); abortRef.current = null; }, []);

  async function ask(documentId: string, request: string) {
    if (!request.trim() || abortRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const live = () => !ctrl.signal.aborted && abortRef.current === ctrl;
    setProposal(null);
    setStatus({ busy: true, message: "Reading the sequence…" });
    try {
      const document = await invoke<AafDocument>("aaf_open", { documentId });
      const bites = laneBites(document);
      if (!bites.length) throw new Error("Nobody in this sequence has a transcript yet. Transcribe it in AAF Audio first.");
      const names = Object.fromEntries(editFromSequence(document, "", false).tracks.map((track) => [track.id, track.name]));
      const provider = loadAiProvider();
      let model: Parameters<typeof proposeStringout>[2];
      if (provider === "local") {
        if (!live()) return;
        setStatus({ busy: true, message: "Loading local AI…" });
        const chosen = selectLocalAiModel(await invoke<LlmModel[]>("list_llm_models"), modelId);
        if (!chosen) throw new Error("No local AI model is installed. Download one in Settings → AI Summary.");
        model = { kind: "local", server: await ensureLocalAiServer(chosen.id, ctrl.signal) };
      } else model = { kind: "cloud", provider, ctx: 32000 };
      if (!live()) return;
      setStatus({ busy: true, message: `Choosing from ${bites.length} bites…` });
      const answer = await proposeStringout(biteRecords(bites, (lane) => names[lane] ?? lane), request, model, ctrl.signal);
      if (!live()) return;
      setProposal({ document, title: answer.title, bites: answer.bites.map((id) => bites[id]), names });
      setStatus({ busy: false, message: answer.bites.length ? "" : "The model found nothing that fits. Try asking differently." });
    } catch (cause) {
      if (live()) setStatus({ busy: false, message: formatError(cause) });
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  }
  function stop() { abortRef.current?.abort(); abortRef.current = null; setStatus({ busy: false, message: "Stopped." }); }
  return { ...status, proposal, ask, stop, discard: () => setProposal(null) };
}
