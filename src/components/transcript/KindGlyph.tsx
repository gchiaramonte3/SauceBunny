import { badgeIcon } from "./badge-icons";
import { speakerInitials } from "./helpers";
import { speakerKind } from "../../lib/speech-kind";

/**
 * What goes INSIDE a speaker's round badge: their initials, or an icon.
 *
 * WHY AN ICON BEATS INITIALS HERE. Initials work because a name has them.
 * "Music" reduces to "M", "Sound effects" to "SE", and — the case that
 * actually prompted this — an unnamed diarizer group reduces to "S11": three
 * characters crammed into a 26px circle that say nothing except that the
 * diarizer counts. A note glyph says what the row IS at a glance, without
 * being read, which is the whole job of a badge at this size.
 *
 * THREE SOURCES, IN THIS ORDER. An explicit pick from the icon sheet wins,
 * because the user saying so outranks any heuristic. Failing that, the four
 * non-speech kinds are derived from the tag or the name, so a music bed carries
 * a note without anybody having chosen one. Failing that, initials. An id the
 * catalogue does not know — hand-edited, or written by a newer build — falls
 * through to the derivation rather than blanking the badge, so a badge is never
 * empty.
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
  /** An explicit badge-icon id from the picker. "none" means initials even
   *  where the tag or the name would imply an icon. */
  override?: string | null;
}) {
  // "none" is checked first and separately: it is the only value that has to
  // beat the DERIVATION as well as the catalogue, which is what makes it the
  // way back for a group whose own name implies an icon.
  if (override === "none") return <>{speakerInitials(name)}</>;
  const chosen = badgeIcon(override) ?? badgeIcon(speakerKind(tag, name));
  if (!chosen) return <>{speakerInitials(name)}</>;
  const Glyph = chosen.Glyph;
  // Stroked in the same near-black the initials sit in, so the palette's
  // measured contrast ratio holds for the icon too.
  return <Glyph size={size} stroke="#0a0a0a" strokeWidth={2.2} />;
}
