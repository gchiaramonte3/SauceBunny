type Props = { who: string; under: string; count: number; onEveryone: () => void; onKeep: () => void };

/**
 * Shown after deleting words someone else talks under. In a reality scene
 * people talk over each other, and on a magnetic timeline a cut takes the
 * time from every track, so their words would come down with it. The delete
 * has already filled the deleted words with silence on their own track and
 * moved nothing; cutting the time for everyone is the second, explicit step.
 * Return keeps the silence; ⌘Z undoes it.
 */
export function EditOvertalkPrompt({ who, under, count, onEveryone, onKeep }: Props) {
  return <div className="cp-te-prompt" role="alertdialog" aria-labelledby="cp-te-prompt-title" aria-describedby="cp-te-prompt-body"
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onKeep(); } }}>
    <p id="cp-te-prompt-title" className="cp-te-prompt-title">{under} talks under this.</p>
    <p id="cp-te-prompt-body" className="cp-te-prompt-body">Silenced {who} only. Cutting for everyone also removes {count === 1 ? "one word" : `${count} words`} of {under}'s.</p>
    <div className="cp-te-prompt-actions">
      <button type="button" className="btn cp-te-btn" autoFocus onClick={onKeep}>Keep</button>
      <button type="button" className="btn btn-ghost cp-te-btn" onClick={onEveryone}>Cut for everyone</button>
    </div>
  </div>;
}
