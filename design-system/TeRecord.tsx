import type { ReactNode } from "react";
import { secondsToTc } from "../src/lib/timecode";
import { teTc } from "./transcript-editor-fixture";
import { TeScrubber } from "./TeScrubber";
import { TeTextSettings, teTextVars, type TeTextStyle } from "./TeTextSettings";

type Props = {
  fps: number; playhead: number; total: number; marks: number[]; note: string;
  onScrub: (program: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  text: TeTextStyle; onText: (style: TeTextStyle) => void; children: ReactNode;
};

/**
 * The RECORD side: the edit's own scrub rail (edit points drawn as ticks),
 * its timecode, and the text settings, above the document.
 */
export function TeRecord(props: Props) {
  return <section className="cp-te-record" aria-label="Edit" style={teTextVars(props.text)}>
    <div className="cp-te-tools">
      <span className="cp-te-tools-note">{props.note}</span>
      <TeScrubber label="Edit position" value={props.playhead} max={props.total} text={teTc(props.playhead, props.fps)} marks={props.marks}
        onScrub={props.onScrub} onScrubStart={props.onScrubStart} onScrubEnd={props.onScrubEnd} />
      <span className="cp-te-tools-tc">{teTc(props.playhead, props.fps)}<span className="cp-te-tools-of"> / {secondsToTc(props.total, props.fps)}</span></span>
      <TeTextSettings pane="Edit" style={props.text} onChange={props.onText} />
    </div>
    {props.children}
  </section>;
}
