import { useEffect, useRef, useState } from "react";
import { IconFilm, IconLink, IconScreenShare, IconPanelRight, IconFullscreen, IconVideo } from "./Icons";
import "../styles/review-source-start.css";

export type ReviewLiveSourceKind = "screen" | "window" | "region" | "ndi";
type Props = {
  inSession: boolean;
  onImportFile: () => void;
  onLoadUrl: (url: string) => void;
  onChooseLiveSource: (kind: ReviewLiveSourceKind) => void;
};

/** Source selection only. Capture and room publication keep their explicit
 * confirmation steps in the existing source settings flow. */
export function ReviewSourceStart({ inSession, onImportFile, onLoadUrl, onChooseLiveSource }: Props) {
  const [enteringLink, setEnteringLink] = useState(false);
  const [url, setUrl] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (enteringLink) input.current?.focus(); }, [enteringLink]);
  const back = () => { setEnteringLink(false); requestAnimationFrame(() => linkButton.current?.focus()); };
  const sources = [
    { kind: "screen", label: "Screen", detail: "An entire display", icon: IconScreenShare },
    { kind: "window", label: "Window", detail: "One application window", icon: IconPanelRight },
    { kind: "region", label: "Region", detail: "An area you select", icon: IconFullscreen },
    { kind: "ndi", label: "NDI", detail: "An editor or network feed", icon: IconVideo },
  ] as const;
  return <section className="cp-review-source-start" aria-label="Choose a review source">
    <header>
      <h3>{enteringLink ? "Share a link" : "What would you like to share?"}</h3>
      <p>{enteringLink ? "Paste the video URL below." : inSession
        ? "Choose a source for your session. Live sources preview privately before sharing."
        : "Start with a file, a link or a live source. Your preview stays on this Mac."}</p>
    </header>
    {enteringLink ? <form className="cp-review-source-link" onSubmit={event => {
      event.preventDefault();
      if (url.trim()) onLoadUrl(url.trim());
    }} onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); back(); }
    }}>
      <label htmlFor="review-start-url">Video URL</label>
      <input ref={input} id="review-start-url" type="url" placeholder="https://…" required
        value={url} onChange={event => setUrl(event.target.value)} autoComplete="off" spellCheck={false} />
      <div className="cp-review-source-link-actions">
        <button type="button" className="btn btn-ghost" onClick={back}>Back</button>
        <button type="submit" className="btn" disabled={!url.trim()}>Open link</button>
      </div>
    </form> : <div className="cp-review-source-choices">
      <button type="button" className="btn cp-review-source-choice" onClick={onImportFile}>
        <span aria-hidden><IconFilm size={20} /></span><span><strong>Local file</strong>{" "}<small>A video or audio file</small></span>
      </button>
      <button ref={linkButton} type="button" className="btn cp-review-source-choice" onClick={() => setEnteringLink(true)}>
        <span aria-hidden><IconLink size={20} /></span><span><strong>Link</strong>{" "}<small>Paste a video URL</small></span>
      </button>
      {sources.map(({ kind, label, detail, icon: Glyph }) => <button key={kind} type="button"
        className="btn cp-review-source-choice" onClick={() => onChooseLiveSource(kind)}>
        <span aria-hidden><Glyph size={20} /></span><span><strong>{label}</strong>{" "}<small>{detail}</small></span>
      </button>)}
    </div>}
  </section>;
}
