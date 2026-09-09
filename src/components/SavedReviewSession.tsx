import { useEffect, useRef, useState } from "react";
import { loadScreening } from "../lib/screening-store";
import type { ScreeningDoc } from "../lib/screening";
import { SavedSessionNotes } from "./SavedSessionNotes";

/** Local archive reader: does not join rooms, publish sources or mutate notes. */
export function SavedReviewSession({ id, onBack, onOpenMedia }: {
  id: string; onBack: () => void; onOpenMedia: (path: string) => void;
}) {
  const [result, setResult] = useState<{ doc: ScreeningDoc | null } | null>(null);
  const [selected, setSelected] = useState(0);
  const [retry, setRetry] = useState(0);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true;
    void loadScreening(id).then(doc => { if (alive) setResult({ doc }); })
      .catch(() => { if (alive) setResult({ doc: null }); });
    backRef.current?.focus();
    return () => { alive = false; };
  }, [id, retry]);
  const doc = result?.doc;
  const segment = doc?.segments[selected];
  return <section className="cp-session-reader" aria-label="Saved review session"
    onKeyDown={e => { if (e.key === " " || e.key === "Enter") e.stopPropagation(); }}>
    <header className="cp-session-reader-head">
      <button ref={backRef} type="button" className="btn btn-ghost" onClick={onBack}>Back to sessions</button>
      <h2>{doc?.title ?? "Saved session"}</h2>
      {doc && <span>{doc.participants.map(p => p.name).join(", ") || "No participants recorded"}</span>}
    </header>
    {!result && <p role="status">Loading saved session…</p>}
    {result && !doc && <div className="cp-pane-empty"><h3 className="cp-pane-empty-title">Session unavailable</h3>
      <p className="cp-pane-empty-body">The saved session could not be read. No notes or records were changed.</p>
      <button type="button" className="btn" onClick={() => { setResult(null); setRetry(n => n + 1); }}>Retry</button></div>}
    {doc && doc.segments.length > 1 && <label className="cp-session-source-picker">Source reviewed
      <select className="cp-select" value={selected} onChange={e => setSelected(Number(e.target.value))}>
        {doc.segments.map((s, i) => <option key={s.id} value={i}>{i + 1}. {s.title}{s.kind === "ndi" ? " (Live)" : ""}</option>)}
      </select></label>}
    {doc && !segment && <div className="cp-pane-empty"><h3 className="cp-pane-empty-title">No source recorded</h3>
      <p className="cp-pane-empty-body">This session has no source or note references. Other saved reviews remain unchanged.</p></div>}
    {doc && segment && <SavedSessionNotes key={segment.id} session={doc} segment={segment} onOpenMedia={onOpenMedia} />}
  </section>;
}
