import { pathKey, repathKey } from "./repath";

/**
 * Columns the USER invents, holding whatever they want to write per clip.
 *
 * This is Avid's bin, brought over deliberately. In Media Composer a bin in
 * Text view is a database you shape: you click the empty space to the right of
 * the last heading, type a name, and you have a new column that holds
 * arbitrary text against every clip. Editors use them for scene, take, circle
 * takes, who is on camera, whether a shot is approved. The built-in columns
 * are whatever the software happened to know about the file; the custom ones
 * are what the CUT is about, and that is the half our library was missing.
 *
 * Two rules carry most of the weight here.
 *
 * A COLUMN'S ID IS NOT ITS LABEL. Renaming a column must not orphan a single
 * thing anyone typed into it, and it is the obvious way to lose all of it: if
 * values were keyed by "Scene" then renaming the column to "Sc." silently
 * empties it. So values are keyed by an opaque id and the label is just how it
 * is drawn.
 *
 * A CUSTOM ID CANNOT COLLIDE WITH A BUILT-IN COLUMN. Custom and built-in keys
 * share one namespace, because a custom column is deliberately just another
 * column as far as the width/order/visibility model is concerned - that is
 * what lets it be resized, reordered and hidden with no new machinery. The
 * collision is prevented STRUCTURALLY, by the `c:` prefix, rather than by a
 * denylist of reserved words that someone has to remember to extend when a
 * new built-in column is added. A denylist that goes stale fails by letting a
 * user-made "size" column overwrite the real one's width and render in its
 * place, which would look like the app corrupting itself.
 */

/** The `c:` prefix is the whole collision defence. Nothing else guards it. */
const ID_PREFIX = "c:";

/** Long enough to say what it is, short enough to fit a column heading. */
export const MAX_LABEL = 32;
/** A column cell is a label, not a notes field. The reader panel is where
 *  prose belongs, and an unbounded value here is an unbounded localStorage. */
export const MAX_VALUE = 200;

export type CustomColumn = {
  /** Opaque and stable. Always starts with `c:`. */
  id: string;
  label: string;
};

/** path -> column id -> text. Paths are NFC (see repath.pathKey). */
export type CustomValues = Record<string, Record<string, string>>;

export const COLUMNS_KEY = "saucebunny.libraryCustomColumns";
export const VALUES_KEY = "saucebunny.libraryCustomValues";

/** Whether a column key belongs to the user rather than to the app. */
export function isCustomKey(key: string): boolean {
  return key.startsWith(ID_PREFIX);
}

function newId(): string {
  const rand = globalThis.crypto?.randomUUID?.();
  // randomUUID needs a secure context. The app always has one; a test
  // environment might not, and falling back beats throwing.
  return ID_PREFIX + (rand ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
}

/** Trim, cap, and collapse inner whitespace so two labels cannot differ by
 *  something invisible. */
export function cleanLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
}

/**
 * Add a column. Returns the unchanged list when the label is empty or already
 * taken, so a caller can tell nothing happened by identity.
 *
 * Case-insensitive uniqueness: two columns headed "Scene" and "scene" are two
 * columns a person cannot tell apart, and the second one is always a mistake.
 */
export function addCustomColumn(cols: readonly CustomColumn[], rawLabel: string): CustomColumn[] {
  const label = cleanLabel(rawLabel);
  if (!label) return cols as CustomColumn[];
  if (cols.some((c) => c.label.toLowerCase() === label.toLowerCase())) return cols as CustomColumn[];
  return [...cols, { id: newId(), label }];
}

/** Rename in place. Values are untouched - they are keyed by id. */
export function renameCustomColumn(
  cols: readonly CustomColumn[], id: string, rawLabel: string,
): CustomColumn[] {
  const label = cleanLabel(rawLabel);
  if (!label) return cols as CustomColumn[];
  if (cols.some((c) => c.id !== id && c.label.toLowerCase() === label.toLowerCase())) {
    return cols as CustomColumn[];
  }
  return cols.map((c) => (c.id === id ? { ...c, label } : c));
}

export function removeCustomColumn(cols: readonly CustomColumn[], id: string): CustomColumn[] {
  return cols.filter((c) => c.id !== id);
}

/**
 * Drop values whose column no longer exists.
 *
 * Deliberately destructive, and it has to be called when a column is deleted.
 * The alternative is keeping every value for every column anyone ever removed,
 * for ever, in a store that CLAUDE.md already records as uncapped and as
 * failing silently when the quota is reached. Deleting a column is the user
 * saying they do not want the data; keeping it invisibly is not kindness, it
 * is a leak they cannot see or clear.
 */
export function pruneCustomValues(values: CustomValues, cols: readonly CustomColumn[]): CustomValues {
  const live = new Set(cols.map((c) => c.id));
  const out: CustomValues = {};
  for (const [path, byCol] of Object.entries(values)) {
    const kept: Record<string, string> = {};
    for (const [id, text] of Object.entries(byCol)) if (live.has(id)) kept[id] = text;
    // An item with nothing left in it is removed rather than kept as `{}`.
    if (Object.keys(kept).length) out[path] = kept;
  }
  return out;
}

/** What this file has in this column, or "". */
export function customValue(values: CustomValues, path: string, id: string): string {
  return values[pathKey(path)]?.[id] ?? "";
}

/**
 * Set one cell. An empty value REMOVES the entry rather than storing "",
 * so clearing a cell costs nothing and the store does not fill with blanks.
 */
export function setCustomValue(
  values: CustomValues, path: string, id: string, raw: string,
): CustomValues {
  const key = pathKey(path);
  const text = raw.replace(/\s+/g, " ").trim().slice(0, MAX_VALUE);
  const current = values[key] ?? {};
  if ((current[id] ?? "") === text) return values;
  const next: Record<string, string> = { ...current };
  if (text) next[id] = text;
  else delete next[id];
  const out = { ...values };
  if (Object.keys(next).length) out[key] = next;
  else delete out[key];
  return out;
}

/** Follow a file that was renamed or moved, so its metadata goes with it. */
export function repathCustomValues(values: CustomValues, from: string, to: string): CustomValues {
  return repathKey(values, from, to);
}

export function loadCustomColumns(): CustomColumn[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "null");
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((c): CustomColumn[] => {
      if (!c || typeof c !== "object") return [];
      const { id, label } = c as Partial<CustomColumn>;
      // A stored id without the prefix is from no build of this app and would
      // defeat the collision defence, so it is dropped rather than adopted.
      if (typeof id !== "string" || !isCustomKey(id)) return [];
      if (typeof label !== "string" || !cleanLabel(label)) return [];
      return [{ id, label: cleanLabel(label) }];
    });
  } catch { return []; }
}

export function saveCustomColumns(cols: readonly CustomColumn[]): void {
  try { localStorage.setItem(COLUMNS_KEY, JSON.stringify(cols)); } catch { /* quota */ }
}

export function loadCustomValues(): CustomValues {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(VALUES_KEY) ?? "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: CustomValues = {};
    for (const [path, byCol] of Object.entries(raw as Record<string, unknown>)) {
      if (!byCol || typeof byCol !== "object" || Array.isArray(byCol)) continue;
      const kept: Record<string, string> = {};
      for (const [id, text] of Object.entries(byCol as Record<string, unknown>)) {
        if (isCustomKey(id) && typeof text === "string" && text) kept[id] = text.slice(0, MAX_VALUE);
      }
      // Normalised on READ as well as write, so a store written before the
      // key was canonicalised migrates itself rather than going missing for
      // every accented filename. CLAUDE.md records three bugs from exactly
      // this, all silent.
      if (Object.keys(kept).length) out[pathKey(path)] = kept;
    }
    return out;
  } catch { return {}; }
}

export function saveCustomValues(values: CustomValues): void {
  try { localStorage.setItem(VALUES_KEY, JSON.stringify(values)); } catch { /* quota */ }
}
