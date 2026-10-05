/**
 * The Parakeet models AAF Audio can run. The ids are the ones documents
 * record and `transcript.rs`'s `parakeet_model` accepts. Ultra comes first
 * because it is the one to recommend: Moondream's post-train of v3, same
 * tokenizer and speed, fewer errors (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md,
 * phase 2).
 */
export const PARAKEET_MODELS = [
  { id: "parakeet-ultra", name: "Parakeet Ultra", size: "≈0.6 GB" },
  { id: "parakeet-tdt-0.6b-v3", name: "Parakeet TDT 0.6B v3", size: "≈0.5 GB" },
] as const;

export type ParakeetModelId = (typeof PARAKEET_MODELS)[number]["id"];

export const isParakeetModel = (id: string | undefined): id is ParakeetModelId => PARAKEET_MODELS.some((model) => model.id === id);

/** The best installed model, or Ultra (to download) when none is. */
export function preferredParakeet(ready: Partial<Record<ParakeetModelId, boolean>>): ParakeetModelId {
  return PARAKEET_MODELS.find((model) => ready[model.id])?.id ?? PARAKEET_MODELS[0].id;
}
