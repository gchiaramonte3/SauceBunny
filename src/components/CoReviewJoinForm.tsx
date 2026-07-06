import { useState } from "react";
import { loadJson } from "../lib/storage";
import { AUTHOR_KEY } from "../lib/review";

/**
 * The "not in a session yet" face of the co-review popover: a host CTA and a
 * join-by-code form. Its own local state (display name, pasted ticket) lives
 * here. Kept intentionally sparse — the control should read at a glance.
 *
 * Session-first: hosting is always available. You start a session, then load a
 * web source and it propagates to guests. A local file is the one thing guests
 * can't receive yet, so it earns a caveat line — not a block.
 */
export function CoReviewJoinForm({ localSource, onStart, onJoin }: {
  /** A local file is loaded — guests can't receive it yet (hosting still allowed). */
  localSource: boolean;
  onStart: () => void;
  onJoin: (ticket: string, name: string) => void;
}) {
  const [ticket, setTicket] = useState("");
  // Default the display name to the review identity — same person, no accounts.
  const [name, setName] = useState(() => loadJson<string>(AUTHOR_KEY, ""));

  return (
    <>
      <div className="cp-coreview-title">Co-review</div>
      <p className="cp-coreview-sub">Watch together — guests follow your playhead.</p>

      <button className="btn btn-primary" onClick={onStart}>Start a session</button>
      {localSource && (
        <div className="cp-coreview-hint">Guests can’t see a local file yet — load a web URL after starting to screen it together.</div>
      )}

      <div className="cp-coreview-sep">or join</div>
      <input
        className="cp-coreview-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name"
      />
      <input
        className="cp-coreview-input"
        value={ticket}
        onChange={(e) => setTicket(e.target.value)}
        placeholder="Paste a join code…"
        spellCheck={false}
      />
      <button
        className="btn btn-ghost"
        disabled={!ticket.trim() || !name.trim()}
        onClick={() => onJoin(ticket.trim(), name.trim())}
      >
        Join
      </button>
    </>
  );
}
