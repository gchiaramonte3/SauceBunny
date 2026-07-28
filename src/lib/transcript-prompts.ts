/**
 * Slash commands for "Ask the transcript".
 *
 * These are PROMPTS, not features. Nothing here calls a model differently or
 * knows anything the chat box did not already know — each entry is a sentence
 * somebody would have had to type, written once and written well. That is the
 * whole value: the difference between a useful answer and a vague one is
 * almost entirely in how the question was asked, and asking well is a skill
 * nobody should have to re-learn at 2am.
 *
 * WHY SELECTING ONE FILLS THE BOX RATHER THAN SENDING. Three reasons, in
 * order of weight. The prompt is visible before it costs a model call, so
 * nothing is spent on a question the user did not mean. It stays editable, so
 * "/quotes" becomes "/quotes, but only about pricing" without starting over.
 * And it TEACHES — a user who sees the wording that produced a good answer
 * writes better questions of their own, which a hidden prompt could never do.
 *
 * Every prompt asks for timestamps where timestamps make sense, because the
 * summary pane renders them as click-to-seek anchors: an answer that cites
 * 00:14:32 is one the user can verify in a second, and one that does not is
 * something they have to take on faith.
 */

export type TranscriptPrompt = {
  /** Typed after the slash. Lowercase, no spaces. */
  id: string;
  /** Shown in the menu. */
  label: string;
  /** One line on what you get back. */
  hint: string;
  /** What actually gets asked. */
  prompt: string;
};

export const TRANSCRIPT_PROMPTS: readonly TranscriptPrompt[] = [
  {
    id: "summary",
    label: "Summarize",
    hint: "The short version, in bullets",
    prompt: "Summarize this transcript in a few bullet points. Lead with what it is actually about, not with what happens first.",
  },
  {
    id: "takeaways",
    label: "Key takeaways",
    hint: "What matters, with timestamps",
    prompt: "What are the key takeaways? Give each one with the timestamp where it is best supported.",
  },
  {
    id: "quotes",
    label: "Pull quotes",
    hint: "The most usable lines, verbatim",
    prompt: "Pull the most quotable lines. Quote them VERBATIM with the speaker and timestamp, and do not clean up the wording. Prefer lines that stand on their own out of context.",
  },
  {
    id: "topics",
    label: "Topics",
    hint: "What is covered, and when",
    prompt: "List the main topics covered and the timestamp where each one starts.",
  },
  {
    id: "chapters",
    label: "Chapters",
    hint: "Chapter markers with timecodes",
    prompt: "Propose chapter markers for this. Give each a short title and the timestamp it starts at. Aim for chapters a viewer would actually want to jump between, not even intervals.",
  },
  {
    id: "clips",
    label: "Clip-worthy moments",
    hint: "What to cut, with in and out points",
    prompt: "Find the moments worth cutting as standalone clips. For each, give an in-point and an out-point timestamp, who is speaking, and one line on why it works on its own.",
  },
  {
    id: "actions",
    label: "Action items",
    hint: "Who agreed to do what",
    prompt: "List the action items. For each, say who owns it, what exactly was committed to, any deadline mentioned, and the timestamp where it was agreed. If nobody actually committed to anything, say so rather than inventing tasks.",
  },
  {
    id: "questions",
    label: "Open questions",
    hint: "What was asked and never answered",
    prompt: "List the questions that were asked and NOT answered, with the timestamp each was raised. Ignore rhetorical questions.",
  },
  {
    id: "speakers",
    label: "By speaker",
    hint: "What each person contributed",
    prompt: "Go speaker by speaker. For each, summarize their position and what they contributed, and note where they disagreed with anyone else.",
  },
  {
    id: "decisions",
    label: "Decisions",
    hint: "What was settled, and what was not",
    prompt: "What was decided here? For each decision give the timestamp, who made the call, and what the alternatives were. Separately list anything that was discussed but left unresolved.",
  },
  {
    id: "timeline",
    label: "Beat sheet",
    hint: "The whole thing in order",
    prompt: "Give a chronological beat sheet: each significant beat with its timestamp, in order, in one line each.",
  },
  {
    id: "followup",
    label: "What to ask next",
    hint: "Where the interesting gaps are",
    prompt: "Based on this transcript, what are the most useful follow-up questions to ask, and why? Point at the gaps and the things left vague, with timestamps.",
  },
];

/**
 * The typed slash query, or null when the box is not in command mode.
 *
 * Command mode is a leading slash and NOTHING before it. Anywhere else a
 * slash is just punctuation — "and/or", a URL, a date — and popping a menu
 * mid-sentence would be an ambush. The query also stops at the first space,
 * so "/quotes about pricing" leaves command mode once you start writing the
 * rest of the sentence.
 */
export function slashQuery(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const rest = input.slice(1);
  if (/\s/.test(rest)) return null;
  return rest.toLowerCase();
}

/** Prompts matching a slash query, best first. */
export function matchPrompts(query: string): TranscriptPrompt[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...TRANSCRIPT_PROMPTS];
  const starts = TRANSCRIPT_PROMPTS.filter((p) => p.id.startsWith(q));
  // Then anything that merely CONTAINS it, so "/clip" finds "clips" first but
  // "/quote" still finds "quotes" and "/mark" still finds "chapters" via its
  // label. Ranked below prefix matches because a prefix is what people type.
  const contains = TRANSCRIPT_PROMPTS.filter(
    (p) => !p.id.startsWith(q)
      && (p.id.includes(q) || p.label.toLowerCase().includes(q)),
  );
  return [...starts, ...contains];
}
