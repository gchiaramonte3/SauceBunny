import { invoke } from "@tauri-apps/api/core";

/**
 * The editor's Hide bleed switch: Settings ▸ Transcription ▸ Bleed, and the
 * checkbox under AAF Audio's search box. Every place a line heard on another
 * mic can be left out follows it: AAF Audio's All voices and search, String
 * Outs' All voices and its crosstalk report, and an assistant's search.
 *
 * OFF unless the editor turns it on. The bleed resolver's thresholds were
 * tuned on one scene with no hand-checked answers, and a line wrongly called
 * bleed would vanish from all of those with nothing saying it had gone. Off,
 * every line stays and AAF Audio only dims and labels the copies.
 *
 * Rust keeps the value (`app_data_dir()/bleed.json`), not localStorage,
 * because the MCP server answers assistants without the app and must honour
 * it too. This module holds the last value read, so a render never waits.
 */
let hidden = false;
let asked = false;
const listeners = new Set<() => void>();

function publish(next: boolean) {
  if (next === hidden) return;
  hidden = next;
  for (const listener of listeners) listener();
}

export function bleedHidden(): boolean {
  return hidden;
}

export function subscribeBleedHidden(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Read once per window. A read that fails leaves bleed shown, which hides nothing, and the next mount tries again. */
export async function loadBleedHidden(): Promise<void> {
  if (asked) return;
  asked = true;
  try { publish((await invoke<boolean>("bleed_hidden")) === true); }
  catch { asked = false; }
}

/** Saved before it shows: if the write fails, the switch stays where it was. */
export async function setBleedHidden(hide: boolean): Promise<void> {
  await invoke("set_bleed_hidden", { hide });
  publish(hide);
}
