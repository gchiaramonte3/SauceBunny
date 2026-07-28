/**
 * What KIND of thing a stretch of transcript is: someone talking, someone
 * singing, a piece of music, a sound effect, or a hole in the audio.
 *
 * WHY THIS IS NOT AUDIO CLASSIFICATION, and cannot pretend to be. Deciding
 * that a sung line is a lyric — when Whisper transcribed it as ordinary prose,
 * with no marker — requires listening to the audio, and nothing in this app
 * listens. Whisper transcribes; it does not label. So everything here is
 * grounded in one of two honest signals:
 *
 *   1. Markers the transcript ALREADY carries. Whisper, YouTube captions and
 *      broadcast SRTs all emit them — `♪ lyrics ♪`, `[MUSIC]`, `(applause)`,
 *      `[INAUDIBLE]` — and reading a marker somebody else wrote is not a guess.
 *   2. What the user said, by naming a speaker "Music" or tagging a selection.
 *
 * Anything beyond those two would be inventing a fact about the audio, and the
 * failure mode is the same one the whole speaker system is built to avoid:
 * confidently attributing something to the wrong source in an artefact that
 * gets exported and delivered.
 *
 * WHY IT ATTACHES TO A SPEAKER rather than being a third axis. A non-speech
 * stretch already has everything a speaker has — a run of cues, a colour, a
 * label on the bubble, a lane on the timeline — and the cueTag system can
 * already move any selection onto any tag. So "Music" is simply a speaker that
 * happens not to be a person. That means the lasso → right-click → "make this
 * a new speaker" flow tags a music bed with no new mechanism at all, and every
 * downstream consumer (captions, exports, the AI summary, the timeline lanes)
 * inherits it for free.
 */

export type SpeechKind = "speech" | "lyric" | "music" | "sfx" | "inaudible";

/** The non-speech kinds, in the order a picker should offer them. */
export const NON_SPEECH_KINDS: readonly Exclude<SpeechKind, "speech">[] =
  ["music", "lyric", "sfx", "inaudible"];

/** The label a built-in group carries, and what the user sees on the bubble. */
export const KIND_LABEL: Record<Exclude<SpeechKind, "speech">, string> = {
  music: "Music",
  lyric: "Lyrics",
  sfx: "Sound effects",
  inaudible: "Inaudible",
};

/**
 * One neutral tone for every non-speech group.
 *
 * Deliberately NOT a palette hue. The twelve speaker colours exist to tell
 * PEOPLE apart, and they were searched to stay mutually distinguishable; a
 * music bed eating one of them makes the cast harder to read for no gain.
 * Non-speech is a different category and should look like one.
 */
export const NON_SPEECH_COLOR = "#8E8E96";

/**
 * Tags for the built-in groups.
 *
 * Letters only, no digits: `speakerColorIndex` derives a palette slot from the
 * first digit it finds in a tag, so a tag like `KIND_2` would silently claim a
 * cast colour. (The same constraint the minted `CAST_A` tags follow.)
 */
export function kindTag(kind: Exclude<SpeechKind, "speech">): string {
  return `KIND_${kind.toUpperCase()}`;
}

/** The kind a built-in tag denotes, or null for an ordinary speaker. */
export function kindOfTag(tag: string | null | undefined): Exclude<SpeechKind, "speech"> | null {
  if (!tag) return null;
  const m = /^KIND_([A-Z]+)$/.exec(tag);
  const found = m && NON_SPEECH_KINDS.find((k) => k.toUpperCase() === m[1]);
  return found ?? null;
}

/**
 * The kind a speaker's NAME implies.
 *
 * So that typing "Music" into the split sheet does the obvious thing without
 * the user having to find a preset. Matched on the whole trimmed name only —
 * substring matching would classify a person called "Musick", and more
 * importantly would classify "Music supervisor", who is a person.
 */
const NAME_TO_KIND = new Map<string, Exclude<SpeechKind, "speech">>([
  ["music", "music"], ["song", "music"], ["theme", "music"], ["score", "music"],
  ["lyric", "lyric"], ["lyrics", "lyric"], ["singing", "lyric"], ["vocals", "lyric"],
  ["sfx", "sfx"], ["sound effect", "sfx"], ["sound effects", "sfx"], ["sound", "sfx"],
  ["noise", "sfx"], ["applause", "sfx"], ["laughter", "sfx"],
  ["inaudible", "inaudible"], ["unintelligible", "inaudible"], ["crosstalk", "inaudible"],
]);

export function kindOfName(name: string | null | undefined): Exclude<SpeechKind, "speech"> | null {
  if (!name) return null;
  return NAME_TO_KIND.get(name.trim().toLowerCase().replace(/\s+/g, " ")) ?? null;
}

/** A tag's kind if it is a built-in group, else the kind its name implies. */
export function speakerKind(
  tag: string | null | undefined,
  name: string | null | undefined,
): Exclude<SpeechKind, "speech"> | null {
  return kindOfTag(tag) ?? kindOfName(name);
}

// ── Reading markers the transcript already carries ───────────────────────────

/** `♪ … ♪`, `♫ … ♫`, or a line that is nothing but note glyphs and words. */
const MUSIC_NOTE = /[♪♫🎵🎶]/u;
/** A cue that is ENTIRELY a bracketed/parenthesised annotation: "[MUSIC]". */
const ANNOTATION_ONLY = /^\s*[[(]\s*([^\])]*?)\s*[\])]\s*$/;

const ANNOTATION_KIND: [RegExp, Exclude<SpeechKind, "speech">][] = [
  [/^(music|musical|theme|song|score|intro|outro)\b|\bmusic\b|\bplaying\b/i, "music"],
  [/^(singing|sings|vocaliz|humming)|\blyrics?\b/i, "lyric"],
  [/inaudible|unintelligible|crosstalk|indistinct|silence|no audio/i, "inaudible"],
];

/**
 * The kind a cue's own text declares, or null when it is just speech.
 *
 * Note the ORDER of the two music checks below. A cue reading `♪ I walked all
 * night ♪` is a LYRIC — it has words somebody sang — while `[MUSIC]` is an
 * instrumental bed with no words at all. Both carry a note glyph in some
 * caption conventions, so the presence of actual transcribed words is what
 * separates them, and checking the bare annotation first would call every sung
 * line "music" and throw the words away.
 */
export function kindOfCueText(text: string): Exclude<SpeechKind, "speech"> | null {
  const t = text.trim();
  if (!t) return null;

  const annotation = ANNOTATION_ONLY.exec(t);
  if (annotation) {
    const inner = annotation[1] ?? "";
    for (const [re, kind] of ANNOTATION_KIND) if (re.test(inner)) return kind;
    // A bracketed annotation we cannot name is still not speech. "[door slams]"
    // is the commonest shape of all and matches no keyword list worth keeping.
    return "sfx";
  }

  if (MUSIC_NOTE.test(t)) {
    // Words alongside the notes means somebody sang them.
    const words = t.replace(/[♪♫🎵🎶]/gu, " ").trim();
    return /[A-Za-z0-9]/.test(words) ? "lyric" : "music";
  }
  return null;
}

/**
 * How many cues of each kind a transcript declares.
 *
 * Powers an OFFER ("18 cues here look like music — tag them?"), never an
 * automatic rewrite. Auto-tagging on load would silently edit a document the
 * user has not opened yet, and would fight any tagging they had already done
 * by hand.
 */
export function countKinds(texts: readonly string[]): Record<Exclude<SpeechKind, "speech">, number> {
  const out = { music: 0, lyric: 0, sfx: 0, inaudible: 0 };
  for (const t of texts) {
    const k = kindOfCueText(t);
    if (k) out[k] += 1;
  }
  return out;
}
