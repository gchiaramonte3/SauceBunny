import { useMemo } from "react";
import type { AafPictureClip } from "../bindings/AafPictureClip";
import type { AafPictureTrack } from "../bindings/AafPictureTrack";
import { fpsToRateKey, framesToTc } from "../lib/marker-time";

type Props = { tracks?: AafPictureTrack[]; viewStart: number; viewEnd: number; span: number; frame: number };

/** Source timecode at a picture clip's in point, from its tape's own timecode. */
export function pictureSourceTimecode(clip: AafPictureClip): string | null {
  const fps = clip.source_timecode_fps, drop = clip.source_drop_frame === true;
  if (clip.source_start_frame === null || !fps) return null;
  const rate = fpsToRateKey(drop ? fps * 1000 / 1001 : fps);
  return rate ? framesToTc(clip.source_start_frame, rate, drop) : null;
}

export function pictureClipTitle(clip: AafPictureClip): string {
  const timecode = pictureSourceTimecode(clip);
  return [clip.name ?? clip.tape_name ?? "Picture clip", clip.tape_name ? `Tape ${clip.tape_name}` : null,
    timecode ? `Source ${timecode}` : null, clip.group ? "Group clip" : null,
    clip.kind === "muted" ? "Muted in Avid" : null, clip.effect ? `Effect ${clip.effect}` : null].filter(Boolean).join(" · ");
}

/** V1 as named blocks where the picture cuts are. Metadata only: no video is decoded or shown. */
export function MultitrackPictureLane({ tracks, viewStart, viewEnd, span, frame }: Props) {
  const track = tracks?.find((candidate) => candidate.physical_track_number === 1 && candidate.clips.length) ?? tracks?.find((candidate) => candidate.clips.length);
  const blocks = useMemo(() => (track?.clips ?? [])
    .filter((clip) => clip.start_frame < viewEnd && clip.start_frame + clip.duration_frames > viewStart)
    .map((clip) => ({ clip, style: {
      left: `${Math.max(0, (clip.start_frame - viewStart) / span * 100)}%`,
      width: `${(Math.min(viewEnd, clip.start_frame + clip.duration_frames) - Math.max(viewStart, clip.start_frame)) / span * 100}%`,
    } })), [track, viewStart, viewEnd, span]);
  if (!track) return null;
  const label = track.physical_track_number ? `V${track.physical_track_number}` : track.name;
  return <div className="cp-multitrack-lane cp-multitrack-picture-lane">
    <div className="cp-multitrack-picture-label" title="Picture cuts from the AAF. Video is not shown.">
      <span className="cp-multitrack-picture-track">{label}</span><span className="cp-multitrack-picture-note">Picture cuts</span>
    </div>
    <div className="cp-multitrack-picture-clips" role="list" aria-label={`Picture cuts on ${label}`}>
      {blocks.map(({ clip, style }, index) => <span role="listitem" key={`${clip.start_frame}:${index}`} style={style} title={pictureClipTitle(clip)}
        className={`cp-multitrack-picture-clip${clip.kind === "muted" ? " is-muted" : ""}${clip.group ? " is-group" : ""}`}>
        <span className="cp-multitrack-picture-clip-name">{clip.name ?? clip.tape_name ?? "Clip"}</span>
      </span>)}
      {frame >= viewStart && frame < viewEnd && <span className="cp-multitrack-playhead" style={{ left: `${(frame - viewStart) / span * 100}%` }} />}
    </div>
  </div>;
}
