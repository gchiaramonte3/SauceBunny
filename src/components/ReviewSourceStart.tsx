import { useEffect, useId, useRef, useState } from "react";
import { IconFilm, IconImport, IconLink, IconScreenShare, IconPanelRight, IconFullscreen, IconVideo } from "./Icons";
import "../styles/review-source-start.css";

export type ReviewLiveSourceKind = "screen" | "window" | "region" | "ndi";
type Props = {
  inSession: boolean;
  onImportFile: () => void;
  onLoadUrl: (url: string) => void;
  onChooseLiveSource: (kind: ReviewLiveSourceKind) => void;
};

const LIVE = [
  { kind: "screen", label: "Screen", icon: IconScreenShare },
  { kind: "window", label: "Window", icon: IconPanelRight },
  { kind: "region", label: "Region", icon: IconFullscreen },
  { kind: "ndi", label: "NDI", icon: IconVideo },
] as const;

/**
 * The empty Review monitor: an empty state, not a menu. One line saying
 * nothing is up yet, the two ways in that load something here (a file, a
 * link), and the four live sources as tiles below a quiet rule. It replaced
 * a bordered menu of six described rows boxed inside the monitor, which read
 * as a settings page and repeated what the toolbar and the session panel
 * already offer. It sits in the monitor's box, which shrinks with the
 * window, and answers to that box (container queries in its stylesheet):
 * the glyph, then the line under the title, give way before anything scrolls.
 *
 * Source selection only. Capture and room publication keep their explicit
 * confirmation steps in the existing source settings flow.
 */
export function ReviewSourceStart({ inSession, onImportFile, onLoadUrl, onChooseLiveSource }: Props) {
  const [enteringLink, setEnteringLink] = useState(false);
  const [url, setUrl] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { if (enteringLink) input.current?.focus(); }, [enteringLink]);
  const back = () => { setEnteringLink(false); requestAnimationFrame(() => linkButton.current?.focus()); };
  return <section className="cp-review-start" aria-label="Choose a review source">
    <span className="cp-review-start-glyph" aria-hidden="true">{enteringLink ? <IconLink size={20} /> : <IconFilm size={20} />}</span>
    <h3>{enteringLink ? "Paste a link" : inSession ? "Choose what the room sees" : "Nothing on screen yet"}</h3>
    <p className="cp-review-start-line">{enteringLink ? "A video page, or a direct link to a file."
      : inSession ? "Live sources preview privately before you share them." : "Open a file or a link, or share something live."}</p>
    {enteringLink ? <form className="cp-review-start-link" onSubmit={event => {
      event.preventDefault();
      if (url.trim()) onLoadUrl(url.trim());
    }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); back(); }
    }}>
      <label htmlFor={`${id}-url`} className="cp-visually-hidden">Video URL</label>
      <input ref={input} id={`${id}-url`} className="cp-input" type="url" placeholder="https://" required
        value={url} onChange={event => setUrl(event.target.value)} autoComplete="off" spellCheck={false} />
      <div className="cp-review-start-link-actions">
        <button type="button" className="btn btn-ghost" onClick={back}>Back</button>
        <button type="submit" className="btn btn-primary" disabled={!url.trim()}>Open link</button>
      </div>
    </form> : <>
      <div className="cp-review-start-actions">
        <button type="button" className="btn btn-primary" onClick={onImportFile}><IconImport size={14} />Open file…</button>
        <button ref={linkButton} type="button" className="btn btn-ghost" onClick={() => setEnteringLink(true)}><IconLink size={14} />Paste a link</button>
      </div>
      <div className="cp-review-start-live" role="group" aria-labelledby={`${id}-live`}>
        <p id={`${id}-live`} className="cp-review-start-or">Or share live</p>
        <div className="cp-review-start-tiles">
          {LIVE.map(({ kind, label, icon: Glyph }) => <button key={kind} type="button" className="cp-review-start-tile"
            onClick={() => onChooseLiveSource(kind)}>
            <Glyph size={18} /><span>{label}</span>
          </button>)}
        </div>
      </div>
    </>}
  </section>;
}
