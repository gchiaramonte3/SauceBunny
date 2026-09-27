/**
 * Transcript Editor prototype: the Ask panel's stand-in for a model.
 *
 * In the app, Ask sends the mentioned transcripts to local Qwen, or to Claude
 * with the user's own key (the r135 opt-in path), and gets back text plus
 * proposed edits. Here a few scripted intents answer instead, so the panel's
 * shape can be judged: @ mentions pick what it reads, answers cite lines you
 * can jump to, and a change is always a PROPOSAL the editor applies, and can
 * undo, never something the chat does on its own.
 */
import type { TePlacedWord, TeSpeaker, TeWord } from "./transcript-editor-model";

export type TeMention = { kind: "source" | "speaker" | "edit"; id: string; label: string; token: string };
export type TeLine = { source: string; speaker: string; words: TeWord[] };
export type TeProposal =
  | { kind: "insert"; label: string; lines: TeLine[] }
  /** Word ids, not placements: the edit may change before it is applied. */
  | { kind: "delete"; label: string; ids: string[] };
export type TeReply = { text: string; lines: TeLine[]; proposal: TeProposal | null };
export type TeAgentContext = {
  words: TeWord[]; placed: TePlacedWord[]; speakers: TeSpeaker[];
  sources: { id: string; short: string; mention: string }[];
};

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
const bare = (text: string) => text.toLowerCase().replace(/[^a-z']/g, "");

/** What can follow an @: every open source, every speaker, and the edit itself. */
export function mentionOptions(context: Pick<TeAgentContext, "sources" | "speakers">): TeMention[] {
  return [
    { kind: "edit", id: "edit", label: "This edit", token: "@edit" },
    ...context.sources.map((source): TeMention => ({ kind: "source", id: source.id, label: source.short, token: `@${source.mention}` })),
    ...context.speakers.map((speaker): TeMention => ({ kind: "speaker", id: speaker.id, label: speaker.name, token: `@${speaker.name.replace(/\s+/g, "")}` })),
  ];
}

/** The @word being typed just before the caret, if there is one. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([\w-]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[1].length - 1, query: match[1].toLowerCase() } : null;
}

export function parseMentions(text: string, options: TeMention[]): TeMention[] {
  const tokens = new Set((text.match(/@[\w-]+/g) ?? []).map((token) => token.toLowerCase()));
  return options.filter((option) => tokens.has(option.token.toLowerCase()));
}

/** A source's words as lines: a new line on a change of speaker or a pause. */
export function linesOf(words: TeWord[]): TeLine[] {
  const lines: TeLine[] = [];
  for (const word of [...words].sort((a, b) => a.source.localeCompare(b.source) || a.start - b.start)) {
    const line = lines[lines.length - 1], previous = line?.words[line.words.length - 1];
    if (!line || line.source !== word.source || line.speaker !== word.speaker || word.start - previous.end > 0.6) {
      lines.push({ source: word.source, speaker: word.speaker, words: [word] });
    } else line.words.push(word);
  }
  return lines;
}

const FILLERS = new Set(["um", "uh", "erm", "like"]);
const STOP = new Set(["find", "where", "does", "do", "did", "say", "says", "said", "about", "the", "a", "an", "in", "of", "mention", "mentions", "search", "for", "every", "time", "someone", "anyone", "talk", "talks", "is", "any", "lines", "line", "me", "show"]);

function searchTerm(prompt: string): string | null {
  const quoted = /["“'‘]([^"”'’]+)["”'’]/.exec(prompt);
  if (quoted) return quoted[1].trim().toLowerCase();
  const rest = prompt.replace(/@[\w-]+/g, " ").toLowerCase().split(/\s+/).map(bare).filter((word) => word && !STOP.has(word));
  return rest.length ? rest.join(" ") : null;
}

export function answer(prompt: string, context: TeAgentContext): TeReply {
  const mentions = parseMentions(prompt, mentionOptions(context));
  const sourceIds = mentions.filter((item) => item.kind === "source").map((item) => item.id);
  const speakerIds = mentions.filter((item) => item.kind === "speaker").map((item) => item.id);
  const inEdit = mentions.some((item) => item.kind === "edit");
  const scope = context.words.filter((word) => (sourceIds.length ? sourceIds.includes(word.source) : true)
    && (speakerIds.length ? speakerIds.includes(word.speaker) : true));
  const where = sourceIds.length ? sourceIds.map((id) => context.sources.find((source) => source.id === id)?.short).join(" and ") : "every source";
  const nameOf = (id: string) => context.speakers.find((speaker) => speaker.id === id)?.name ?? id;
  const text = prompt.toLowerCase();

  if (/\b(fillers?|ums?|uhs?)\b/.test(text)) {
    const hits = context.placed.filter((item) => FILLERS.has(bare(item.word.text))
      && (item.word.text.endsWith(",") || bare(item.word.text) !== "like")
      && (speakerIds.length ? speakerIds.includes(item.word.speaker) : true));
    if (!hits.length) return { text: "I found no filler words in the edit.", lines: [], proposal: null };
    return {
      text: `${plural(hits.length, "filler word")} in the edit. Removing them cuts that time from every track; each one is shown below so you can check it first.`,
      lines: hits.map((item) => ({ source: item.word.source, speaker: item.word.speaker, words: [item.word] })),
      proposal: { kind: "delete", label: `Remove ${plural(hits.length, "Filler Word")}`, ids: hits.map((item) => item.word.id) },
    };
  }

  if (/\b(summar\w*|overview|who talks|how long)\b/.test(text)) {
    const target = inEdit ? context.placed.map((item) => item.word) : scope;
    const talk = new Map<string, number>();
    for (const word of target) talk.set(word.speaker, (talk.get(word.speaker) ?? 0) + word.end - word.start);
    const ranked = [...talk.entries()].sort((a, b) => b[1] - a[1]).map(([id, seconds]) => `${nameOf(id)} ${seconds.toFixed(0)} s`);
    return { text: `${inEdit ? "This edit" : where}: ${plural(linesOf(target).length, "line")} of dialogue. Talk time: ${ranked.join(", ")}.`, lines: [], proposal: null };
  }

  if (/\b(pull|string[- ]?out|every(thing)?|all)\b/.test(text) && speakerIds.length) {
    const lines = linesOf(scope);
    return {
      text: `${plural(lines.length, "line")} from ${speakerIds.map(nameOf).join(" and ")} in ${where}, in the order they were said.`,
      lines, proposal: lines.length ? { kind: "insert", label: `Add ${plural(lines.length, "Line")} to the End`, lines } : null,
    };
  }

  const term = searchTerm(prompt);
  if (term && /\b(find|where|search|say|says|said|mention|about)\b/.test(text)) {
    const lines = linesOf(scope).filter((line) => line.words.map((word) => bare(word.text)).join(" ").includes(term.split(/\s+/).map(bare).join(" ")));
    return {
      text: lines.length ? `“${term}” comes up ${plural(lines.length, "time")} in ${where}.` : `“${term}” does not come up in ${where}.`,
      lines, proposal: lines.length ? { kind: "insert", label: `Add ${plural(lines.length, "Line")} to the End`, lines } : null,
    };
  }

  return {
    text: "In this prototype I can find a phrase, pull every line from a person, remove filler words, or summarize a source. Try: find “onions” in @Kitchen, pull every line from @Rosa, remove fillers from @edit, or summarize @Judges.",
    lines: [], proposal: null,
  };
}
