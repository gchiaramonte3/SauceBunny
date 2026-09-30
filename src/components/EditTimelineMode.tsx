type Props = { mode: "source" | "record"; onMode: (mode: "source" | "record") => void };

const LABEL = { source: "Source", record: "Record" } as const;

/**
 * Avid's Toggle Source/Record in Timeline, as two named choices in the
 * timeline's corner (over the track headers, where Media Composer keeps it),
 * so the tool bar is left exactly as it is. Source shows the loaded sequence,
 * every mic and its group alternates; Record shows the string out being cut.
 */
export function EditTimelineMode({ mode, onMode }: Props) {
  return <div className="cp-te-tl-mode" role="radiogroup" aria-label="Timeline shows">
    {(["source", "record"] as const).map((item) => <button key={item} type="button" role="radio" aria-checked={mode === item}
      className="cp-te-tl-mode-choice" title={`${LABEL[item]} in the timeline (⇧T toggles)`} onClick={() => onMode(item)}>{LABEL[item]}</button>)}
  </div>;
}
