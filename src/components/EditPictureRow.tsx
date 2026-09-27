import type { AafPictureClip } from "../bindings/AafPictureClip";
import { isGap, type Timeline } from "../lib/edit-model";
import { pictureClipTitle } from "./MultitrackPictureLane";

type Props = {
  edit: Timeline; starts: number[]; start: number; span: number; x: (t: number) => string; w: (d: number) => string;
  /** A source's V1 clips with their sequence position in seconds. */
  pictureOf: (source: string) => { from: number; to: number; clip: AafPictureClip }[];
};

/**
 * V1 through the edit: the picture cuts each segment carries, where they now
 * play. Metadata only, as in AAF Audio: names and cut points, never video.
 */
export function EditPictureRow({ edit, starts, start, span, x, w, pictureOf }: Props) {
  const blocks = edit.segments.flatMap((segment, index) => isGap(segment) ? [] : pictureOf(segment.source)
    .filter((item) => item.from < segment.srcOut && item.to > segment.srcIn)
    .map((item) => {
      const from = starts[index] + Math.max(0, item.from - segment.srcIn), to = starts[index] + Math.min(segment.srcOut, item.to) - segment.srcIn;
      return { key: `${segment.id}:${item.from}`, from, to, clip: item.clip };
    }))
    .filter((block) => block.to > start && block.from < start + span);
  if (!edit.segments.some((segment) => !isGap(segment) && pictureOf(segment.source).length)) return null;
  return <div className="cp-te-tl-row cp-te-tl-picture">
    <div className="cp-te-tl-head" title="Picture cuts from the AAF. Video is not shown."><span className="cp-te-tl-track is-static">V1</span><span className="cp-te-tl-name">Picture</span></div>
    <div className="cp-te-tl-lane" role="list" aria-label="Picture cuts on V1">
      {blocks.map((block) => <span key={block.key} role="listitem" className={`cp-te-tl-pic${block.clip.kind === "muted" ? " is-muted" : ""}`}
        style={{ left: x(block.from), width: w(block.to - block.from) }} title={pictureClipTitle(block.clip)}>{block.clip.name ?? block.clip.tape_name ?? "Clip"}</span>)}
    </div>
  </div>;
}
