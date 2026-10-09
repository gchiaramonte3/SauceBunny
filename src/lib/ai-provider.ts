// The AI provider the summary/analysis features use. Local Qwen (the
// llama-server) is the default and keeps the app local-first; the user can
// OPT IN to a cloud provider (Claude / ChatGPT) with their own API key.
//
// The key itself never lives here — it's in the macOS Keychain (Rust
// cloud_ai.rs). This module only stores the CHOICE (which provider) + the model
// id per provider in localStorage, and wraps the Keychain + chat commands.

import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage } from "./ai-chat";
import type { CloudModel } from "../bindings/CloudModel";

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

/**
 * The SCAN model: a fast model Ask sends chunks of transcript to in parallel,
 * to find the lines about a topic (docs/ASK-RANGE-SPEC-2026-10-06.md,
 * section 6). Chosen per provider in Settings ▸ AI APIs; until it is, the
 * provider's Ask model does the scanning too.
 */
const SCAN_MODEL_KEY = (p: CloudProvider) => `saucebunny.ai.scanModel.${p}`;

export function loadScanModel(p: CloudProvider): string {
  try { return localStorage.getItem(SCAN_MODEL_KEY(p))?.trim() || loadCloudModel(p); }
  catch { return loadCloudModel(p); }
}

export function setScanModel(p: CloudProvider, model: string): void {
  try {
    if (model.trim()) localStorage.setItem(SCAN_MODEL_KEY(p), model.trim());
    else localStorage.removeItem(SCAN_MODEL_KEY(p));
  } catch { /* storage unavailable: the choice lasts this session */ }
}

/** Every model the saved key can call, from the provider's own list (Rust `cloud_models`): chat models first, newest first. */
export function listCloudModels(p: CloudProvider): Promise<CloudModel[]> {
  return invoke<CloudModel[]>("cloud_models", { provider: p });
}

/**
 * OpenAI's Ultrafast tier: the same model up to about six times faster
 * through the API, at about six times the price per token, offered for
 * gpt-6-astra. Off unless the user turns it on, and it only ever reaches
 * requests to OpenAI. Rust sends those through the Responses API
 * (`openai_responses.rs`), the one place OpenAI offers the tier.
 */
const ULTRAFAST_KEY = "saucebunny.ai.ultrafast.openai";

export function loadUltrafast(): boolean {
  try { return localStorage.getItem(ULTRAFAST_KEY) === "1"; } catch { return false; }
}

export function setUltrafast(on: boolean): void {
  try {
    if (on) localStorage.setItem(ULTRAFAST_KEY, "1");
    else localStorage.removeItem(ULTRAFAST_KEY);
  } catch { /* storage unavailable: the choice lasts this session */ }
}

/**
 * The models OpenAI offers Ultrafast for, from its Ultrafast mode guide:
 * gpt-6-astra, and gpt-5.6-sol in preview. A dated snapshot of either counts.
 * With any other model OpenAI refuses the whole request ("Invalid
 * service_tier argument"), so the switch applies only to these.
 */
const ULTRAFAST_MODELS = ["gpt-6-astra", "gpt-5.6-sol"];

export function offersUltrafast(model: string): boolean {
  const id = model.trim();
  return ULTRAFAST_MODELS.some((name) => id === name || new RegExp(`^${name.replace(/\./g, "\\.")}-\\d{4}-\\d{2}-\\d{2}$`).test(id));
}

/** The service tier a request to this provider asks for: Ultrafast for OpenAI when chosen and its model offers it, else none. */
export function serviceTier(p: CloudProvider, model: string = loadCloudModel(p)): "ultrafast" | null {
  return p === "openai" && loadUltrafast() && offersUltrafast(model) ? "ultrafast" : null;
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
        service_tier: serviceTier(provider),
      },
    });
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
