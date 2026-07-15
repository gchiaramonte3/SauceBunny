import type { CSSProperties, ReactNode } from "react";

type IconProps = {
  size?: number;
  stroke?: string;
  strokeWidth?: number;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
};

const Icon = ({ size = 16, stroke = "currentColor", strokeWidth = 1.6, style, className, children }: IconProps) => (
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
// Document with text lines — the Transcript tab.
export const IconTranscript = (p: IconProps) => (
  <Icon {...p}>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8M16 13H8M16 17H8" />
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
// Two people — the co-review (watch party) session toggle.
export const IconUsers = (p: IconProps) => (
  <Icon {...p}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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
export const IconMarkIn = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M7 4v16" strokeLinecap="square" />
    <path d="M7 4h6" />
    <path d="M7 20h6" />
    <polygon points="13 8 19 12 13 16" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconMarkOut = (p: IconProps) => (
  <Icon {...p} strokeWidth={2}>
    <path d="M17 4v16" strokeLinecap="square" />
    <path d="M17 4h-6" />
    <path d="M17 20h-6" />
    <polygon points="11 8 5 12 11 16" fill="currentColor" stroke="none" />
  </Icon>
);
export const IconClearMarks = (p: IconProps) => (
  <Icon {...p} strokeWidth={1.8}>
    <path d="M5 5v14M5 5h3M5 19h3" />
    <path d="M19 5v14M19 5h-3M19 19h-3" />
    <path d="M9 9l6 6M15 9l-6 6" />
  </Icon>
);
// In/out span — the review comment-range tool. Same bracket language as
// IconMarkIn / IconMarkOut / IconClearMarks; the duration bar with endpoint
// dots between the brackets reads as "a span", not a mark.
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
