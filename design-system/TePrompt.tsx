type Props = { who: string; under: string; count: number; onEveryone: () => void; onOnly: () => void; onCancel: () => void };

/**
 * Asked only when a deletion would take someone else's words with it. A cut
 * removes time from every track, and in a reality scene people talk over each
 * other, so "delete these words" has two honest meanings. Return picks the
 * ripple; Escape changes nothing.
 */
export function TePrompt({ who, under, count, onEveryone, onOnly, onCancel }: Props) {
  return <div className="cp-te-prompt" role="alertdialog" aria-labelledby="cp-te-prompt-title" aria-describedby="cp-te-prompt-body"
    onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <p id="cp-te-prompt-title" className="cp-te-prompt-title">{under} is talking under this.</p>
    <p id="cp-te-prompt-body" className="cp-te-prompt-body">Cutting the time for everyone also removes {count === 1 ? "one word" : `${count} words`} of {under}'s. Removing only {who}'s words leaves the timing alone and silences them on {who}'s track.</p>
    <div className="cp-te-prompt-actions">
      <button type="button" className="btn cp-te-btn" autoFocus onClick={onEveryone}>Cut for everyone</button>
      <button type="button" className="btn btn-ghost cp-te-btn" onClick={onOnly}>Only {who}'s words</button>
      <button type="button" className="btn btn-ghost cp-te-btn" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}
