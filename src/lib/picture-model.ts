export const PICTURE_MODELS = [{ id: "qwen3.5-9b-video", name: "Qwen3.5 9B" }, { id: "qwen3.5-4b-video", name: "Qwen3.5 4B" }] as const;
export type PictureModelId = typeof PICTURE_MODELS[number]["id"];
export const PICTURE_MODEL_KEY = "saucebunny.pictureModel";
export function isPictureModel(id: string): id is PictureModelId { return PICTURE_MODELS.some(model => model.id === id); }
export function savedPictureModel(): PictureModelId {
  try { const id = localStorage.getItem(PICTURE_MODEL_KEY); if (id && isPictureModel(id)) return id; } catch { /* Storage unavailable; use the explicit default. */ }
  return "qwen3.5-9b-video";
}
