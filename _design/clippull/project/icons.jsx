// icons.jsx — small stroke line icons in the spirit of Ella's iconography.
// Thin stroke 1.6, rounded line ends, square geometry. No emoji.

const Icon = ({ size = 16, stroke = 'currentColor', strokeWidth = 1.6, children, style = {} }) => (
  <svg
    width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke={stroke} strokeWidth={strokeWidth}
    strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0, ...style }}
  >
    {children}
  </svg>
);

const IconLink = (p) => (
  <Icon {...p}>
    <path d="M10 14a4 4 0 0 1 0-5.66l2.83-2.83a4 4 0 0 1 5.66 5.66l-1.42 1.41" />
    <path d="M14 10a4 4 0 0 1 0 5.66l-2.83 2.83a4 4 0 0 1-5.66-5.66l1.42-1.41" />
  </Icon>
);
const IconSettings = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.39.04.78.13 1.15.27l.36.13A2 2 0 0 1 21 11v2a2 2 0 0 1-2 2h-.09" />
  </Icon>
);
const IconPlay = (p) => (
  <Icon {...p}>
    <path d="M6 4l14 8-14 8V4z" fill="currentColor" stroke="none" />
  </Icon>
);
const IconPause = (p) => (
  <Icon {...p}>
    <rect x="6" y="4" width="4" height="16" rx="0.5" fill="currentColor" stroke="none" />
    <rect x="14" y="4" width="4" height="16" rx="0.5" fill="currentColor" stroke="none" />
  </Icon>
);
const IconSkipBack = (p) => (
  <Icon {...p}>
    <polygon points="19 20 9 12 19 4" fill="currentColor" stroke="none" />
    <line x1="5" y1="4" x2="5" y2="20" />
  </Icon>
);
const IconSkipForward = (p) => (
  <Icon {...p}>
    <polygon points="5 4 15 12 5 20" fill="currentColor" stroke="none" />
    <line x1="19" y1="4" x2="19" y2="20" />
  </Icon>
);
const IconChevronDown = (p) => (
  <Icon {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Icon>
);
const IconCheck = (p) => (
  <Icon {...p} strokeWidth={2.4}>
    <polyline points="5 12.5 10 17.5 19 7" />
  </Icon>
);
const IconAlert = (p) => (
  <Icon {...p}>
    <line x1="12" y1="8" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12" y2="17" />
    <circle cx="12" cy="12" r="9" />
  </Icon>
);
const IconFilm = (p) => (
  <Icon {...p}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="7" y1="3" x2="7" y2="21" />
    <line x1="17" y1="3" x2="17" y2="21" />
    <line x1="3" y1="9" x2="7" y2="9" />
    <line x1="3" y1="15" x2="7" y2="15" />
    <line x1="17" y1="9" x2="21" y2="9" />
    <line x1="17" y1="15" x2="21" y2="15" />
  </Icon>
);
const IconFolder = (p) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
  </Icon>
);
const IconClipboard = (p) => (
  <Icon {...p}>
    <rect x="8" y="3" width="8" height="4" rx="1" />
    <path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" />
  </Icon>
);
const IconReveal = (p) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    <path d="M12 11v6" />
    <path d="M9 14l3 3 3-3" />
  </Icon>
);
const IconClose = (p) => (
  <Icon {...p}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="6" y1="18" x2="18" y2="6" />
  </Icon>
);
const IconCaptions = (p) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 11h3" />
    <path d="M7 14h2" />
    <path d="M13 11h4" />
    <path d="M13 14h3" />
  </Icon>
);
const IconCrop = (p) => (
  <Icon {...p}>
    <path d="M6 2v14a2 2 0 0 0 2 2h14" />
    <path d="M2 6h14a2 2 0 0 1 2 2v14" />
  </Icon>
);

Object.assign(window, {
  Icon, IconLink, IconSettings, IconPlay, IconPause,
  IconSkipBack, IconSkipForward, IconChevronDown, IconCheck,
  IconAlert, IconFilm, IconFolder, IconClipboard, IconReveal,
  IconClose, IconCaptions, IconCrop,
});
