import type { CSSProperties, ReactNode } from "react";

type IconProps = {
  size?: number;
  stroke?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
};

/** Exported so the badge-icon set can be drawn on the same geometry rather
 *  than re-declaring the svg attributes and drifting from it. */
export type { IconProps };
export const Icon = ({ size = 16, stroke = "currentColor", strokeWidth = 1.6, style, className, children }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={stroke}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ flexShrink: 0, ...style }}
    className={className}
  >
    {children}
  </svg>
);

export const IconLink = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10 14a4 4 0 0 1 0-5.66l2.83-2.83a4 4 0 0 1 5.66 5.66l-1.42 1.41" />
    <path d="M14 10a4 4 0 0 1 0 5.66l-2.83 2.83a4 4 0 0 1-5.66-5.66l1.42-1.41" />
  </Icon>
);
export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.39.04.78.13 1.15.27l.36.13A2 2 0 0 1 21 11v2a2 2 0 0 1-2 2h-.09" />
  </Icon>
);
export const IconPlay = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4l14 8-14 8V4z" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconPause = (p: IconProps) => (
  <Icon {...p}>
    <rect x="6" y="4" width="4" height="16" rx="0.5" fill="currentColor" stroke="none" />
    <rect x="14" y="4" width="4" height="16" rx="0.5" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconSkipBack = (p: IconProps) => (
  <Icon {...p}>
    <polygon points="19 20 9 12 19 4" fill="currentColor" stroke="none" />
    <line x1="5" y1="4" x2="5" y2="20" />
  </Icon>
);
export const IconSkipForward = (p: IconProps) => (
  <Icon {...p}>
    <polygon points="5 4 15 12 5 20" fill="currentColor" stroke="none" />
    <line x1="19" y1="4" x2="19" y2="20" />
  </Icon>
);
export const IconChevronDown = (p: IconProps) => (
  <Icon {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Icon>
);
export const IconCheck = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.4}>
    <polyline points="5 12.5 10 17.5 19 7" />
  </Icon>
);
export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <line x1="12" y1="8" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12" y2="17" />
    <circle cx="12" cy="12" r="9" />
  </Icon>
);
// ── StatefulButton glyphs ──────────────────────────────────────────────
// Spinner arc — a ~70% stroked circle; the whole SVG rotates via the
// `cp-sbtn-spin` keyframe (see buttons.css). `pathLength` normalises the
// dash math regardless of radius.
export const IconSpinnerArc = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.2} className={"cp-sbtn-spin" + (p.className ? " " + p.className : "")}>
    <circle cx="12" cy="12" r="9" pathLength={100} strokeDasharray="70 100" />
  </Icon>
);
// Circle-check — the mark (`.cp-draw`) draws itself in via a shared
// stroke-dashoffset keyframe keyed on the button's [data-phase]. `pathLength=1`
// normalises the dash so the same CSS drives any geometry.
export const IconCircleCheck = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.2}>
    <circle cx="12" cy="12" r="9" />
    <path className="cp-draw" pathLength={1} d="M8 12.4l2.6 2.6L16 9" />
  </Icon>
);
// Circle-x — same draw technique, two strokes; used with the danger token.
export const IconCircleX = (p: IconProps) => (
  <Icon {...p} strokeWidth={2.2}>
    <circle cx="12" cy="12" r="9" />
    <path className="cp-draw" pathLength={1} d="M9 9l6 6M15 9l-6 6" />
  </Icon>
);
// Film frame — the source/empty-state glyph. Geometry sits on a 1.5-unit
// grid (rails at 7.5/16.5, sprockets at 7.5/16.5, center divider at 12) so
// the strokes land on whole device pixels at the sizes it renders at
// (24 in the sidebar, 32 on the audio card) instead of smearing across
// fractional pixels — the old 22/28px renders read as low-res.
export const IconFilm = (p: IconProps) => (
  <Icon {...p} strokeWidth={1.5}>
    <rect x="3" y="3" width="18" height="18" rx="2.25" />
    <path d="M7.5 3v18M16.5 3v18" />
    <path d="M3 12h18" />
    <path d="M3 7.5h4.5M16.5 7.5H21" />
    <path d="M3 16.5h4.5M16.5 16.5H21" />
  </Icon>
);
export const IconClipboard = (p: IconProps) => (
  <Icon {...p}>
    <rect x="8" y="3" width="8" height="4" rx="1" />
    <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
  </Icon>
);
export const IconReveal = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    <path d="M12 11v6" />
    <path d="M9 14l3 3 3-3" />
  </Icon>
);
/* Undo / redo — a curved arrow doubling back on itself, mirrored. Drawn as a
   pair so the two read as opposites at 14px, where a subtler difference
   disappears. */
export const IconUndo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 9h10a5 5 0 0 1 0 10h-4" />
    <path d="M8 5L4 9l4 4" />
  </Icon>
);
export const IconRedo = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 9H10a5 5 0 0 0 0 10h4" />
    <path d="M16 5l4 4-4 4" />
  </Icon>
);
export const IconDownload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v12" />
    <path d="M7 10l5 5 5-5" />
    <rect x="3" y="17" width="18" height="4" rx="1" />
  </Icon>
);
export const IconSparkles = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2" />
  </Icon>
);
// Sparkles — the AI Summary tab (one bold 4-point sparkle + two accents).
export const IconAiSummary = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0Z" />
    <path d="M20 3v4M22 5h-4M4 17v2M5 18H3" />
  </Icon>
);
// Caption card — the Transcript tab. A subtitle block with two text lines:
// reads "spoken words" rather than "file", and pairs with IconAiSummary's
// sparkle as a sibling (same weight, same simplicity) in the tab strip and
// the two panes' empty states.
export const IconTranscript = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 12h7M7 15.5h10" />
  </Icon>
);
// Docked right panel — the toolbar's side-panel toggle (replaces the Queue
// stack glyph so it doesn't collide with the Queue tab).
export const IconPanelRight = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Icon>
);
export const IconPanelLeft = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </Icon>
);

// Crown — the co-review session host badge.
export const IconCrown = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M3 7l4.5 3.5L12 4l4.5 6.5L21 7l-1.6 11.5a1 1 0 0 1-1 .85H5.6a1 1 0 0 1-1-.85L3 7z" />
  </Icon>
);
// Speech bubble — the Review tab (timecoded comments).
export const IconReview = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.38 8.38 0 0 1 4 11.5 8.5 8.5 0 0 1 12.5 3 8.38 8.38 0 0 1 21 11.5z" />
  </Icon>
);
// Two overlapping speech bubbles — the Co-Review (watch & review together)
// nav destination + lobby mark. Same rounded-rect-with-tail vocabulary as
// IconReview, doubled and offset so it reads as a shared conversation.
export const IconCoReview = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
    <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
  </Icon>
);
// NLE mark pair. A filled stem capped top and bottom, with one chevron wing
// at the waist pointing AWAY from the marked region: "in" points left off the
// start, "out" points right off the end, so the pair frames the range instead
// of enclosing it the way a "[" / "]" would. The two paths are an exact pixel
// mirror (x → 24−x) of one source glyph, scaled from a 16px drawing, so the
// 2.625 stem, 0.875 cap radius and 4.87 wing are identical in both.
// Geometry note: the wing's near edge is notched, which is what keeps it
// reading as a chevron rather than an arrowhead glued to a bar. A mitred
// polyline does not reproduce it (the apex lands ~0.5 short), so this is the
// drawn path transformed, not a redrawing of it.
export const IconMarkIn = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M10.875 15.6504V21.1875C10.875 21.9123 11.4626 22.5 12.1875 22.5C12.9124 22.5 13.5 21.9123 13.5 21.1875V14.3496L10.415 12L13.5 9.6504V2.8125C13.5 2.0876 12.9124 1.5 12.1875 1.5C11.4626 1.5 10.875 2.0876 10.875 2.8125V8.3496L6.0849 12L10.875 15.6504Z"
      fill="currentColor"
      stroke="none"
    />
  </Icon>
);
export const IconMarkOut = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M13.125 15.6504V21.1875C13.125 21.9123 12.5374 22.5 11.8125 22.5C11.0876 22.5 10.5 21.9123 10.5 21.1875V14.3496L13.585 12L10.5 9.6504V2.8125C10.5 2.0876 11.0876 1.5 11.8125 1.5C12.5374 1.5 13.125 2.0876 13.125 2.8125V8.3496L17.9151 12L13.125 15.6504Z"
      fill="currentColor"
      stroke="none"
    />
  </Icon>
);
// Clear both marks. The same mirrored pair at 0.6 scale, pushed 3.8 apart to
// open a 5.8-wide gap, with the X in it. Scaling is uniform so the cap stays
// a circle: squashing the glyph vertically to make room would turn the round
// ends into ellipses and stop it matching the two icons beside it.
export const IconClearMarks = (p: IconProps) => (
  <Icon {...p} strokeWidth={1.8}>
    <path
      d="M7.525 14.1902V17.5125C7.525 17.9474 7.8776 18.3 8.3125 18.3C8.7474 18.3 9.1 17.9474 9.1 17.5125V13.4098L7.249 12L9.1 10.5902V6.4875C9.1 6.0526 8.7474 5.7 8.3125 5.7C7.8776 5.7 7.525 6.0526 7.525 6.4875V9.8098L4.6509 12L7.525 14.1902Z"
      fill="currentColor"
      stroke="none"
    />
    <path
      d="M16.475 14.1902V17.5125C16.475 17.9474 16.1224 18.3 15.6875 18.3C15.2526 18.3 14.9 17.9474 14.9 17.5125V13.4098L16.751 12L14.9 10.5902V6.4875C14.9 6.0526 15.2526 5.7 15.6875 5.7C16.1224 5.7 16.475 6.0526 16.475 6.4875V9.8098L19.3491 12L16.475 14.1902Z"
      fill="currentColor"
      stroke="none"
    />
    <path d="M10.1 10.1l3.8 3.8M13.9 10.1l-3.8 3.8" />
  </Icon>
);
// In/out span — the review comment-range tool. Deliberately STILL the "[" /
// "]" bracket dialect the clip marks used to share: a comment range is a
// different thing from a clip range, drawn in a different colour
// (--marker-color, the reviewer's) on the same track, and after the clip
// marks became chevrons this is the glyph that keeps the two apart.
export const IconRange = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M5 5v14" strokeLinecap="square" />
    <path d="M5 5h4M5 19h4" />
    <path d="M19 5v14" strokeLinecap="square" />
    <path d="M19 5h-4M19 19h-4" />
    <path d="M9 12h6" strokeWidth={2.4} />
    <circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconAspect = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="12" rx="1.5" />
  </Icon>
);
export const IconFullscreen = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 8V4h4" />
    <path d="M20 8V4h-4" />
    <path d="M4 16v4h4" />
    <path d="M20 16v4h-4" />
  </Icon>
);
export const IconFullscreenExit = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 4v4H4" />
    <path d="M16 4v4h4" />
    <path d="M8 20v-4H4" />
    <path d="M16 20v-4h4" />
  </Icon>
);
export const IconCamera = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
    <circle cx="12" cy="13" r="4" />
  </Icon>
);
export const IconMore = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="5" cy="12" r="1.4" />
    <circle cx="12" cy="12" r="1.4" />
    <circle cx="19" cy="12" r="1.4" />
  </Icon>
);
export const IconStack = (p: IconProps) => (
  <Icon {...p}>
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 12 12 17 22 12" />
    <polyline points="2 17 12 22 22 17" />
  </Icon>
);
export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Icon>
);
export const IconPencil = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20l4.5-1.2L19.5 7.8a2.2 2.2 0 0 0-3.1-3.1L5.2 15.5 4 20z" />
  </Icon>
);
export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </Icon>
);
export const IconImport = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </Icon>
);
export const IconVolume = (p: IconProps) => (
  <Icon {...p}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18 6a8 8 0 0 1 0 12" />
  </Icon>
);
export const IconVolumeMuted = (p: IconProps) => (
  <Icon {...p}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
    <line x1="22" y1="9"  x2="16" y2="15" />
    <line x1="16" y1="9"  x2="22" y2="15" />
  </Icon>
);
export const IconBell = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  </Icon>
);
export const IconInfo = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="10" x2="12" y2="17" />
    <line x1="12" y1="7" x2="12" y2="7" strokeLinecap="round" />
  </Icon>
);
export const IconCaptions = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 11h3" />
    <path d="M7 14h2" />
    <path d="M13 11h4" />
    <path d="M13 14h3" />
  </Icon>
);
export const IconHistory = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </Icon>
);
// House — the nav rail's Home (Library) item.
export const IconHome = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9v10a2 2 0 0 0 2 2h3v-6h4v6h3a2 2 0 0 0 2-2V9" />
  </Icon>
);
// Scissors — the nav rail's Clip (editor) item.
export const IconScissors = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.12 15.88" />
    <path d="M14.47 14.48 20 20" />
    <path d="M8.12 8.12 12 12" />
  </Icon>
);
// Magnifier — the Library header search field.
export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m16.2 16.2 4.8 4.8" />
  </Icon>
);
// Plain closed folder — Library collection cards without a poster.
export const IconFolder = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </Icon>
);
// Clockwise refresh — the Library rescan action.
export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M21 4v6h-6" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10" />
  </Icon>
);
// Row-paging chevrons — the Library shelf hover arrows.
export const IconChevronLeft = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    <polyline points="15 6 9 12 15 18" />
  </Icon>
);
export const IconChevronRight = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    <polyline points="9 6 15 12 9 18" />
  </Icon>
);
// 2×2 poster wall — the Library browser's grid-view toggle.
export const IconGrid = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </Icon>
);
// Rows — the Library browser's list-view toggle.
export const IconList = (p: IconProps) => (
  <Icon {...p}>
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3.5" y1="6" x2="3.5" y2="6" strokeLinecap="round" />
    <line x1="3.5" y1="12" x2="3.5" y2="12" strokeLinecap="round" />
    <line x1="3.5" y1="18" x2="3.5" y2="18" strokeLinecap="round" />
  </Icon>
);
export const IconMic = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
  </Icon>
);
export const IconMicOff = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
    <path d="M4 4l16 16" />
  </Icon>
);
export const IconScreenShare = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="13" rx="1.5" />
    <path d="M8 21h8" />
    <path d="M12 17v4" />
    <path d="M12 13V8" />
    <path d="M9.5 10.5L12 8l2.5 2.5" />
  </Icon>
);

/* Movie camera (live webcam), NOT the photo camera: body + side lens wedge.
   The transport snapshot keeps IconCamera; the room's camera toggle uses
   this pair so "save a frame" and "my webcam" stop sharing a glyph. */
export const IconVideo = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="6.5" width="12.5" height="11" rx="2" />
    <path d="M15 10.5l6-3v9l-6-3" />
  </Icon>
);
export const IconVideoOff = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="6.5" width="12.5" height="11" rx="2" />
    <path d="M15 10.5l6-3v9l-6-3" />
    <path d="M4 4l16 16" />
  </Icon>
);

/* Smiley - the room's reactions button. */
export const IconSmile = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
    <path d="M9 9.5h.01" strokeWidth={2.4} />
    <path d="M15 9.5h.01" strokeWidth={2.4} />
  </Icon>
);

/* Solid folder - the Library tree's row glyph (user call: simple, filled,
   no thumbnail box). */
export const IconFolderSolid = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2c.4 0 .8.16 1.08.44L11.3 7h8.2A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11z"
      fill="currentColor"
      stroke="none"
    />
  </Icon>
);

/* ── Non-speech kinds (see lib/speech-kind.ts) ────────────────────────────
   These replace a speaker's initials on the chip, so they are read at 26px
   and smaller. Each one is a single unmistakable silhouette rather than a
   detailed glyph: at that size "two initials vs an icon" is the whole
   distinction being made, and detail just turns to mud. */

/** Music bed — a beamed pair, the shape everyone reads as "music". */
export const IconMusic = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </Icon>
);

/** Sung words — ONE note, deliberately distinct from the beamed pair above,
 *  because "music playing" and "somebody singing words" are the two things a
 *  user most needs to tell apart here. */
export const IconLyric = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 18V6l10-3v12" />
    <circle cx="6" cy="18" r="3" />
  </Icon>
);

/** Sound effect — radiating arcs. Not a speaker cone: a cone reads as
 *  "audio output" (a volume control), which is a different idea. */
export const IconSfx = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 10v4" />
    <path d="M8 7v10" />
    <path d="M12 4v16" />
    <path d="M16 8v8" />
    <path d="M20 11v2" />
  </Icon>
);

/** Inaudible — a struck-through ear-shape reduced to its essentials: a
 *  listening arc that has been cancelled. */
export const IconInaudible = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 9a4 4 0 0 1 7-2.6" />
    <path d="M12 13v2" />
    <path d="M4 4l16 16" />
  </Icon>
);
