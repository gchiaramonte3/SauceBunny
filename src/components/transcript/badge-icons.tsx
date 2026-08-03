import type { ReactElement } from "react";
import { Icon, IconInaudible, IconLyric, IconMusic, IconSfx, type IconProps } from "../Icons";

/**
 * The vocabulary a speaker badge can wear instead of initials.
 *
 * WHY A SET THIS SIZE. Initials fail in exactly the places a badge matters
 * most: a twenty-six person cast where half the names start with the same
 * letter, an unnamed diarizer group that reduces to "S11", and everything in
 * the transcript that is not a person at all. Four non-speech kinds covered
 * the last case and nothing else, which left the picker looking like a
 * four-item stub rather than a vocabulary. A speaker who is the host, or
 * calling in by phone, or the one you keep coming back to, is now sayable.
 *
 * DRAWN FOR 13px, NOT REUSED FROM THE CHROME SET. The toolbar icons in
 * Icons.tsx are drawn for 16px at strokeWidth 1.6 and carry detail that reads
 * there — sprocket holes, gear teeth, a folder's tab. Shrunk into a 26px badge
 * at strokeWidth 2.2 that detail collapses into a grey smudge, which is what
 * "some of these icons suck" actually describes. So every glyph here is a
 * single unmistakable silhouette in at most a handful of strokes, and the ones
 * that could not survive the size (a raised hand, a cat's face, a detailed
 * film strip) were cut rather than shipped as mud.
 *
 * IDS ARE PERSISTED, so they are a contract. `overrides.icons` stores the id
 * verbatim in the review doc; an id that later disappears must not blank a
 * badge, which is why every consumer falls back to initials on an unknown id
 * rather than rendering nothing. Rename a label freely; never an id.
 *
 * PURELY A DISPLAY CHOICE. Wearing a music note does not move anybody's lines
 * into the Music group — the four kind ids below are also group tags, but the
 * icon and the grouping are set through different paths and neither implies
 * the other. The show's band can carry a note without their dialogue being
 * folded into a music bed.
 */

export type BadgeGroup = "Voice" | "People" | "Production" | "Marks" | "Places";

/** The groups in the order the sheet lists them. */
export const BADGE_GROUPS: readonly BadgeGroup[] =
  ["Voice", "People", "Production", "Marks", "Places"];

export type BadgeIconDef = {
  /** Stable, persisted. Never change one. */
  id: string;
  /** What the hover strip and the screen reader say. */
  label: string;
  group: BadgeGroup;
  /** Extra search terms, for when the label is not the word someone types. */
  keywords?: string;
  Glyph: (p: IconProps) => ReactElement;
};

// ── Voice and sound ──────────────────────────────────────────────────────────
// The four kinds come from Icons.tsx: they predate this catalogue and are also
// group tags, so they have one drawing shared with the transcript bubbles.

const Phone = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 3.5c1 0 1.6.5 2 1.6l.8 2.2c.3.9.1 1.5-.6 2l-1 .7c.8 1.9 2.4 3.5 4.3 4.3l.7-1c.5-.7 1.1-.9 2-.6l2.2.8c1.1.4 1.6 1 1.6 2v1.7c0 1.4-1 2.3-2.5 2.3C9.9 19.5 4.5 14.1 4.5 6 4.5 4.5 5.4 3.5 7 3.5z" />
  </Icon>
);

const Megaphone = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10v4l14 5V5L4 10z" />
    <path d="M7 12v6a2 2 0 0 0 4 0v-4.5" />
  </Icon>
);

const Laugh = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M7.5 13.5a5 5 0 0 0 9 0z" />
    <path d="M8.5 9h.01" />
    <path d="M15.5 9h.01" />
  </Icon>
);

const Mute = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 5L6.5 9H3v6h3.5L11 19V5z" />
    <path d="M16 10l5 4" />
    <path d="M21 10l-5 4" />
  </Icon>
);

const Bell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 14 6 10z" />
    <path d="M10 19a2.2 2.2 0 0 0 4 0" />
  </Icon>
);

// ── People ───────────────────────────────────────────────────────────────────

const Person = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </Icon>
);

const People = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="9" cy="8.5" r="3.2" />
    <path d="M2.5 19.5a6.5 6.5 0 0 1 13 0" />
    <circle cx="17" cy="9.5" r="2.4" />
    <path d="M16 15a5.5 5.5 0 0 1 5.5 4" />
  </Icon>
);

const Mic = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3.5" />
  </Icon>
);

const Bubble = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 11.5a8 8 0 0 1-8 8H9l-5 3 1.6-4.5A8 8 0 0 1 13 3.5a8 8 0 0 1 8 8z" />
  </Icon>
);

const Crown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7.5l4.5 4.5L12 4.5l4.5 7.5L21 7.5 19 19H5L3 7.5z" />
  </Icon>
);

/** A flat-topped mask with a chin, NOT a circle: a round smiling face is
 *  already Laughter, and at badge size the outline is the only thing
 *  separating two icons whose insides are both "two eyes and a mouth". */
const Mask = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 3.8h16v6.4c0 5.6-3.6 10-8 10s-8-4.4-8-10V3.8z" />
    <path d="M8.6 9.4h.01" />
    <path d="M15.4 9.4h.01" />
    <path d="M9.4 14.4a3.9 3.9 0 0 0 5.2 0" />
  </Icon>
);

const Robot = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3.5" y="8" width="17" height="11.5" rx="3" />
    <path d="M12 3v5" />
    <path d="M9 14h.01" />
    <path d="M15 14h.01" />
  </Icon>
);

// ── Production ───────────────────────────────────────────────────────────────

const Camera = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="6" width="12.5" height="12" rx="2.5" />
    <path d="M15 10.5l6.5-3.5v10L15 13.5z" />
  </Icon>
);

const Clapper = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="10" width="18" height="10" rx="2" />
    <path d="M3 5.5h18V10H3z" />
    <path d="M9 5.5L7 10" />
    <path d="M15 5.5L13 10" />
  </Icon>
);

const Headphones = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 15.5V12a7.5 7.5 0 0 1 15 0v3.5" />
    <rect x="2.5" y="14" width="4.5" height="6.5" rx="2.2" />
    <rect x="17" y="14" width="4.5" height="6.5" rx="2.2" />
  </Icon>
);

const Screen = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="12.5" rx="2.5" />
    <path d="M12 16.5v4" />
    <path d="M8 20.5h8" />
  </Icon>
);

const Laptop = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4.5" y="5" width="15" height="10" rx="2" />
    <path d="M2 19h20" />
  </Icon>
);

const Pencil = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20l4.5-1.2L19.5 7.8a2.2 2.2 0 0 0-3.1-3.1L5.2 15.5 4 20z" />
  </Icon>
);

const PlayCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M10 8.2l6 3.8-6 3.8z" />
  </Icon>
);

const Film = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <path d="M8.5 4v16" />
    <path d="M15.5 4v16" />
  </Icon>
);

// ── Marks ────────────────────────────────────────────────────────────────────

const Star = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l2.7 5.9 6.3.8-4.6 4.4 1.2 6.2L12 17.4l-5.6 2.9 1.2-6.2L3 9.7l6.3-.8L12 3z" />
  </Icon>
);

const Flag = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 21V3.5" />
    <path d="M6 4h11.5l-2.2 4.2 2.2 4.3H6" />
  </Icon>
);

const Heart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 20.2S4.5 15.4 4.5 10.3A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.1-7.5 9.9-7.5 9.9z" />
  </Icon>
);

const Bookmark = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 3.5h12v17.5l-6-4.6-6 4.6V3.5z" />
  </Icon>
);

const Pin = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 21.5s7-6.6 7-11.4a7 7 0 1 0-14 0c0 4.8 7 11.4 7 11.4z" />
    <circle cx="12" cy="10" r="2.5" />
  </Icon>
);

const Warning = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.2L21.5 20.5h-19L12 3.2z" />
    <path d="M12 10v4" />
    <path d="M12 17.2h.01" />
  </Icon>
);

const Question = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.4 9.4A2.7 2.7 0 0 1 14.7 10c0 1.9-2.6 2.3-2.6 3.8" />
    <path d="M12 17.4h.01" />
  </Icon>
);

const CheckCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M7.8 12.4l2.9 2.9 5.5-6" />
  </Icon>
);

const CrossCircle = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9l6 6" />
    <path d="M15 9l-6 6" />
  </Icon>
);

const Bulb = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8.6 17a6.2 6.2 0 1 1 6.8 0v2.2H8.6V17z" />
    <path d="M10 21.5h4" />
  </Icon>
);

const Quote = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4.5 7.5h5v4a5 5 0 0 1-5 5" />
    <path d="M4.5 7.5v4" />
    <path d="M14.5 7.5h5v4a5 5 0 0 1-5 5" />
    <path d="M14.5 7.5v4" />
  </Icon>
);

const Clock = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 6.8v5.6l3.6 2.1" />
  </Icon>
);

const Eye = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
    <circle cx="12" cy="12" r="2.8" />
  </Icon>
);

// ── Places and things ────────────────────────────────────────────────────────

const Home = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.8 11L12 3.6 21.2 11" />
    <path d="M5.5 9.3V20.5h13V9.3" />
  </Icon>
);

const Car = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 15.5l2.2-6.5h13.6l2.2 6.5v3H3v-3z" />
    <circle cx="7.5" cy="18.5" r="1.7" />
    <circle cx="16.5" cy="18.5" r="1.7" />
  </Icon>
);

const Plane = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2.5l2 8.2 7 3v2.1l-7-1.6-.9 4.8 2.4 2v1.4L12 21.2l-3.5 1.2v-1.4l2.4-2L10 14.2l-7 1.6v-2.1l7-3 2-8.2z" />
  </Icon>
);

const Tree = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3l5.5 7.5H14l4.5 6.5h-13L10 10.5H6.5L12 3z" />
    <path d="M12 17v4.5" />
  </Icon>
);

/** A SMALL disc with eight rays. The four-ray version read as a crosshair:
 *  with a disc that wide and rays that short, the gaps were the shape. */
const Sun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.4v2.3" />
    <path d="M12 19.3v2.3" />
    <path d="M2.4 12h2.3" />
    <path d="M19.3 12h2.3" />
    <path d="M5.4 5.4l1.6 1.6" />
    <path d="M17 17l1.6 1.6" />
    <path d="M18.6 5.4L17 7" />
    <path d="M7 17l-1.6 1.6" />
  </Icon>
);

const Moon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.6A8.6 8.6 0 1 1 9.4 4a7 7 0 0 0 10.6 10.6z" />
  </Icon>
);

const Coffee = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7.5h12v5.5a5 5 0 0 1-10 0V7.5z" />
    <path d="M16 9h2.2a2.6 2.6 0 0 1 0 5.2H16" />
    <path d="M3.5 21h13" />
  </Icon>
);

const Book = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 6.6S9.4 4 3.8 4v13.2c5.6 0 8.2 2.6 8.2 2.6s2.6-2.6 8.2-2.6V4c-5.6 0-8.2 2.6-8.2 2.6z" />
    <path d="M12 6.6v13.2" />
  </Icon>
);

const Globe = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
  </Icon>
);

const Paw = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6.3" cy="11.2" r="2" />
    <circle cx="10.4" cy="7.6" r="2" />
    <circle cx="15.1" cy="7.6" r="2" />
    <circle cx="19.2" cy="11.2" r="2" />
    <path d="M7.8 16.8a4.6 4.6 0 0 1 9.2 0 3.6 3.6 0 0 1-3.6 3.6h-2a3.6 3.6 0 0 1-3.6-3.6z" />
  </Icon>
);

/** Two contours, outer and inner. The single-contour flame was the SAME
 *  silhouette as the water drop below it — round bottom, tapered top — so at
 *  badge size the two icons were interchangeable. The inner tongue is what
 *  makes this one read as fire. */
const Fire = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2.4c.6 3.4 2.6 4.7 4 6.5 1.2 1.6 1.8 3.1 1.8 4.7a5.8 5.8 0 0 1-11.6 0c0-2.2 1-3.8 2.3-5.1.2 1.1.8 2 1.6 2.5C10.4 8.2 11.4 5.3 12 2.4z" />
    <path d="M12 20.6a2.9 2.9 0 0 0 2.9-2.9c0-1.7-1.4-2.7-2.9-4.5-1.5 1.8-2.9 2.8-2.9 4.5a2.9 2.9 0 0 0 2.9 2.9z" />
  </Icon>
);

const Drop = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.2c3.4 4 6 6.9 6 10a6 6 0 0 1-12 0c0-3.1 2.6-6 6-10z" />
  </Icon>
);

const Bolt = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13.2 2.5L5 14h5.6l-1.8 7.5L19 10h-6l1.2-7.5z" />
  </Icon>
);

/**
 * The catalogue itself.
 *
 * The four kinds lead the Voice group because they are the ones that also mean
 * something — every other entry is decoration, and putting decoration first
 * would bury the only four with consequences.
 */
export const BADGE_ICONS: readonly BadgeIconDef[] = [
  { id: "music", label: "Music", group: "Voice", keywords: "song theme score bed", Glyph: IconMusic },
  { id: "lyric", label: "Lyrics", group: "Voice", keywords: "singing vocals sung", Glyph: IconLyric },
  { id: "sfx", label: "Sound effects", group: "Voice", keywords: "sfx noise foley", Glyph: IconSfx },
  { id: "inaudible", label: "Inaudible", group: "Voice", keywords: "unclear crosstalk muffled", Glyph: IconInaudible },
  { id: "phone", label: "Phone", group: "Voice", keywords: "call caller remote dial", Glyph: Phone },
  { id: "megaphone", label: "Announcer", group: "Voice", keywords: "megaphone loud pa tannoy", Glyph: Megaphone },
  { id: "laugh", label: "Laughter", group: "Voice", keywords: "laugh funny joke", Glyph: Laugh },
  { id: "mute", label: "Silence", group: "Voice", keywords: "mute quiet muted off", Glyph: Mute },
  { id: "bell", label: "Alert", group: "Voice", keywords: "bell ring ding notification", Glyph: Bell },

  { id: "person", label: "Person", group: "People", keywords: "someone individual", Glyph: Person },
  { id: "people", label: "Group", group: "People", keywords: "panel audience crowd two", Glyph: People },
  { id: "mic", label: "Host", group: "People", keywords: "microphone interviewer presenter", Glyph: Mic },
  { id: "bubble", label: "Narrator", group: "People", keywords: "voiceover vo speech bubble", Glyph: Bubble },
  { id: "crown", label: "Lead", group: "People", keywords: "star main king queen main", Glyph: Crown },
  { id: "mask", label: "Actor", group: "People", keywords: "theatre drama character role", Glyph: Mask },
  { id: "robot", label: "Synthetic voice", group: "People", keywords: "robot ai tts machine", Glyph: Robot },

  { id: "camera", label: "Camera", group: "Production", keywords: "video shot cam", Glyph: Camera },
  { id: "clapper", label: "Take", group: "Production", keywords: "clapper slate scene shoot", Glyph: Clapper },
  { id: "headphones", label: "Audio", group: "Production", keywords: "headphones sound mix", Glyph: Headphones },
  { id: "screen", label: "Screen", group: "Production", keywords: "monitor display tv", Glyph: Screen },
  { id: "laptop", label: "Computer", group: "Production", keywords: "laptop desk work", Glyph: Laptop },
  { id: "pencil", label: "Edit", group: "Production", keywords: "pencil write note draft", Glyph: Pencil },
  { id: "play", label: "Playback", group: "Production", keywords: "play clip preview", Glyph: PlayCircle },
  { id: "film", label: "Footage", group: "Production", keywords: "film reel movie broll", Glyph: Film },

  { id: "star", label: "Starred", group: "Marks", keywords: "favourite favorite best key", Glyph: Star },
  { id: "flag", label: "Flagged", group: "Marks", keywords: "mark follow up review", Glyph: Flag },
  { id: "heart", label: "Loved", group: "Marks", keywords: "like favourite favorite", Glyph: Heart },
  { id: "bookmark", label: "Bookmark", group: "Marks", keywords: "saved keep later", Glyph: Bookmark },
  { id: "pin", label: "Pinned", group: "Marks", keywords: "location place map", Glyph: Pin },
  { id: "warning", label: "Careful", group: "Marks", keywords: "warning caution issue problem", Glyph: Warning },
  { id: "question", label: "Unsure", group: "Marks", keywords: "question unknown maybe check", Glyph: Question },
  { id: "check", label: "Confirmed", group: "Marks", keywords: "check done approved yes", Glyph: CheckCircle },
  { id: "cross", label: "Rejected", group: "Marks", keywords: "cross no cut remove", Glyph: CrossCircle },
  { id: "bulb", label: "Idea", group: "Marks", keywords: "bulb insight thought light", Glyph: Bulb },
  { id: "quote", label: "Quotable", group: "Marks", keywords: "quote pull soundbite", Glyph: Quote },
  { id: "clock", label: "Timing", group: "Marks", keywords: "clock time late duration", Glyph: Clock },
  { id: "eye", label: "Watch", group: "Marks", keywords: "eye look see visible", Glyph: Eye },

  { id: "home", label: "Home", group: "Places", keywords: "house indoors studio", Glyph: Home },
  { id: "car", label: "Car", group: "Places", keywords: "drive vehicle road", Glyph: Car },
  { id: "plane", label: "Travel", group: "Places", keywords: "plane flight trip airport", Glyph: Plane },
  { id: "tree", label: "Outdoors", group: "Places", keywords: "tree nature park forest", Glyph: Tree },
  { id: "sun", label: "Day", group: "Places", keywords: "sun morning bright weather", Glyph: Sun },
  { id: "moon", label: "Night", group: "Places", keywords: "moon evening late dark", Glyph: Moon },
  { id: "coffee", label: "Break", group: "Places", keywords: "coffee cup drink pause", Glyph: Coffee },
  { id: "book", label: "Reading", group: "Places", keywords: "book script notes story", Glyph: Book },
  { id: "globe", label: "World", group: "Places", keywords: "globe earth language international", Glyph: Globe },
  { id: "paw", label: "Animal", group: "Places", keywords: "paw pet dog cat", Glyph: Paw },
  { id: "fire", label: "Hot take", group: "Places", keywords: "fire spicy heat highlight", Glyph: Fire },
  { id: "drop", label: "Water", group: "Places", keywords: "drop rain liquid", Glyph: Drop },
  { id: "bolt", label: "Energy", group: "Places", keywords: "bolt fast power lightning", Glyph: Bolt },
];

const BY_ID = new Map(BADGE_ICONS.map((b) => [b.id, b]));

/** The definition for an id, or null when the id is unknown or "none". */
export function badgeIcon(id: string | null | undefined): BadgeIconDef | null {
  if (!id || id === "none") return null;
  return BY_ID.get(id) ?? null;
}

/**
 * Catalogue entries matching a query, best-first, or everything when blank.
 *
 * Label prefix beats label substring beats keyword, so typing "ph" puts Phone
 * above Headphones instead of alphabetically after it.
 */
export function searchBadgeIcons(query: string): BadgeIconDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...BADGE_ICONS];
  const scored: [number, BadgeIconDef][] = [];
  for (const b of BADGE_ICONS) {
    const label = b.label.toLowerCase();
    let rank = -1;
    if (label.startsWith(q)) rank = 0;
    else if (label.includes(q)) rank = 1;
    else if (b.id.includes(q)) rank = 2;
    else if (b.keywords?.includes(q)) rank = 3;
    if (rank >= 0) scored.push([rank, b]);
  }
  // Stable within a rank: the catalogue order is deliberate and worth keeping.
  return scored
    .map((s, i) => [s[0], i, s[1]] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map((s) => s[2]);
}
