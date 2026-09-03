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
/** Discord's wordless mark. FILLED, so it cannot use the shared `Icon`
 *  wrapper, which is stroke-only with fill="none" - drawn through that it
 *  came out as an outline nobody would recognise. Brand artwork, reproduced
 *  as-is for a link to their service; do not restyle the path. */
export const IconDiscord = ({ size = 16, style, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="none"
    style={{ flexShrink: 0, ...style }}
    className={className}
    aria-hidden
  >
    <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z" />
  </svg>
);

/** A magic wand. The tidy-up control was a generic sparkle, which in this app
 *  already means "AI is present" (it is the AI Summary tab's mark). A wand
 *  says something is about to be DONE to the thing you are looking at, which
 *  is what the button does. */
export const IconWand = (p: IconProps) => (
  <Icon {...p}>
    {/* The stick, tip at the top right. */}
    <path d="M4 20 14.5 9.5" />
    {/* The tip's four-point star. */}
    <path d="M17.5 3.5 18.6 6.4 21.5 7.5 18.6 8.6 17.5 11.5 16.4 8.6 13.5 7.5 16.4 6.4Z" />
    {/* ONE small glint, upper left. There were two; the second sat close
        enough to the stick that at 16px - the only size this is used at - it
        read as a smudge on the shaft rather than as a spark. */}
    <path d="M6.5 4v2.2M5.4 5.1h2.2" />
  </Icon>
);

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
//
// The stem ends SQUARE, the one deliberate change from the supplied drawing's
// 0.875 round caps. On the timeline a mark's stem is a rectangle running the
// full height of the track, so a rounded button and a square mark were two
// shapes claiming to be one thing, and the round ends read as blurry at 16px
// where the cap is under a pixel. Square ends make the button and the mark it
// leaves the same silhouette. Every other measurement is the drawing's.
export const IconMarkIn = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M10.875 15.6504V22.5H13.5V14.3496L10.415 12L13.5 9.6504V1.5H10.875V8.3496L6.0849 12L10.875 15.6504Z"
      fill="currentColor"
      stroke="none"
    />
  </Icon>
);
export const IconMarkOut = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M13.125 15.6504V22.5H10.5V14.3496L13.585 12L10.5 9.6504V1.5H13.125V8.3496L17.9151 12L13.125 15.6504Z"
      fill="currentColor"
      stroke="none"
    />
  </Icon>
);
// Clear both marks — Avid's dialect, which the user asked for by name: the two
// marks SIDE BY SIDE and inverted in colour, rather than the two of them held
// apart by an X. Same glyph as IconMarkIn / IconMarkOut at 0.78, pushed 2.2
// apart so the stems sit adjacent in the middle and the wings still point
// outward, which is what keeps it reading as the same pair as the two buttons
// beside it.
//
// One path, fillRule="evenodd": the plate is the outer subpath and the two
// glyphs are holes in it. That is what "inverted" means here, and it is why
// this cannot be three separate paths.
//
// Sized by looking at it, then CHECKED with arithmetic - because looking at
// it is exactly what missed this the first time. The plate was placed at
// y 3.6 with a height of 20.8, so it ran to 24.4: overflowing the 24
// viewBox, clipped along the bottom, and centred at y 14 while the glyphs
// inside it were centred at 12. That two-unit offset is what read as
// top-heavy. Centred now (1.6..22.4), with 2.19 of padding left and right
// and 2.21 above and below.
// The 0.78 scale is still the balance it was chosen for: tall like the two
// glyphs beside it (a squat wide plate reads as a different family) with a
// knockout thick enough to survive at the 16px this renders at.
export const IconClearMarks = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M6.5 1.6H17.5A3.5 3.5 0 0 1 21 5.1V18.9A3.5 3.5 0 0 1 17.5 22.4H6.5A3.5 3.5 0 0 1 3 18.9V5.1A3.5 3.5 0 0 1 6.5 1.6Z M8.9225 14.8473V20.19H10.97V13.8327L8.5637 12L10.97 10.1673V3.81H8.9225V9.1527L5.1862 12L8.9225 14.8473Z M15.0775 14.8473V20.19H13.03V13.8327L15.4363 12L13.03 10.1673V3.81H15.0775V9.1527L18.8138 12L15.0775 14.8473Z"
      fill="currentColor"
      stroke="none"
      fillRule="evenodd"
    />
  </Icon>
);
// In/out span — the review comment-range tool. Deliberately STILL the "[" /
// "]" bracket dialect the clip marks used to share: a comment range is a
// different thing from a clip range, drawn in a different colour
// (--marker-color, the reviewer's) on the same track, and after the clip
// marks became chevrons this is the glyph that keeps the two apart.
// The comment range: the app's OWN in and out marks, with the span between
// them. It used to be a generic square bracket pair with a dumbbell inside -
// a stroked glyph borrowed from nowhere, sitting one row away from the two
// buttons that leave the real marks on the timeline. Marking an in and an out
// for a comment is the same gesture as marking one for a clip, and it was
// drawn in a different language.
//
// Built from IconMarkIn and IconMarkOut under the transform IconClearMarks
// already uses - x' = 12 + 0.78(x - 12) + dx, y' = 12 + 0.78(y - 12) - so the
// three of them are provably one family rather than three drawings that look
// alike. The transform was checked by reproducing IconClearMarks' published
// coordinates exactly before it was used here.
//
// The one difference from IconClearMarks is the sign of the push. It puts the
// marks 2.2 apart so their stems sit ADJACENT, which is what "clear both"
// means. A range means the opposite: 4.6 apart, with the span drawn between
// the stems. Wings still point outward, so the pair reads as the same two
// marks with something held between them.
//
// Extent x 2.79..21.21 in the 24 viewBox: symmetric padding, and the same
// 3.81..20.19 height as the two glyphs it is made of, so it does not sit
// taller or shorter than its own family.
export const IconRange = (p: IconProps) => (
  <Icon {...p}>
    <path
      d="M6.5225 14.8473V20.19H8.57V13.8327L6.1637 12L8.57 10.1673V3.81H6.5225V9.1527L2.7862 12Z M8.57 11.25H15.43V12.75H8.57Z M17.4775 14.8473V20.19H15.43V13.8327L17.8363 12L15.43 10.1673V3.81H17.4775V9.1527L21.2138 12Z"
      fill="currentColor"
      stroke="none"
    />
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
// Annotation tool glyphs. The toolbar used text labels on the theory that
// five icons over a video read as decoration; in practice five TEXT buttons
// were ~310 unshrinkable px, which is what crushed the palette into a column
// and blew the panel up to a third of the picture. Standard drawing-tool
// iconography carries this in 26px squares; label and hint stay as the
// tooltip and accessible name.
export const IconToolHighlighter = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9 15l-4.5 4.5" />
    <path d="M9.5 8.5l6 6L9 15l-4-2z" />
    <path d="M9.5 8.5L15 3l6 6-5.5 5.5" />
  </Icon>
);
export const IconToolArrow = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 19L18 6" />
    <path d="M10 5h8v8" />
  </Icon>
);
export const IconToolRect = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="6" width="16" height="12" rx="1.5" />
  </Icon>
);
export const IconToolEllipse = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="12" cy="12" rx="8" ry="6" />
  </Icon>
);
export const IconHeart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20.8 5.6a5 5 0 0 0-7.1 0L12 7.3l-1.7-1.7a5 5 0 1 0-7.1 7.1l1.7 1.7L12 21.4l7.1-7.1 1.7-1.7a5 5 0 0 0 0-7z" />
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
/* A filled disc: the platform-standard record mark. The wrapper sets
   fill="none" on the <svg>, which children override freely - several icons in
   this file already do `fill="currentColor" stroke="none"`. Deliberately not
   a red "R": every control glyph here is a 24-viewBox stroke shape, and
   tokens.css states outright that --danger is "heavy for a glyph and fails
   against dark greys", so the colour lives on the button state, not the mark. */
export const IconRecord = (p: IconProps) => (
  <Icon {...p}><circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none" /></Icon>
);

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
