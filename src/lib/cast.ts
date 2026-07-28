/**
 * Cast collections — a reusable named set of speakers.
 *
 * THE PROBLEM. Speaker names are per-transcript, keyed by the source's path.
 * That is correct for a one-off interview and hostile for a series: a show
 * with twenty-six recurring people means retyping twenty-six names, and
 * re-picking twenty-six colours, for every single episode. Worse, nothing
 * makes the second episode agree with the first, so the same person ends up
 * "Carmy", "carmy" and "Carmen" across a season, in three different colours,
 * and every downstream artefact (captions, exports, the AI summary) inherits
 * the drift.
 *
 * A cast is just a saved list of {name, colour, avatar}. Applying one WRITES
 * INTO the existing per-transcript overrides — `global[tag]` for the name and
 * `colors[tag]` for the pip — and then the cast is out of the loop. There is
 * no live link, no sync, no "this transcript belongs to that cast" ownership.
 *
 * WHY NO LIVE LINK, given that a link is the obvious design. Because the two
 * things it would buy (rename once, update everywhere; add a member and see it
 * appear) are worth less than the thing it would cost: a transcript whose
 * speaker names can change without the user touching that transcript. This app
 * exports SRTs and burns captions. A name that silently changes under an
 * already-delivered export is a correctness bug, not a convenience. So the
 * apply is a COPY, and `castRef` below is a breadcrumb for the UI ("applied
 * from The Bear S3"), never a source of truth to read names back from.
 *
 * WHY MATCHING IS DELIBERATELY DUMB. Only an exact name match (trimmed,
 * case-folded, whitespace-collapsed) is offered automatically. Fuzzy matching
 * a diarizer's "SPEAKER_04" against a cast list has no signal to work from —
 * any similarity score would be inventing a link — and the failure mode is
 * again dialogue attributed to the wrong person. Everything the auto-match
 * cannot prove, a human assigns.
 */

export type CastMember = {
  id: string;
  name: string;
  /** Hex pip colour. Written into `SpeakerOverrides.colors` on apply. */
  color: string;
  /**
   * Optional face, as a self-contained `data:` URL.
   *
   * Inline rather than a file path because a cast has to survive the source
   * footage being moved, renamed, archived or deleted — a path would leave a
   * roster of broken images. Kept small (96px, JPEG) precisely so inlining is
   * affordable; `MAX_AVATAR_BYTES` is the hard limit, enforced on save.
   */
  avatar: string | null;
};

export type Cast = {
  id: string;
  name: string;
  updatedAt: number;
  members: CastMember[];
};

/** What the picker needs to know about the transcript's current speakers. */
export type CastTarget = {
  /** Canonical speaker tag to write the override under. */
  tag: string;
  /** Name shown today (a diarizer tag, or an earlier rename). */
  name: string;
  /** Seconds of speech — the picker orders by this, so the leads come first. */
  talkSeconds: number;
};

/** tag → member id, or null for "leave this speaker alone". */
export type CastAssignment = Record<string, string | null>;

/** Roughly 48 KB of base64, which a 96px JPEG at q0.72 sits comfortably under.
 *  A cast of 30 with a face each stays well inside a 2 MB file. */
export const MAX_AVATAR_BYTES = 48 * 1024;
export const MAX_CAST_MEMBERS = 200;
export const MAX_CASTS = 100;

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `c_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/** Fold a name to its comparison form. Trimmed, case-folded, inner whitespace
 *  collapsed — so "  ada  lovelace " and "Ada Lovelace" are the same person,
 *  and nothing else is. */
export function foldName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function newCast(name: string, members: CastMember[] = []): Cast {
  return { id: newId(), name: name.trim() || "Untitled cast", updatedAt: Date.now(), members };
}

export function newMember(name: string, color: string, avatar: string | null = null): CastMember {
  return { id: newId(), name: name.trim(), color, avatar };
}

/**
 * Capture the transcript's current speakers as a new cast.
 *
 * The bootstrap path, and the one that matters: you name a cast ONCE, on the
 * episode you were already naming, and every later episode is an apply. Being
 * made to build the roster a second time in a separate manager would defeat
 * the entire feature.
 *
 * Untagged speech is skipped — it is a bucket, not a person.
 */
export function castFromSpeakers(
  castName: string,
  speakers: readonly { tag: string; name: string; color: string; skip?: boolean }[],
): Cast {
  const seen = new Set<string>();
  const members: CastMember[] = [];
  for (const s of speakers) {
    if (s.skip) continue;
    const folded = foldName(s.name);
    // A cast with two "Ada"s cannot be applied unambiguously, and the second
    // one is nearly always a merge the user has not made yet.
    if (!folded || seen.has(folded)) continue;
    seen.add(folded);
    members.push(newMember(s.name, s.color));
    if (members.length >= MAX_CAST_MEMBERS) break;
  }
  return newCast(castName, members);
}

/**
 * Pre-fill the assignment grid with matches we can PROVE.
 *
 * Exact folded-name equality only, and each member claims at most one speaker
 * (first by the order given, which the picker sorts by talk time — so if two
 * speakers somehow fold to one name, the lead wins the match and the bit part
 * is left for a human).
 */
export function autoMatch(cast: Cast, targets: readonly CastTarget[]): CastAssignment {
  const byName = new Map<string, CastMember>();
  for (const m of cast.members) {
    const folded = foldName(m.name);
    if (folded && !byName.has(folded)) byName.set(folded, m);
  }
  const claimed = new Set<string>();
  const out: CastAssignment = {};
  for (const t of targets) {
    const hit = byName.get(foldName(t.name));
    if (hit && !claimed.has(hit.id)) {
      claimed.add(hit.id);
      out[t.tag] = hit.id;
    } else {
      out[t.tag] = null;
    }
  }
  return out;
}

/** The name and colour writes an assignment implies, as plain records to merge
 *  into `SpeakerOverrides.global` / `.colors`. Kept separate from the override
 *  type so this module stays free of the transcript's shapes. */
export type CastApplication = {
  names: Record<string, string>;
  colors: Record<string, string>;
  /** How many speakers actually got a name. Drives the confirm copy. */
  count: number;
};

export function applyAssignment(cast: Cast, assignment: CastAssignment): CastApplication {
  const byId = new Map(cast.members.map((m) => [m.id, m]));
  const names: Record<string, string> = {};
  const colors: Record<string, string> = {};
  for (const [tag, memberId] of Object.entries(assignment)) {
    if (!memberId) continue;
    const m = byId.get(memberId);
    if (!m || !m.name.trim()) continue;
    names[tag] = m.name.trim();
    colors[tag] = m.color;
  }
  return { names, colors, count: Object.keys(names).length };
}

/**
 * Clamp anything read off disk into the shape the app expects.
 *
 * The casts file lives in the user's Documents folder, where it can be edited,
 * synced, partially written by another machine's iCloud, or restored from a
 * older version of the app. Everything here treats it as untrusted input:
 * wrong types are dropped rather than coerced, and an oversized avatar is
 * discarded rather than allowed to bloat every later write.
 */
export function sanitizeCast(raw: unknown): Cast | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && r.id ? r.id : newId();
  const name = typeof r.name === "string" ? r.name.slice(0, 120) : "";
  if (!name.trim()) return null;
  const updatedAt = typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0;
  const rawMembers = Array.isArray(r.members) ? r.members : [];
  const members: CastMember[] = [];
  for (const rm of rawMembers.slice(0, MAX_CAST_MEMBERS)) {
    if (!rm || typeof rm !== "object") continue;
    const m = rm as Record<string, unknown>;
    const mName = typeof m.name === "string" ? m.name.trim().slice(0, 80) : "";
    if (!mName) continue;
    const color = typeof m.color === "string" && /^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color : "#AAAD98";
    // Only ever a self-contained image data URL. A remote URL here would turn
    // opening the cast manager into a network fetch, in an app that makes none.
    const avatar = typeof m.avatar === "string"
      && m.avatar.startsWith("data:image/")
      && m.avatar.length <= MAX_AVATAR_BYTES
      ? m.avatar
      : null;
    members.push({ id: typeof m.id === "string" && m.id ? m.id : newId(), name: mName, color, avatar });
  }
  return { id, name: name.trim(), updatedAt, members };
}

export function sanitizeCastFile(raw: unknown): Cast[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).casts;
  if (!Array.isArray(list)) return [];
  const out: Cast[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, MAX_CASTS)) {
    const cast = sanitizeCast(item);
    // Duplicate ids would make delete and save ambiguous — keep the first.
    if (cast && !seen.has(cast.id)) { seen.add(cast.id); out.push(cast); }
  }
  return out;
}
