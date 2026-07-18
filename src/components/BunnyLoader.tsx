/**
 * BunnyLoader — the branded loading indicator for SCREEN-level waits (prep
 * overlay, stream buffering). Buttons keep their compact spinners.
 *
 * The Sauce Bunny mark drawn as a STROKE animation: a purple-to-green
 * gradient segment traces all four contours in phase (two ears, body
 * silhouette, inner play triangle), with a soft blurred underlayer and a
 * shorter, fainter comet tail trailing the segment. pathLength=1 normalizes
 * the dash math so every contour animates identically regardless of length.
 *
 * Animation lives in styles/loader.css; reduced motion renders the full
 * outline statically.
 */

// Source of truth: src/assets/saucebunny-outline.svg (the designer's
// SIMPLIFIED single-contour mark, supplied for this loader). Unlike the
// detailed rail asset, each ear here is ONE closed line (no inner contour),
// and the body splits into its outer silhouette + the inner play triangle —
// so a stroke trace reads as the actual logo: one line around the outside
// of everything, plus the triangle. viewBox computed from the paths' bbox.
const EAR_LEFT =
  "M404.31,196.78c-24.76-22.09-72.16-34.5-82.03,8.05-5.07,95.04,85.71,189.95,133.31,267.8-17.75,9.89-34.88,19.56-51.59,30.75-65.45-63.37-126.95-134.85-159.69-220.77-28.35-70.87-10.73-171.73,71.49-194.98,84.17-23.98,159.05,43.18,202.79,108.73,51.62,81.25,82.98,179.43,79.95,276.06,1.54,3.57-29.96-9.79-29.86-8.99,0,0-27.8-6.63-27.8-6.63-20.61-95.75-60.82-194.96-136.57-260.04Z";
const EAR_RIGHT =
  "M927.95,312.77c19.66-36.17,24.45-90.2-32.11-65.69-31.89,14.63-62.81,45.79-84.27,73.62-48.01,60.82-75.79,135.52-94.02,210.15-.52,1.26-1.25,2.13-2.77,1.32,0,0-45.29-25.81-45.29-25.81,89.73-549.41,656.73-417.62,134.26,75.65-5.89-3.78-42.74-22.83-46.96-27.38,51.57-78.78,127.96-158.35,171.18-241.86Z";
const BODY_OUTER =
  "M963.98,745.98c-8.59-26.92-27.71-48.78-52.37-62.36,0,0-192.56-109.71-192.56-109.71-63.03-29.72-161.12-116.17-236.67-87.13-43.09,11.54-78.83,45.98-91.2,88.91-7.65,18.26-4.95,51.45-5.62,70.99,3.65,36.14-10.23,335.35,11.45,361.38,28.42,71.38,123.77,102.64,189.36,64.65,0,0,43.08-24.86,43.08-24.86,27.41-16.39,153.46-89.1,183.6-106.59,74.25-43.7,186.76-85.6,150.91-195.29Z";
const BODY_INNER =
  "M853.8,798.31c-3.4,7.98-9.28,14.76-17.26,19.29-42.62,23.58-173.88,98.98-214.16,121.5-26.64,11.49-76.46,55.95-108.15,41.8-16.62-5.54-28.52-19.42-30.63-36.92,0,0,.04-321.22.04-321.22,0-15.97,10.58-30.05,24.25-36.84,29.23-17.55,61.44,9.19,86.1,22.44,0,0,51.62,29.27,51.62,29.27,12.56,7.18,191.06,108.51,196.21,112.4,14.78,11.03,19.17,31.41,11.99,48.29Z";

const PATHS = [EAR_LEFT, EAR_RIGHT, BODY_OUTER, BODY_INNER];

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
      <svg viewBox="212 63 831 1046" aria-hidden="true">
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
        {/* Persistent base outline: the WHOLE mark stays visible at all
            times — the animated segments are a highlight sweeping over it,
            not the only thing on screen (three disconnected arcs never read
            as the bunny). */}
        <g className="bl-base">
          {PATHS.map((d, i) => (
            <path key={i} d={d} pathLength={1} />
          ))}
        </g>
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
