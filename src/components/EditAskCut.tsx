import type { ReactNode } from "react";
import type { AskBeat, AskCitation } from "../lib/edit-ask";
import { estimateCut } from "../lib/edit-story";
import { secondsToClock } from "../lib/timecode";

const clock = (seconds: number) => secondsToClock(seconds, { round: true });

/**
 * A proposed story cut (docs/STORY-CUT-SPEC-2026-10-08.md): its running time
 * against the one asked for, then each beat with what it does, how long it
 * runs and its lines, so the editor can read the shape of the story before
 * building it. Times are the ones the model fitted to; the built cut runs a
 * little shorter, with its ums taken out.
 */
export function EditAskCut({ title, target, beats, lines }: { title: string; target: number | null; beats: AskBeat[]; lines: (list: AskCitation[]) => ReactNode }) {
  const estimate = estimateCut(beats);
  const count = beats.reduce((sum, beat) => sum + beat.lines.length, 0);
  return <>
    <p className="cp-te-msg-proposal">{`Cut "${title}": about ${clock(estimate.seconds)}${target ? ` of ${clock(target)} asked for` : ""}, ${beats.length} beat${beats.length === 1 ? "" : "s"}, ${count} line${count === 1 ? "" : "s"}`}</p>
    <ol className="cp-te-msg-beats">
      {beats.map((beat, index) => <li key={`${index}-${beat.title}`} className="cp-te-msg-beat">
        <p className="cp-te-msg-beat-head">{`${index + 1}. ${beat.title} · ${clock(estimate.beats[index])}`}</p>
        {beat.purpose && <p className="cp-te-msg-beat-purpose">{beat.purpose}</p>}
        {lines(beat.lines)}
      </li>)}
    </ol>
  </>;
}
