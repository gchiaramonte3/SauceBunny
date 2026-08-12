import type { FinderTag } from "../bindings/FinderTag";

/**
 * Finder's seven tag colours, and how a set of tags becomes one swatch.
 *
 * THESE ARE macOS's COLOURS, NOT OURS. The indices 1-7 are fixed by the
 * operating system: a tag written with index 6 shows red in Finder whatever we
 * think, so the palette here has to match what the user will see in the other
 * app or the two disagree about the same file. That also means the set cannot
 * be extended — an eighth colour has nowhere to live in the format.
 *
 * INDEX 0 IS "NO COLOUR", not an eighth hue. A tag can be a bare label
 * ("Archive") with no colour at all, which Finder shows as text in the sidebar
 * and no dot on the icon.
 */

export type TagColorIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type TagColor = {
  index: TagColorIndex;
  /** Finder's own name for the colour, which is also the default tag name. */
  label: string;
  hex: string;
};

/**
 * In Finder's own menu order.
 *
 * The greens are worth a note: macOS green (#63DA57) sits near this app's
 * accent (#6CFF8D), which everywhere else means "selected". It is darker and
 * less saturated, so the two read apart on a row, but a tag swatch must never
 * be drawn at accent brightness or a green-tagged file will look chosen.
 */
export const TAG_COLORS: readonly TagColor[] = [
  { index: 1, label: "Grey", hex: "#A2A2A6" },
  { index: 2, label: "Green", hex: "#63DA57" },
  { index: 3, label: "Purple", hex: "#CB6BD9" },
  { index: 4, label: "Blue", hex: "#3B8EF3" },
  { index: 5, label: "Yellow", hex: "#F4CA48" },
  { index: 6, label: "Red", hex: "#FB5B54" },
  { index: 7, label: "Orange", hex: "#F5A33C" },
];

const BY_INDEX = new Map(TAG_COLORS.map((c) => [c.index, c]));
const BY_LABEL = new Map(TAG_COLORS.map((c) => [c.label.toLowerCase(), c]));

/** The colour for an index, or null for 0 / anything out of range. */
export function tagColor(index: number): TagColor | null {
  return BY_INDEX.get(index as TagColorIndex) ?? null;
}

/**
 * The colour ONE tag should draw as.
 *
 * THE NAME WINS, AND IT HAS TO. The index in the xattr is not authoritative:
 * Finder keeps its own tag list and resolves a named tag's colour from there,
 * so what it writes to disk is routinely index 1 for every colour. Real folders
 * on this machine read back as "Purple\n1", "Red\n1", "Green\n1",
 * "Blue\n1" — four different colours in Finder, all claiming index 1, which is
 * Grey in the table above.
 *
 * Trusting the index therefore painted every Finder-tagged folder grey while
 * folders tagged from inside this app (which writes a correct index) coloured
 * fine. It looked like we could not read Finder's tags at all; in fact we read
 * them and then discarded the only field that carried the answer.
 *
 * The index remains the fallback, and it is the one that matters for a CUSTOM
 * tag: "Archive" with index 6 is a red tag whose name means something else.
 */
export function swatchForTag(tag: FinderTag): TagColor | null {
  const byName = BY_LABEL.get(tag.name.trim().toLowerCase());
  if (byName) return byName;
  return tagColor(tag.color);
}

/**
 * The swatches to draw for a file, newest last.
 *
 * Finder shows at most THREE, with the final one on top; beyond that the dots
 * stop being distinguishable at icon size. Colourless tags contribute a label
 * but no dot, so they are dropped here rather than drawn as an empty hole.
 */
export function tagSwatches(tags: readonly FinderTag[]): TagColor[] {
  const colored = tags.map(swatchForTag).filter((c): c is TagColor => c !== null);
  return colored.slice(-3);
}

/** The one colour a compact row shows: the last coloured tag, or null. */
export function primarySwatch(tags: readonly FinderTag[]): TagColor | null {
  const s = tagSwatches(tags);
  return s.length ? s[s.length - 1] : null;
}

/**
 * Toggle a colour on a file's tag list.
 *
 * SETTING A COLOUR THAT IS ALREADY THERE REMOVES IT, which is how Finder's
 * colour row behaves and what makes the row a set of toggles rather than a
 * one-way assignment with no undo.
 *
 * A colour is added as a tag NAMED after the colour, which is what Finder does
 * for its built-ins, so a file tagged red here appears under Finder's "Red"
 * sidebar item rather than as a nameless colour Finder cannot file.
 */
export function toggleTagColor(
  tags: readonly FinderTag[], index: TagColorIndex,
): FinderTag[] {
  const color = tagColor(index);
  if (!color) return [...tags];
  const has = tags.some((t) => t.color === index);
  if (has) return tags.filter((t) => t.color !== index);
  return [...tags, { name: color.label, color: index }];
}

/**
 * Strip every colour but keep named labels.
 *
 * "No colour" must not silently delete a tag the user typed in Finder. Only
 * the colour goes; a tag named "Delivered" survives with colour 0.
 */
export function clearTagColors(tags: readonly FinderTag[]): FinderTag[] {
  return tags
    // A tag whose name is just a colour name carried no information beyond the
    // colour, so clearing the colour leaves nothing worth keeping.
    .filter((t) => !TAG_COLORS.some((c) => c.label === t.name))
    .map((t) => ({ ...t, color: 0 }));
}

/** Tooltip text for a file's tags, or null when it has none. */
export function tagSummary(tags: readonly FinderTag[]): string | null {
  if (tags.length === 0) return null;
  return tags.map((t) => t.name).join(", ");
}
