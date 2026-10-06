import type { AafOwnership } from "../bindings/AafOwnership";
import { plural } from "../lib/plural";

/**
 * Under the search box: how much bleed the reader is hiding or dimming, the
 * Hide bleed switch (the same one Settings holds, so it reaches String Outs
 * and the assistants too), and the two actions that read media, each only
 * when asked: measuring the mics (their levels) and checking voices (who said
 * the words the levels could not settle).
 */
export function MultitrackBleedBar({ ownership, bleed, hidden, hide, onHide, measuring, onMeasure, checking, onCheckVoices, onCancel, error }: {
  /** Bleed lines in the view; `hidden` says whether the view hides them (All voices with `hide` on) or dims them. */
  ownership: AafOwnership | null; bleed: number; hidden: boolean; hide: boolean; onHide: (hide: boolean) => void;
  measuring: boolean; onMeasure: () => void; checking: boolean; onCheckVoices: () => void; onCancel: () => void; error: string | null;
}) {
  const missing = ownership?.missing.length ?? 0;
  const ready = !!ownership && ownership.measured.length >= 2;
  const unsure = ownership?.counts.unsure ?? 0;
  const busy = measuring || checking;
  return <div className="cp-multitrack-bleed">
    <label title="Leaves lines heard on another mic out of All voices here and in String Outs, and out of an assistant's search. A person's own tab still shows them, dimmed. The same switch is in Settings ▸ Transcription ▸ Bleed."><input type="checkbox" checked={hide} disabled={!ready} onChange={(event) => onHide(event.target.checked)} />Hide bleed</label>
    <span className="cp-multitrack-note" role="status">
      {measuring ? "Measuring each mic's level. This reads the media once."
        : checking ? "Listening to each owner's voice and the lines the levels could not settle."
          : !ready ? "Measure the mics to tell each person's lines from the bleed of their neighbours."
            : !bleed ? "No bleed found."
              : `${bleed} ${bleed === 1 ? "line" : "lines"} heard on another mic ${hidden ? "hidden" : "dimmed"}.`}
      {!busy && ready && missing > 0 && ` ${missing} ${missing === 1 ? "mic is" : "mics are"} not measured yet.`}
      {!busy && ready && (ownership?.voices ?? 0) > 0 && ` Voices checked for ${plural(ownership?.voices ?? 0, "person", "people")}.`}
      {!busy && ready && ownership?.separation_db != null && ownership.separation_db < 3 && ` These mics hear each other almost equally (a shared line is about ${ownership.separation_db.toFixed(1)} dB louder on one than the next), so levels settle few lines${(ownership.voices ?? 0) > 0 ? "" : "; Check voices can do more"}.`}
    </span>
    {busy ? <button type="button" className="btn btn-ghost" onClick={onCancel}>{measuring ? "Stop measuring" : "Stop checking"}</button>
      : <>{(!ready || missing > 0) && <button type="button" className="btn btn-ghost" onClick={onMeasure}>Measure mics</button>}
        {ready && unsure > 0 && <button type="button" className="btn btn-ghost" title="Learns each mic owner's voice from this sequence and listens to the words the levels could not settle. Voiceprints stay on this Mac." onClick={onCheckVoices}>Check voices</button>}</>}
    {error && <span className="cp-multitrack-note" role="alert">{error}</span>}
    {!!ownership?.warnings.length && <ul className="cp-multitrack-bleed-warnings">{ownership.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
  </div>;
}
