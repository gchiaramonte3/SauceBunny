import { useState } from "react";
import { useAiStringout } from "../hooks/use-ai-stringout";
import { layoutBites } from "../lib/edit-stringout";
import { editStore, newEditId } from "../lib/edit-store";
import { formatError } from "../lib/error-format";

type Props = { documentId: string; onOpen: (id: string) => void };

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/**
 * Ask for a string-out in words ("two minutes, open with Rosa"). The answer
 * is a list of real bites to read before anything is made; accepting it
 * creates a new edit, which has its own undo history like any other.
 */
export function EditAskStringout({ documentId, onOpen }: Props) {
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ai = useAiStringout();
  const proposal = ai.proposal;
  const accept = async () => {
    if (!proposal) return;
    const document = layoutBites(proposal.document, proposal.title, proposal.bites);
    if (!document) return;
    try {
      const id = newEditId();
      await editStore.create(id, document);
      onOpen(id);
    } catch (cause) { setError(formatError(cause)); }
  };
  const seconds = proposal ? proposal.bites.reduce((sum, bite) => sum + bite.to - bite.from, 0) : 0;
  return <div className="cp-te-ask-stringout">
    <form className="cp-te-picker-ask" onSubmit={(event) => { event.preventDefault(); void ai.ask(documentId, request); }}>
      <label className="cp-te-set-label">Ask for a string-out
        <input className="cp-input" value={request} onChange={(event) => setRequest(event.target.value)} placeholder="Two minutes on the move, open with Rosa" /></label>
      {ai.busy ? <button type="button" className="btn btn-ghost" onClick={ai.stop}>Stop</button>
        : <button type="submit" className="btn btn-ghost" disabled={!request.trim()}>Ask</button>}
    </form>
    {(ai.message || error) && <p className="cp-te-pane-note" role="status">{error ?? ai.message}</p>}
    {proposal && proposal.bites.length > 0 && <section className="cp-te-proposal" aria-label="Proposed string-out">
      <h3 className="cp-te-picker-head">{proposal.title} · {proposal.bites.length} bites · {clock(seconds)}</h3>
      <ol className="cp-te-proposal-list">{proposal.bites.map((bite, index) => <li key={`${bite.lane}-${bite.from}-${index}`}>
        <span className="cp-te-proposal-who">{proposal.names[bite.lane] ?? bite.lane}</span>
        <span className="cp-te-proposal-at">{clock(bite.from)}</span>
        <span className="cp-te-proposal-text">{bite.text}</span></li>)}</ol>
      <div className="cp-te-src-actions">
        <button type="button" className="btn btn-primary" onClick={() => void accept()}>Make this string out</button>
        <button type="button" className="btn btn-ghost" onClick={ai.discard}>Discard</button>
      </div>
    </section>}
  </div>;
}
