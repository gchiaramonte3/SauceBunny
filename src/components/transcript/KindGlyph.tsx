import { IconInaudible, IconLyric, IconMusic, IconSfx } from "../Icons";
import { speakerInitials } from "./helpers";
import { speakerKind, type SpeechKind } from "../../lib/speech-kind";

const KIND_ICON = {
  music: IconMusic,
  lyric: IconLyric,
  sfx: IconSfx,
  inaudible: IconInaudible,
} as const satisfies Record<Exclude<SpeechKind, "speech">, unknown>;

/**
 * What goes INSIDE a speaker's round badge: their initials, or an icon when
 * the "speaker" is not a person.
 *
 * WHY AN ICON BEATS INITIALS HERE. Initials work because a name has them.
 * "Music" reduces to "M", "Sound effects" to "SE", and — the case that
 * actually prompted this — an unnamed diarizer group reduces to "S11": three
 * characters crammed into a 26px circle that say nothing except that the
 * diarizer counts. A note glyph says what the row IS at a glance, without
 * being read, which is the whole job of a badge at this size.
 *
 * Contents only, not the badge itself. Every call site already owns a styled
 * wrapper with the speaker's colour on it, and wrapping those in a second
 * element would mean reconciling two sets of sizing rules for no gain. This
 * exists so the "initials unless…" branch lives in ONE place rather than
 * being re-derived in the transcript bubbles, the Speakers view, the roster
 * and the split sheet — four chances to forget the else.
 */
export function KindGlyph({
  tag, name, size = 13, override,
}: {
  /** Canonical tag, so a built-in group is recognised even after a rename. */
  tag: string | null;
  name: string;
  /** Icon size in px. Roughly half the badge diameter reads best. */
  size?: number;
  /** An explicit choice from the rename popover. Beats anything derived from
   *  the tag or the name, because the user saying so outranks a heuristic.
   *  "none" means initials even where the name would imply an icon. */
  override?: string | null;
}) {
  const kind = override === "none" ? null
    : (override && override in KIND_ICON ? override as Exclude<SpeechKind, "speech">
      : speakerKind(tag, name));
  if (!kind) return <>{speakerInitials(name)}</>;
  const Glyph = KIND_ICON[kind];
  // Stroked in the same near-black the initials sit in, so the palette's
  // measured contrast ratio holds for the icon too.
  return <Glyph size={size} stroke="#0a0a0a" strokeWidth={2.2} />;
}
