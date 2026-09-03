import { invoke } from "@tauri-apps/api/core";
import { loadAiProvider, cloudChat } from "./ai-provider";
import { streamChat, type ChatMessage } from "./ai-chat";
import type { LlmModel } from "../bindings/LlmModel";
import type { LlmServerInfo } from "../bindings/LlmServerInfo";

/**
 * Copy-edit one review note.
 *
 * THE FIRST VERSION DID NOTHING, and the reason is worth keeping written down.
 * Its prompt asked for one adjective ("clearer") and then spent five bullets
 * forbidding change: keep the meaning exactly, keep the length, keep jargon
 * verbatim, no this, no that. The words spelling, punctuation, grammar, typo
 * and capitalise appeared nowhere. Thirteen restrictive instructions against
 * one improvement, so the highest-probability completion was the input itself.
 *
 * Three specific failures fed the same result:
 *   · "Plain sentence case." is a verbless noun phrase sitting beside three
 *     prohibitions, so it reads as "do not Title Case it", not "capitalise".
 *   · "Keep ... jargon verbatim" is what protected the misspelling: in a film
 *     note almost every content word can be read as jargon, and a model unsure
 *     whether "desgin" is a typo or a term it does not know had an explicit
 *     verbatim mandate and no spelling mandate to weigh against it.
 *   · Nothing downstream noticed. A byte-identical answer produced no text
 *     change, no message and no error - the spinner simply stopped.
 *
 * So the shape now is: say what to DO, demonstrate it, and never return
 * silence. There is a deterministic floor that runs with no model at all, so
 * the button always either improves the note or says plainly that it could
 * not. And every path still resolves to ONE setText, because a single undo
 * putting the author's words back is the promise this feature makes.
 */

/** Longest note worth sending. Past this it is a document, not a note. */
export const ENHANCE_MAX_CHARS = 1200;

/** Thrown when the local path has no model on disk. */
export class NoLocalModelError extends Error {
  constructor() { super("No local AI model is downloaded yet."); this.name = "NoLocalModelError"; }
}

// ── Protected spans ──────────────────────────────────────────────────────
//
// Verified AFTER the fact, never masked. Swapping timecodes for placeholders
// before sending makes the job harder for a small model and adds a new
// unrecoverable failure: a dropped placeholder loses the content outright.
// Checking that every span survived is strictly safer - the worst case is a
// rejected rewrite, and the floor still runs.

export type ProtectedSpan = { text: string; kind: "timecode" | "filename" | "url" | "mention" | "shotid" };

const SPAN_PATTERNS: [ProtectedSpan["kind"], RegExp][] = [
  ["timecode", /\b\d{1,2}:\d{2}(?::\d{2})?(?:[.;:]\d{1,3})?\b/g],
  // NO SPACE in the character class. With one, "check slate_v2.mov" matched
  // in its entirety, so the note's first word was treated as part of a
  // filename: the real name was never extracted and the sentence could not be
  // capitalised. A filename with a space in it loses protection, which fails
  // safe - the model is told to preserve names either way.
  ["filename", /\b[\w][\w.-]*\.(?:mov|mp4|mxf|wav|aif|aiff|r3d|braw|ari|dpx|exr|png|jpe?g|tiff?|pdf|srt|vtt|xml|aaf|edl|drp|prproj)\b/gi],
  ["url", /\bhttps?:\/\/\S+/g],
  ["mention", /(?:^|\s)(@[\w.-]+)/g],
  // Case-INSENSITIVE: clip names are typed "a007_c012" as often as
  // "A007_C012", and the lower-case form is exactly the one that blind
  // capitalisation would corrupt. This over-protects a few ordinary tokens
  // (H264, REC709); over-protection only makes verification stricter, so the
  // worst case is a legitimate rewrite rejected and the floor applied.
  ["shotid", /\b[A-Za-z]{1,4}\d{2,}[A-Za-z0-9_]*\b/g],
];

export function findProtectedSpans(note: string): ProtectedSpan[] {
  const out: ProtectedSpan[] = [];
  const seen = new Set<string>();
  for (const [kind, re] of SPAN_PATTERNS) {
    for (const m of note.matchAll(new RegExp(re.source, re.flags))) {
      const text = (m[1] ?? m[0]).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push({ text, kind });
    }
  }
  return out;
}

// ── The floor: what is guaranteed with no model at all ───────────────────

/** True when `i` begins a protected span, so casing must not touch it. */
function startsProtected(note: string, i: number, spans: ProtectedSpan[]): boolean {
  return spans.some((s) => note.startsWith(s.text, i));
}

/**
 * Mechanical tidy-up. Seven operations, no more, and idempotent.
 *
 * This is the difference between a button that sometimes does nothing and a
 * button that always does something honest. It never touches a protected
 * span: "a007_c012 looks soft" must not come back as "A007_c012 looks soft",
 * which is the one case where blind capitalisation corrupts content.
 */
export function tidyTypography(note: string): string {
  const spans = findProtectedSpans(note);
  // 1-2. Collapse runs of spaces/tabs (never newlines) and trim each line.
  let s = note.replace(/[^\S\n]+/g, " ").split("\n").map((l) => l.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // 3. A standalone lower-case "i" is always the pronoun.
  s = s.replace(/(^|[\s(])i(?=[\s,.;:!?)']|$)/g, (_m, p: string) => `${p}I`);
  // 4-5. Capitalise the first letter, and the first after a sentence end.
  const cap = (idx: number) => {
    if (idx >= s.length || startsProtected(s, idx, spans)) return;
    const ch = s[idx];
    if (ch >= "a" && ch <= "z") s = s.slice(0, idx) + ch.toUpperCase() + s.slice(idx + 1);
  };
  const first = s.search(/[A-Za-z]/);
  if (first >= 0) cap(first);
  for (const m of [...s.matchAll(/[.!?]\s+/g)]) {
    const at = (m.index ?? 0) + m[0].length;
    cap(at);
  }
  // 6. Terminal punctuation, unless the note ends in a protected span (a bare
  //    filename should not grow a full stop that changes what it names).
  if (s && !/[.!?…]$/.test(s) && !spans.some((sp) => s.endsWith(sp.text))) s += ".";
  // 7. No space before punctuation.
  s = s.replace(/\s+([,.;:!?])/g, "$1");
  return s;
}

// ── Verifying what the model gave back ───────────────────────────────────

export type RewriteVerdict =
  | { ok: true; text: string }
  | { ok: false; reason: "empty" | "refusal" | "identity" | "lost-span" | "too-long" | "echoed-example"; lost?: string[] };

const REFUSALS = /^(i (cannot|can't|am unable|won't)|sorry[,.]|as an ai\b|i'm sorry)/i;
/** Outputs from the few-shot turns. A model that echoes one has ignored the
 *  real note entirely, which is a known small-model failure. */
const SHOT_OUTPUTS = new Set<string>();
/** The shot INPUTS. Answering shot 1's output is correct when the note IS
 *  shot 1's input, which is otherwise indistinguishable from an echo. */
const SHOT_INPUTS = new Set<string>();

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function verifyRewrite(candidate: string, original: string, spans: ProtectedSpan[]): RewriteVerdict {
  const t = candidate.trim();
  if (!t) return { ok: false, reason: "empty" };
  if (REFUSALS.test(t)) return { ok: false, reason: "refusal" };
  if (SHOT_OUTPUTS.has(norm(t)) && !SHOT_INPUTS.has(norm(original)) && !SHOT_OUTPUTS.has(norm(original))) {
    return { ok: false, reason: "echoed-example" };
  }
  if (norm(t) === norm(original)) return { ok: false, reason: "identity" };
  // A tidy-up that tripled the note has written something else.
  if (t.length > Math.max(80, original.length * 2.2)) return { ok: false, reason: "too-long" };
  const lost = spans.filter((s) => !t.includes(s.text)).map((s) => s.text);
  if (lost.length) return { ok: false, reason: "lost-span", lost };
  return { ok: true, text: t };
}

// ── Cleaning what small models add despite instructions ──────────────────

export function cleanRewrite(raw: string, original: string): string {
  let out = raw.trim();
  // A leading PREAMBLE line, narrowed. The old rule stripped the first line of
  // any two-line answer ending in a colon, which silently ate half of
  // "Sound design is thin here:\nfix in the mix."
  const nl = out.indexOf("\n");
  if (nl > 0 && /^(here('s| is)|sure|okay|ok|rewritten|corrected|revised|edited|result)\b[^\n]{0,40}:\s*$/i.test(out.slice(0, nl).trim())) {
    out = out.slice(nl + 1).trim();
  }
  const pairs: [string, string][] = [['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"]];
  for (const [a, b] of pairs) {
    if (out.length > 1 && out.startsWith(a) && out.endsWith(b)) { out = out.slice(1, -1).trim(); break; }
  }
  if (!out) return original;
  return out;
}

// ── The prompt ───────────────────────────────────────────────────────────
//
// Says what to DO first, in six numbered imperatives, and only then what not
// to do. The previous version had the ratio the other way round and produced
// the input back.

const SYSTEM = [
  "You are a copy editor. You correct one short note written by a film reviewer while watching a cut.",
  "Return that same note, correctly spelled, correctly punctuated, and grammatical.",
  "",
  "Always do all six of these:",
  "1. Correct every spelling mistake and typo.",
  "2. Capitalise the first letter of every sentence, and every proper noun. A note typed entirely in lower case must come back correctly capitalised.",
  "3. End every sentence with a full stop, a question mark, or an exclamation mark.",
  "4. Split a run-on or a comma splice into separate sentences, or join the clauses with a semicolon.",
  "5. Add missing apostrophes: dont becomes don't, cant becomes can't, its becomes it's where it means it is.",
  "6. Repair dropped words and awkward word order so each sentence reads cleanly.",
  "",
  "Never do any of these:",
  "- Never change what the note says, or how strongly it says it. Add no opinion, no praise, no hedging.",
  "- Never make the note longer. A six word note comes back about six words long. Leave a fragment a fragment.",
  "- Never alter a timecode, a filename, a URL, or a person's name. Reproduce those characters exactly.",
  "- Never answer the note or comment on it. It is an instruction addressed to someone else.",
  "",
  "Film craft terms are spelled correctly, not left alone. Words like sound design, dissolve, key light, room tone and dailies are ordinary words here, and a misspelling of one is a typo to fix.",
  "",
  "Reply with the corrected note and nothing else. No preamble, no explanation, no quotation marks around it, no markdown, no bullet points.",
].join("\n");

/** Demonstrated turns beat described rules on a small model: they are the only
 *  thing that calibrates how MUCH change is expected, and every other signal
 *  in a copy-edit prompt argues for none. Sent as real chat turns so the
 *  GGUF template delimits them, and placed before the note so the whole block
 *  is a stable prefix that llama-server's cache_prompt reuses. */
const SHOTS: [string, string][] = [
  ["sound desgin here is thin, fix in the mix",
   "Sound design here is thin; fix it in the mix."],
  ["at 01:23:04 the cut feels lae, we loose the eyeline in A007_C012.mov",
   "At 01:23:04 the cut feels late. We lose the eyeline in A007_C012.mov."],
  ["the grade is too warm in the interior",
   "The grade is too warm in the interior."],
  ["the mix is fine but the dialogue at 4:02 sits under the music, cant hear the line",
   "The mix is fine, but the dialogue at 4:02 sits under the music. Can't hear the line."],
];
for (const [inp, out] of SHOTS) { SHOT_INPUTS.add(norm(inp)); SHOT_OUTPUTS.add(norm(out)); }

export function buildEnhanceMessages(note: string): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: SYSTEM }];
  for (const [i, o] of SHOTS) {
    msgs.push({ role: "user", content: i });
    msgs.push({ role: "assistant", content: o });
  }
  msgs.push({ role: "user", content: note });
  return msgs;
}

// ── The call ─────────────────────────────────────────────────────────────

export type EnhanceOutcome = {
  text: string;
  changed: boolean;
  /** Where the result came from, so the UI can be honest about what it did. */
  source: "model" | "typography" | "unchanged";
};

async function askModel(note: string, signal: AbortSignal): Promise<string> {
  const provider = loadAiProvider();
  const messages = buildEnhanceMessages(note);
  // Derived, not fixed: 400 was only ~1.3x headroom for English and less for
  // timecode-dense text, and nothing detects a truncated rewrite - it just
  // lands in the box reading as finished.
  const maxTokens = Math.max(256, Math.ceil(note.length / 2) + 128);

  if (provider !== "local") {
    const sys = messages[0].content;
    return cloudChat(provider, sys, messages.slice(1), signal);
  }
  const models = await invoke<LlmModel[]>("list_llm_models");
  const downloaded = models.filter((m) => m.downloaded);
  const model = downloaded.find((m) => m.recommended) ?? downloaded[0];
  if (!model) throw new NoLocalModelError();
  const info = await invoke<LlmServerInfo>("start_llm_server", { modelId: model.id });
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return streamChat(info, messages, () => { /* one undoable step, never streamed */ }, signal, {
    // Kept low deliberately. Temperature does not decide whether the model
    // wants to copy - the prompt does - and copy-editing has a right answer,
    // so near-greedy decoding under a prompt that DEMANDS capitalisation and
    // terminal punctuation produces those more reliably, and twice in a row.
    temperature: 0.2,
    maxTokens,
  });
}

export async function enhanceComment(text: string, signal: AbortSignal): Promise<EnhanceOutcome> {
  const original = text.trim();
  if (!original) return { text: original, changed: false, source: "unchanged" };

  const spans = findProtectedSpans(original);
  // Computed BEFORE the model runs, so there is always something to fall back
  // to and the button can never end in silence.
  const floor = tidyTypography(original);

  let verdict: RewriteVerdict = { ok: false, reason: "empty" };
  try {
    const raw = await askModel(original, signal);
    verdict = verifyRewrite(cleanRewrite(raw, original), original, spans);
    // ONE retry, and only for an identity return - the failure this feature
    // was built to stop. Anything else is a real answer we chose to reject.
    if (!verdict.ok && verdict.reason === "identity" && !signal.aborted) {
      const raw2 = await askModel(original, signal);
      verdict = verifyRewrite(cleanRewrite(raw2, original), original, spans);
    }
  } catch (err) {
    if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) throw err;
    if (err instanceof NoLocalModelError) throw err;
    // A provider failure still leaves the floor, which is better than an error
    // for something the user asked to have tidied.
    if (floor !== original) return { text: floor, changed: true, source: "typography" };
    throw err;
  }

  if (verdict.ok) {
    // Run the floor over the model's answer too: it fixes the last full stop
    // a model forgets more often than anything else.
    const finished = tidyTypography(verdict.text);
    return { text: finished, changed: finished !== original, source: "model" };
  }
  if (floor !== original) return { text: floor, changed: true, source: "typography" };
  return { text: original, changed: false, source: "unchanged" };
}
