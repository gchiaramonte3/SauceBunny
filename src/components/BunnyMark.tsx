import { BUNNY_PATHS, BUNNY_VIEWBOX } from "./BunnyLoader";

/** The static bunny outline (11a): a crisp inline-SVG placeholder mark for
 *  player empty/audio states - replaces the tiny raster-looking film glyph.
 *  Quiet by design: fg-4 stroke at low opacity, sized by the caller. */
export function BunnyMark({ size = 96 }: { size?: number }) {
  return (
    <svg
      viewBox={BUNNY_VIEWBOX}
      width={size}
      height={(size * 1046) / 831}
      aria-hidden="true"
      className="cp-bunny-mark"
    >
      {BUNNY_PATHS.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
