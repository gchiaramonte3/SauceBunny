// The AI provider the summary/analysis features use. Local Qwen (the
// llama-server) is the default and keeps the app local-first; the user can
// OPT IN to a cloud provider (Claude / ChatGPT) with their own API key.
//
// The key itself never lives here — it's in the macOS Keychain (Rust
// cloud_ai.rs). This module only stores the CHOICE (which provider) + the model
// id per provider in localStorage, and wraps the Keychain + chat commands.

import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "./ai-chat";

export type CloudProvider = "anthropic" | "openai";
export type AiProvider = "local" | CloudProvider;

const PROVIDER_KEY = "saucebunny.ai.provider";
const MODEL_KEY = (p: CloudProvider) => `saucebunny.ai.model.${p}`;

/** Sensible current defaults; the user can override the model id per provider. */
export const DEFAULT_CLOUD_MODEL: Record<CloudProvider, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
};


export function loadAiProvider(): AiProvider {
  try {
    const v = localStorage.getItem(PROVIDER_KEY);
    return v === "anthropic" || v === "openai" ? v : "local";
  } catch { return "local"; }
}

export function setAiProvider(p: AiProvider): void {
  try { localStorage.setItem(PROVIDER_KEY, p); } catch { /* ignore */ }
}

export function loadCloudModel(p: CloudProvider): string {
  try { return localStorage.getItem(MODEL_KEY(p))?.trim() || DEFAULT_CLOUD_MODEL[p]; }
  catch { return DEFAULT_CLOUD_MODEL[p]; }
}

export function setCloudModel(p: CloudProvider, model: string): void {
  try { localStorage.setItem(MODEL_KEY(p), model.trim() || DEFAULT_CLOUD_MODEL[p]); } catch { /* ignore */ }
}

// ── Keychain (Rust) — the key is write/clear/check-only from the frontend ──
export function hasApiKey(p: CloudProvider): Promise<boolean> {
  return invoke<boolean>("has_api_key", { provider: p });
}
export function setApiKey(p: CloudProvider, key: string): Promise<void> {
  return invoke("set_api_key", { provider: p, key });
}
export function deleteApiKey(p: CloudProvider): Promise<void> {
  return invoke("delete_api_key", { provider: p });
}

/** One-shot cloud chat via Rust (reqwest + Keychain key). Returns the full text.
 *  `system` carries the transcript + rules; `messages` are the user/assistant turns.
 *  `signal` aborts the REQUEST, not just the UI: it fires `cloud_chat_cancel`,
 *  which drops the Rust-side reqwest future and closes the connection, so a
 *  stopped run stops the provider generating (and billing) too (r142). */
export async function cloudChat(
  provider: CloudProvider, system: string, messages: ChatMessage[], signal?: AbortSignal,
  /**
   * Sampling temperature for the features that deliberately run near-greedy
   * locally. It reaches OPENAI ONLY: the Anthropic Messages API removed
   * temperature on its current models (Sonnet 5 - this app's default Claude
   * model - Opus 5, Opus 4.7/4.8, Fable), where sending one is a 400. Rust
   * decides that, not the caller; passing it here is always safe.
   */
  temperature?: number,
): Promise<string> {
  const requestId = signal ? crypto.randomUUID() : undefined;
  const onAbort = requestId
    ? () => { void invoke("cloud_chat_cancel", { requestId }).catch(() => { /* already done */ }); }
    : undefined;
  if (signal && onAbort) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await invoke<string>("cloud_chat", {
      args: {
        provider, model: loadCloudModel(provider), system, messages,
        request_id: requestId ?? null,
        temperature: temperature ?? null,
      },
    });
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
