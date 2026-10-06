import { useState } from "react";
import { useBleedHidden } from "../hooks/use-bleed-hidden";
import { setBleedHidden } from "../lib/bleed-hidden";
import { formatError } from "../lib/error-format";

/**
 * Settings ▸ Transcription ▸ Bleed. The one switch for every place a line
 * heard on another mic can be left out (see lib/bleed-hidden). Off by default.
 */
export function BleedSettings() {
  const hide = useBleedHidden();
  const [error, setError] = useState<string | null>(null);
  function flip() {
    setError(null);
    setBleedHidden(!hide).catch((cause) => setError(formatError(cause)));
  }
  return <>
    <div className="cp-pane-row">
      <div className="k">
        Hide bleed
        <span className="desc">Off by default. Every iso mic also picks up the people near it, and Measure mics in AAF Audio labels those copies as bleed. Off, nothing is left out and AAF Audio dims the copies. On, All voices in AAF Audio and String Outs reads each line once, from the mic it was said into, and an assistant's search skips the copies. A person's own tab always shows everything their mic heard.</span>
      </div>
      <div className="v">
        <button className={"cp-toggle-switch" + (hide ? " on" : "")} role="switch" aria-checked={hide} aria-label="Hide bleed" onClick={flip} />
      </div>
    </div>
    {error && <p className="cp-settings-note" role="alert">{error}</p>}
  </>;
}
