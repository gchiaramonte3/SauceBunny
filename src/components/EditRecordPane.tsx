import type { ReactNode } from "react";
import { EditScrubber } from "./EditScrubber";
import { EditTextSettings, editTextVars, type EditTextStyle } from "./EditTextSettings";

type Props = {
  playhead: number; total: number; tc: string; totalTc: string; marks: number[];
  onScrub: (program: number) => void; onScrubStart: () => void; onScrubEnd: () => void;
  text: EditTextStyle; onText: (style: EditTextStyle) => void; children: ReactNode;
};

/**
 * The RECORD side: the edit's own scrub rail (edit points drawn as ticks),
 * its timecode and the text settings, above the edit's transcript.
 */
export function EditRecordPane(props: Props) {
  return <section className="cp-te-record" aria-label="Edit" style={editTextVars(props.text)}>
    <div className="cp-te-tools">
      <EditScrubber label="Edit position" value={props.playhead} max={props.total} text={props.tc} marks={props.marks}
        onScrub={props.onScrub} onScrubStart={props.onScrubStart} onScrubEnd={props.onScrubEnd} />
      <span className="cp-te-tools-tc">{props.tc}<span className="cp-te-tools-of"> / {props.totalTc}</span></span>
      <EditTextSettings pane="Edit" style={props.text} onChange={props.onText} />
    </div>
    {props.children}
  </section>;
}
