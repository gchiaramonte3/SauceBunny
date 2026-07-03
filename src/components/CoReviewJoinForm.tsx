import { useState } from "react";
import { loadJson } from "../lib/storage";
import { AUTHOR_KEY } from "../lib/review";

/**
 * The "not in a session yet" face of the co-review popover: the host CTA
 * (gated to shareable web sources) plus a name + join-code form. Its own
 * local state — the display name and the pasted ticket — lives here since
 * nothing above the popover needs it; splitting it out keeps CoReviewPopover
 * under the 150-line budget without a deep abstraction tree.
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
      <p className="cp-coreview-sub">
        Watch and review together, peer-to-peer. Guests load the same
        source themselves and follow your playhead — no accounts, no cloud.
      </p>
      {canHost ? (
        <button className="btn btn-primary" onClick={onStart}>Start a session</button>
      ) : (
        <div className="cp-coreview-note">
          Co-review works with shareable web sources (YouTube, Vimeo, …).
          Load a web URL to host — local files can't be sent to guests.
        </div>
      )}
      <div className="cp-coreview-sep">or join with a code</div>
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
