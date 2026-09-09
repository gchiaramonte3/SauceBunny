import { useState, type CSSProperties } from "react";
import { ClipTagIndicator } from "../src/components/ClipTagIndicator";
import { IconFilm } from "../src/components/Icons";
import { TAG_COLORS, tagSummary } from "../src/lib/finder-tags";
import type { FinderTag } from "../src/bindings/FinderTag";

const clips: { name: string; tags: FinderTag[] }[] = [
  ...TAG_COLORS.map((color) => ({ name: `${color.label}_clip.mov`, tags: [{ name: color.label, color: color.index }] })),
  { name: "Untagged_clip.mov", tags: [] },
  { name: "Custom_label_only.mov", tags: [{ name: "Archive", color: 0 }] },
  { name: "Multiple_tags_with_a_very_long_filename_東京.mov", tags: [
    { name: "Red", color: 1 }, { name: "Purple", color: 1 }, { name: "Client selects", color: 0 },
  ] },
];

/** Real passive production indicator; surrounding clip markup is an isolated
 * fixture. Do not mount LibraryCard: its media/store dependencies are not pure. */
export function ClipTagExamples() {
  const [selected, setSelected] = useState("Purple_clip.mov");
  return <section className="cp-ds-stack cp-ds-clip-tags" data-testid="clip-tag-examples" aria-label="Adopted Finder clip indicators">
    <h3>Finder clip colors · adopted</h3>
    <p>Production indicator and CSS, with fixture clip markup. All seven Finder colors;
      one primary color per clip. Select an example or focus it with the keyboard.
      No files are read or changed. Folders retain their existing tinted icons.</p>
    <div className="cp-ds-clip-tag-grid" role="group" aria-label="Thumbnail tag examples">
      {clips.map(({ name, tags }) => <button key={name} type="button"
        className={`cp-lib-card${selected === name ? " selected" : ""}`}
        aria-pressed={selected === name} onClick={() => setSelected(name)}
        title={`${name}${tags.length ? `\nFinder tags: ${tagSummary(tags)}` : ""}`}
        aria-description={tags.length ? `Finder tags: ${tagSummary(tags)}` : undefined}
      >
        <span className="cp-lib-card-art"><span className="cp-lib-card-ph"><IconFilm size={22} /></span></span>
        <span className="cp-lib-card-caption"><ClipTagIndicator tags={tags} variant="dot" /><span className="cp-lib-card-title">{name}</span></span>
        <span className="cp-lib-card-detail">Fixture clip</span>
      </button>)}
    </div>
    <div className="cp-ds-clip-tag-list">
      <div className="cp-lib-list" role="group" aria-label="List tag examples" style={{ "--lrow-cols": "34px minmax(0, 1fr) 64px" } as CSSProperties}>
        <div className="cp-lib-list-head"><span className="cp-lib-lrow-art" /><span>Name</span><span>Size</span></div>
        {clips.map(({ name, tags }) => <button key={name} type="button"
          className={`cp-lib-lrow${selected === name ? " selected" : ""}`}
          aria-pressed={selected === name} onClick={() => setSelected(name)}
          title={`${name}${tags.length ? `\nFinder tags: ${tagSummary(tags)}` : ""}`}
          aria-description={tags.length ? `Finder tags: ${tagSummary(tags)}` : undefined}
        >
          <ClipTagIndicator tags={tags} variant="stripe" />
          <span className="cp-lib-lrow-art"><IconFilm size={13} /></span>
          <span className="cp-lib-lrow-name">{name}</span><span className="cp-lib-lrow-size">428 MB</span>
        </button>)}
      </div>
    </div>
  </section>;
}
