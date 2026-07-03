import { useState } from "react";
import { loadJson } from "../lib/storage";
import { AUTHOR_KEY } from "../lib/review";

/**
 * The "not in a session yet" face of the co-review popover: a host CTA and a
 * join-by-code form. Its own local state (display name, pasted ticket) lives
 * here. Kept intentionally sparse — the control should read at a glance, so
 * the host action stays primary and the join path sits quietly beneath it.
 *
 * The host button is disabled (not hidden) when the current source can't be
 * hosted, with a single-line hint. That keeps the layout stable for the coming
 * "start a session first, then load a source" flow, where the button is simply
 * always enabled.
 */
export function CoReviewJoinForm({ canHost, onStart, onJoin }: {
  /** Web-only sessions: false while a local file is loaded (can't reach peers). */
  canHost: boolean;
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

      <button className="btn btn-primary" onClick={onStart} disabled={!canHost}>
        Start a session
      </button>
      {!canHost && (
        <div className="cp-coreview-hint">Load a web source to host — local files can’t reach guests yet.</div>
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
