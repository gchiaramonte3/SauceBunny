import { pipelineInvoke } from "./pipeline";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditHead } from "../bindings/EditHead";
import type { EditHistory } from "../bindings/EditHistory";
import type { EditSummary } from "../bindings/EditSummary";
const invoke = pipelineInvoke("String Outs");

/**
 * The Transcript Editor's edits and their undo history, kept by Rust in
 * app_data_dir()/timelines.sqlite (src-tauri/src/edit_log.rs). Every call
 * returns the new head, so the editor never holds a document the history does
 * not: undo, redo and jumps are round trips, not local guesses.
 *
 * `group` coalesces rapid repeats of one action (a paragraph nudged five
 * times) into one undo step, inside a 500 ms window.
 */
export const editStore = {
  list: () => invoke<EditSummary[]>("edit_list"),
  create: (id: string, document: EditDocument) => invoke<EditHead>("edit_create", { id, document }),
  head: (id: string) => invoke<EditHead>("edit_head", { id }),
  commit: (id: string, label: string, document: EditDocument, group: string | null = null) =>
    invoke<EditHead>("edit_commit", { id, label, group, document }),
  undo: (id: string) => invoke<EditHead>("edit_undo", { id }),
  redo: (id: string) => invoke<EditHead>("edit_redo", { id }),
  jump: (id: string, state: number) => invoke<EditHead>("edit_jump", { id, state }),
  pin: (id: string, state: number, name: string | null) => invoke<void>("edit_pin", { id, state, name }),
  history: (id: string) => invoke<EditHistory>("edit_history", { id }),
};

/** A new edit id: short, url-safe, minted locally (never a round trip). */
export function newEditId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
