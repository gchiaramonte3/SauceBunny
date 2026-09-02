import { invoke } from "@tauri-apps/api/core";
import { loadAiProvider, cloudChat } from "./ai-provider";
import { streamChat } from "./ai-chat";
import type { LlmModel } from "../bindings/LlmModel";
import type { LlmServerInfo } from "../bindings/LlmServerInfo";

/**
 * Rewrite a review note for clarity, using whichever model the user has.
 *
 * A review note is written fast, mid-playback, often while talking. This
 * tidies one up. It is deliberately NOT a writing assistant: it must not add
 * an opinion the reviewer did not hold, and it must not lengthen a terse note
 * into a paragraph, because the person reading it is going to act on it.
 *
 * The result always replaces the composer's text in ONE step so a single undo
 * puts the reviewer's own words back. That is the contract this feature makes
 * with the writer, and it is why nothing here posts, saves or streams into the
 * box a token at a time.
 */

/** Kept short and blunt: a long system prompt on a 3B local model produces
 *  more preamble, not more obedience. */
const SYSTEM = [
  "You rewrite one short film-review note so it is clearer.",
  "Rules:",
  "- Keep the author's meaning, judgement and specifics exactly. Never add an opinion.",
  "- Keep it about the same length. Never expand a short note into a paragraph.",
  "- Keep timecodes, names, filenames and jargon verbatim.",
  "- Plain sentence case. No markdown, no bullet points, no quotes around it.",
  "- Reply with the rewritten note and nothing else. No preamble, no explanation.",
].join("\n");

/** Longest note worth sending. Past this it is a document, not a note, and the
 *  round trip stops being fast enough to feel like a button. */
export const ENHANCE_MAX_CHARS = 1200;

/**
 * Strip what small models add despite being told not to.
 *
 * Verified failure shapes rather than imagined ones: a wrapping pair of
 * quotes, and a leading "Here is the rewritten note:" line. Both are common
 * enough on a 3B that not handling them would make the feature feel broken.
 */
export function cleanRewrite(raw: string, original: string): string {
  let out = raw.trim();
  // A leading label line, but only when there IS a following line to keep.
  const nl = out.indexOf("\n");
  if (nl > 0 && /^[^.!?]{0,60}:\s*$/.test(out.slice(0, nl).trim())) out = out.slice(nl + 1).trim();
  // Matched wrapping quotes, straight or curly.
  const pairs: [string, string][] = [['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"]];
  for (const [a, b] of pairs) {
    if (out.length > 1 && out.startsWith(a) && out.endsWith(b)) { out = out.slice(1, -1).trim(); break; }
  }
  // A refusal or an empty answer is not a rewrite. Give the note back
  // unchanged rather than replacing someone's words with an apology.
  if (!out) return original;
  return out;
}

/** Thrown when the local path has no model on disk, so the caller can say
 *  something better than a raw command error. */
export class NoLocalModelError extends Error {
  constructor() { super("No local AI model is downloaded yet."); this.name = "NoLocalModelError"; }
}

export async function enhanceComment(text: string, signal: AbortSignal): Promise<string> {
  const original = text.trim();
  if (!original) return original;
  const provider = loadAiProvider();

  if (provider !== "local") {
    const reply = await cloudChat(provider, SYSTEM, [{ role: "user", content: original }], signal);
    return cleanRewrite(reply, original);
  }

  const models = await invoke<LlmModel[]>("list_llm_models");
  const downloaded = models.filter((m) => m.downloaded);
  const model = downloaded.find((m) => m.recommended) ?? downloaded[0];
  if (!model) throw new NoLocalModelError();

  // Same start path the AI panel uses; if that panel already has the server
  // up on this model the command is a no-op and this is instant.
  const info = await invoke<LlmServerInfo>("start_llm_server", { modelId: model.id });
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  const reply = await streamChat(
    info,
    [{ role: "system", content: SYSTEM }, { role: "user", content: original }],
    () => { /* not streamed into the box: the swap must be one undoable step */ },
    signal,
    // Low temperature and a tight ceiling: this is a tidy-up, not a draft.
    { temperature: 0.2, maxTokens: 400 },
  );
  return cleanRewrite(reply, original);
}
