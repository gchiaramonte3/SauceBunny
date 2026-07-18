/**
 * BunnyLoader — the branded loading indicator for SCREEN-level waits (prep
 * overlay, stream buffering). Buttons keep their compact spinners.
 *
 * The Sauce Bunny mark drawn as a STROKE animation: a purple-to-green
 * gradient segment traces the outline of all three paths in phase (ears +
 * play-triangle body), with a soft blurred underlayer and a shorter, fainter
 * comet tail trailing the segment. pathLength=1 normalizes the dash math so
 * every path animates identically regardless of its true length.
 *
 * Path data is inlined from src/assets/saucebunny.svg (the canonical mark —
 * keep in sync if the asset ever changes). Animation lives in
 * styles/loader.css; reduced motion renders the full outline statically.
 */

// Source of truth: src/assets/saucebunny.svg (viewBox 223 115 808 1024).
const EAR_LEFT =
  "M404.31,238.06c-13.45-10.42-29.79-20.36-46.92-20.6-7.15-.1-14.08,1.35-19.94,5.36-7.97,5.45-13.08,13.87-15.17,23.3-9.34,42.24,29.52,109.82,52.04,146.82,17.17,27.81,34.99,54.65,54.07,81.17l27.2,39.82c-17.75,9.89-34.88,19.56-51.59,30.75-35.03-32.67-66.23-68.13-94.86-106.16-15.26-20.26-29.04-41.21-41.37-63.33-9.28-16.65-17.02-33.37-23.46-51.28-7.27-20.21-11.31-40.73-12.58-62.2-.95-16.16.73-31.33,4.63-46.96,10.22-40.96,38.47-73.73,79.44-85.82,70.02-20.66,135.95,25.11,179.21,77.17,8.51,10.25,16.29,20.3,23.59,31.56,10.87,16.77,20.77,33.78,29.46,51.88,14.3,29.8,25.21,60.46,33.86,92.37,9.39,34.66,15.54,69.73,17.19,105.59.42,9.13.68,17.46-.56,26.23-.09.61-1.2,1.01-1.68.76l-28.18-9.75-27.8-6.63c-9.17-48.28-24.86-93.11-46.22-137.37-13.82-28.64-30.14-55.68-49.51-80.86-12.05-15.67-25.3-29.77-40.84-41.81Z";
const EAR_RIGHT =
  "M927.95,354.05c8.81-18.44,23.27-54.67,5.65-67.9-9.21-6.91-26.78-2.82-37.76,2.21-31.89,14.63-62.81,45.79-84.28,73.63-28.78,37.33-51.13,78.66-67.57,122.72l-7.8,21.79-9.88,32.91-8.77,32.73c-.14.52-.65,1.12-.88,1.35-.33.33-1.12.41-1.89-.03l-45.29-25.81c8.63-66.7,28.8-130.7,60.29-189.67,18.06-33.81,40.5-66.48,67.07-94.05,19.4-20.12,41.04-37.2,65.44-50.78l19.46-9.48c13.92-6.78,28.59-10.1,43.99-12.27,25.55-3.6,53.25,2.1,71.51,20.7,11.43,11.65,18.68,26.13,22.16,42.09,8.07,37.07-.41,72.89-14.79,107.26l-12.24,25.84c-13.84,25.69-28.96,50.16-46,73.88l-24.13,33.58c-24.43,31.38-50.61,60.77-78.29,89.35l-40.2,39.19-39.4-22.11c-2.75-1.54-5.21-2.8-7.56-5.27l16.96-24.51,63.78-85.46,25.4-32.91c15.82-20.5,30.87-40.97,44.83-62.8,7.57-11.84,14.17-23.54,20.21-36.18Z";
const BODY =
  "M963.98,787.26c-3-9.36-7.04-17.47-12.31-25.68-10.11-15.75-23.81-27.41-40.06-36.67l-192.56-109.71-126.28-72.07c-35.41-20.21-70.93-25.59-110.39-15.07-18.14,4.84-34.02,13.29-48.48,25.06-20.45,16.63-35.31,38.49-42.71,63.86-3.02,10.37-5.33,20.26-5.39,31.16l-.23,39.83.12,311.44c0,17.35,4.61,34.15,11.33,49.94,11.79,27.7,33.1,50.28,59.42,64.71,38.69,21.22,92.18,21.72,129.94-.06l43.08-24.86,41.94-24.61,141.67-81.98,100.66-58.45c47.49-27.58,66.84-85.02,50.25-136.84Z";

const PATHS = [EAR_LEFT, EAR_RIGHT, BODY];

type Props = {
  /** Rendered width in px; height follows the mark's aspect. */
  size?: number;
  /** Visually hidden status text for assistive tech. */
  label?: string;
  /** Optional visible line beneath the mark. */
  sublabel?: string;
};

export function BunnyLoader({ size = 96, label = "Loading", sublabel }: Props) {
  return (
    <div
      className="cp-bunny-loader"
      role="status"
      aria-live="polite"
      style={{ ["--bl-size" as string]: `${size}px` }}
    >
      <svg viewBox="223 115 808 1024" aria-hidden="true">
        <defs>
          {/* SVG gradients cannot read CSS variables. These two hex values
              mirror tokens.css --novella-purple (#8627FF) and --ella-green
              (#6CFF8D) — tokens.css carries the reverse note. */}
          <linearGradient id="bl-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#8627FF" />
            <stop offset="1" stopColor="#6CFF8D" />
          </linearGradient>
          {/* SVG blur (not CSS filter) so the glow clips with the svg box. */}
          <filter id="bl-blur" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="14" />
          </filter>
        </defs>
        {/* Feathered glow underlayer: same dash cycle, fat blurred stroke. */}
        <g className="bl-glow" filter="url(#bl-blur)">
          {PATHS.map((d, i) => (
            <path key={i} d={d} pathLength={1} />
          ))}
        </g>
        {/* Comet tail: a shorter, fainter segment trailing the main one. */}
        <g className="bl-tail">
          {PATHS.map((d, i) => (
            <path key={i} d={d} pathLength={1} />
          ))}
        </g>
        {/* Main chasing segment. */}
        <g className="bl-main">
          {PATHS.map((d, i) => (
            <path key={i} d={d} pathLength={1} />
          ))}
        </g>
      </svg>
      <span className="cp-vh">{label}</span>
      {sublabel && <div className="cp-bunny-loader-sub">{sublabel}</div>}
    </div>
  );
}
