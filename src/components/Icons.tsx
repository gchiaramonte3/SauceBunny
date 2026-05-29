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
export const IconFilm = (p: IconProps) => (
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
