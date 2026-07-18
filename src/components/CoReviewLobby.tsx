import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { saveJson } from "../lib/storage";
import { IconCrown } from "./Icons";
import { AUTHOR_KEY, REVIEW_CHANGED_EVENT, initialsOf, loadReviewer } from "../lib/review";
import type { Participant } from "./ParticipantRail";
import type { SessionState } from "../bindings/SessionState";

/**
 * Co-Review lobby — the first-class destination (nav rail, ⌘4) that promotes
 * the watch-party from a toolbar afterthought to a full surface. It's a
 * parallel view over the SAME useCoReview state the toolbar CoReviewPopover
 * reads; nothing here owns session state (that lives in Rust).
 *
 * Designed as a calm centered "green room": ONE column (~560px, generous top
 * space) in both faces so nothing jumps when a session starts — only the
 * column's content swaps.
 *   · idle      → quiet header + Host and Join cards, stacked.
 *   · in session → live badge, the join code as a click-to-copy keycap chip
 *                 (host only), a horizontal avatar roster, a door into the
 *                 theater and a quiet leave.
 * The display-name field writes the reviewer identity (loadReviewer / AUTHOR_KEY)
 * because startCoReview() takes no args and hosts under that name — so the typed
 * name is what the roster shows. "Enter theater" jumps to Clip AND flips
 * screening on (the theater overlays the Clip player).
 */
export function CoReviewLobby({ session, localSource, participants, onStart, onJoin, onLeave, }: {
  session: SessionState;
  /** A local file is loaded — guests can't receive it yet (hosting still allowed). */
  localSource: boolean;
  participants: Participant[];
  onStart: () => void;
  onJoin: (ticket: string, name: string) => void;
  onLeave: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(() => loadReviewer().name);
  const [ticket, setTicket] = useState("");
  const [joining, setJoining] = useState(false);
  const active = session.role !== "off";
  const isHost = session.role === "host";
  const joinReady = ticket.trim().length > 0 && name.trim().length > 0;
  // Clear the transient "Connecting…" the moment the session resolves either way
  // (role flips to peer/host on success; an error surfaces on failure).
  useEffect(() => { setJoining(false); }, [session.role, session.error]);

  // Persist the typed name as the reviewer identity so the roster + host name
  // reflect it (there's no backend session-name; loadReviewer() is the source).
  const persistName = (v: string) => {
    saveJson(AUTHOR_KEY, v);
    try { window.dispatchEvent(new CustomEvent(REVIEW_CHANGED_EVENT)); } catch { /* non-DOM */ }
  };
  const startSession = () => { const v = name.trim(); if (v) persistName(v); onStart(); };
  const joinSession = () => {
    const v = name.trim(); const t = ticket.trim();
    if (!v || !t) return;
    persistName(v);
    setJoining(true);
    onJoin(t, v);
  };
  const copyCode = async () => {
    if (!session.code) return;
    try {
      await writeText(session.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <main className="cp-coreview-lobby" aria-label="Co-Review">
      <div className="cp-colobby-inner">
        {!active && (
          <>
            <header className="cp-colobby-head">
              <h1 className="cp-colobby-title">Review together</h1>
              <p className="cp-colobby-sub">
                Watch the same source and comment in sync. Media never leaves each machine.
              </p>
            </header>

            <section className="cp-colobby-card">
              <h2 className="cp-colobby-card-title">Host</h2>
              <label className="cp-colobby-field">
                <span className="cp-colobby-field-label">Your name</span>
                <input className="cp-colobby-input" value={name}
                  onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              </label>
              <button type="button" className="btn btn-primary cp-colobby-cta" onClick={startSession}>
                Start session
              </button>
            </section>
            {localSource && (
              <p className="cp-colobby-hint">
                Local files can't be shared yet. Load a web URL to screen together.
              </p>
            )}

            <section className="cp-colobby-card">
              <h2 className="cp-colobby-card-title">Join</h2>
              <label className="cp-colobby-field">
                <span className="cp-colobby-field-label">Join code</span>
                <input className="cp-colobby-input" value={ticket} spellCheck={false}
                  onChange={(e) => setTicket(e.target.value)} placeholder="Paste a join code" />
              </label>
              <label className="cp-colobby-field">
                <span className="cp-colobby-field-label">Your name</span>
                <input className="cp-colobby-input" value={name}
                  onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              </label>
              <button type="button"
                className={"btn " + (joinReady ? "btn-primary" : "btn-ghost") + " cp-colobby-cta"}
                disabled={!joinReady || joining} onClick={joinSession}>
                {joining ? "Connecting…" : "Join"}
              </button>
              {session.error && <p className="cp-colobby-err" role="alert">{session.error}</p>}
            </section>
          </>
        )}

        {active && (
          <>
            <header className="cp-colobby-head">
              <h1 className="cp-colobby-title">
                <span className="cp-colobby-live" aria-hidden="true" />
                In session
              </h1>
            </header>

            {isHost && session.code && (
              <div className="cp-colobby-share">
                <button type="button" className="cp-keycap cp-colobby-code"
                  onClick={copyCode} aria-label="Copy join code">
                  {session.code}
                </button>
                <span className={"cp-colobby-code-hint" + (copied ? " copied" : "")} aria-live="polite">
                  {copied ? "Copied" : "Click to copy"}
                </span>
              </div>
            )}

            <ul className="cp-colobby-people" aria-label={`In the room: ${participants.length}`}>
              {participants.map((p, i) => (
                <li key={i} className="cp-colobby-person"
                  aria-label={p.name + (p.isHost ? ", host" : "") + (p.isSelf ? ", you" : "")}>
                  <span className={"cp-colobby-avatar" + (p.isHost ? " host" : "")}
                    style={{ ["--co-color" as string]: p.color }} aria-hidden="true">
                    {initialsOf(p.name)}
                    {p.isHost && <span className="cp-colobby-crown"><IconCrown size={9} /></span>}
                  </span>
                  <span className="cp-colobby-name" title={p.name}>{p.name}</span>
                  <span className="cp-colobby-person-tag" aria-hidden="true">
                    {p.isSelf ? "You" : p.isHost ? "Host" : ""}
                  </span>
                </li>
              ))}
            </ul>

            {session.error && <p className="cp-colobby-err center" role="alert">{session.error}</p>}

            <div className="cp-colobby-actions">
              <button type="button" className="cp-colobby-leave" onClick={onLeave}>
                {isHost ? "End session" : "Leave session"}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
