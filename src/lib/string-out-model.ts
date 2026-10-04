import { invoke } from "@tauri-apps/api/core";
import type { LlmModel } from "../bindings/LlmModel";
import type { LlmServerInfo } from "../bindings/LlmServerInfo";
import { streamChat, type ChatMessage } from "./ai-chat";
import { cloudChat, loadAiProvider, loadCloudModel, serviceTier, type CloudProvider } from "./ai-provider";
import { ensureLocalAiServer, selectLocalAiModel } from "./local-ai-server";

/**
 * The model String Outs talks to. It is String Outs' own choice: picking a
 * model in its Ask panel changes nothing in AI Summary or Analysis, which
 * keep following Settings. Until the user picks, it follows Settings too, so
 * a first run behaves exactly as the rest of the app does.
 *
 * `id: null` means "the local model chosen in Settings ▸ AI Summary", so a
 * later change there still reaches String Outs.
 */
export type StringOutModel = { kind: "local"; id: string | null } | { kind: "cloud"; provider: CloudProvider };

const KEY = "saucebunny.stringOuts.model";

export function loadStringOutModel(): StringOutModel {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<{ kind: string; id: unknown; provider: unknown }>;
      if (value.kind === "local") return { kind: "local", id: typeof value.id === "string" ? value.id : null };
      if (value.kind === "cloud" && (value.provider === "anthropic" || value.provider === "openai")) return { kind: "cloud", provider: value.provider };
    }
  } catch { /* unreadable choice: fall back to Settings */ }
  const provider = loadAiProvider();
  return provider === "local" ? { kind: "local", id: null } : { kind: "cloud", provider };
}

export function saveStringOutModel(model: StringOutModel) {
  try { localStorage.setItem(KEY, JSON.stringify(model)); } catch { /* storage unavailable: the choice lasts this session */ }
}

export const CLOUD_NAMES: Record<CloudProvider, string> = { anthropic: "Claude", openai: "ChatGPT" };

/** A connected model, ready to answer. */
export type AskModel =
  | { kind: "local"; server: LlmServerInfo; name: string }
  | { kind: "cloud"; provider: CloudProvider; ctx: number; name: string };

/**
 * Connect to the chosen model. A local model loads (and can be stopped by
 * the signal while it does); a cloud model needs nothing up front, since its
 * key already sits in the Keychain.
 */
export async function connectModel(choice: StringOutModel, appLocalModelId: string | null | undefined, signal: AbortSignal): Promise<AskModel> {
  if (choice.kind === "cloud") return { kind: "cloud", provider: choice.provider, ctx: 32000, name: `${CLOUD_NAMES[choice.provider]} · ${loadCloudModel(choice.provider)}${serviceTier(choice.provider) ? " · Ultrafast" : ""}` };
  const models = await invoke<LlmModel[]>("list_llm_models");
  signal.throwIfAborted();
  const chosen = selectLocalAiModel(models, choice.id ?? appLocalModelId);
  if (!chosen) throw new Error("No local AI model is installed. Download one in Settings → AI Summary, or choose Claude or ChatGPT.");
  return { kind: "local", server: await ensureLocalAiServer(chosen.id, signal), name: chosen.name };
}

export const contextOf = (model: AskModel) => model.kind === "local" ? model.server.ctx : model.ctx;

/** One answer from either kind of model, with the transcript as the system prefix. */
export function chat(model: AskModel, system: string, messages: ChatMessage[], signal: AbortSignal, maxTokens = 1200): Promise<string> {
  return model.kind === "local"
    ? streamChat(model.server, [{ role: "system", content: system }, ...messages], () => undefined, signal, { temperature: 0, maxTokens })
    : cloudChat(model.provider, system, messages, signal, 0);
}
