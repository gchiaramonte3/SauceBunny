type Props = { title: string; body: string; keep: string; other: string; onKeep: () => void; onOther: () => void };

/**
 * Asks before a cut would take someone else's words. In a reality scene
 * people talk over each other, and on a magnetic timeline a cut takes the
 * time from every track, so their words would come down with it. The safe
 * choice is the default and Return; the other is one explicit click, and
 * ⌘Z undoes either.
 */
export function EditOvertalkPrompt({ title, body, keep, other, onKeep, onOther }: Props) {
  return <div className="cp-te-prompt" role="alertdialog" aria-labelledby="cp-te-prompt-title" aria-describedby="cp-te-prompt-body"
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onKeep(); } }}>
    <p id="cp-te-prompt-title" className="cp-te-prompt-title">{title}</p>
    <p id="cp-te-prompt-body" className="cp-te-prompt-body">{body}</p>
    <div className="cp-te-prompt-actions">
      <button type="button" className="btn cp-te-btn" autoFocus onClick={onKeep}>{keep}</button>
      <button type="button" className="btn btn-ghost cp-te-btn" onClick={onOther}>{other}</button>
    </div>
  </div>;
}
