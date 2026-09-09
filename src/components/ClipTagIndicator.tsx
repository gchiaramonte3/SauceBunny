import type { FinderTag } from "../bindings/FinderTag";
import { primarySwatch } from "../lib/finder-tags";

/** Passive Finder metadata. The containing clip supplies the full tag description.
 * Never fetch tags here: a shelf reads its represented files in one batch. */
export function ClipTagIndicator({ tags, variant }: {
  tags?: readonly FinderTag[];
  variant: "dot" | "stripe";
}) {
  const swatch = primarySwatch(tags ?? []);
  return swatch ? <span
    className={`cp-clip-tag ${variant === "dot" ? "cp-clip-tag-dot" : "cp-clip-tag-stripe"}`}
    style={{ backgroundColor: swatch.hex }}
    aria-hidden="true"
  /> : null;
}
