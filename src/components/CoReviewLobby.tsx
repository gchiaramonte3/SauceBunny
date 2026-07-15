import { useEffect, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { saveJson } from "../lib/storage";
import { IconCoReview, IconClipboard, IconFilm, IconCrown } from "./Icons";
import { AUTHOR_KEY, REVIEW_CHANGED_EVENT, initialsOf, loadReviewer } from "../lib/review";
import type { Participant } from "./ParticipantRail";
import type { SessionState } from "../bindings/SessionState";

/**
 * Co-Review lobby — the first-class destination (nav rail, ⌘4) that promotes
 * the watch-party from a toolbar afterthought to a full surface. It's a
 * parallel view over the SAME useCoReview state the toolbar CoReviewPopover
 * reads; nothing here owns session state (that lives in Rust). Two faces:
 *   · off      → an invite: a Host card (name + Start) beside a Join card
 *                (name + code), two columns on wide windows.
 *   · in a session → the join code + live roster + a door into the theater.
 * The display-name field writes the reviewer identity (loadReviewer / AUTHOR_KEY)
 * because startCoReview() takes no args and hosts under that name — so the typed
 * name is what the roster shows. "Enter theater" jumps to Clip AND flips
 * screening on (the theater overlays the Clip player).
 */
export function CoReviewLobby({ session, localSource, participants, onStart, onJoin, onLeave, onEnterTheater }: {
  session: SessionState;
  /** A local file is loaded — guests can't receive it yet (hosting still allowed). */
  localSource: boolean;
  participants: Participant[];
  onStart: () => void;
  onJoin: (ticket: string, name: string) => void;
  onLeave: () => void;
  onEnterTheater: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(() => loadReviewer().name);
  const [ticket, setTicket] = useState("");
  const [joining, setJoining] = useState(false);
  const active = session.role !== "off";
  const isHost = session.role === "host";
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
        <header className="cp-colobby-head">
          <span className="cp-colobby-mark" aria-hidden="true"><IconCoReview size={22} /></span>
          <div>
            <h1 className="cp-colobby-title">Co-Review</h1>
            <p className="cp-colobby-sub">
              {active
                ? "Everyone in the session follows the host's playhead — comment and review together, live."
                : "Watch and review together. Host a session and share the code, or join one you were sent."}
            </p>
          </div>
        </header>

        {!active && (
          <div className="cp-colobby-cards">
            <section className="cp-colobby-card">
              <span className="cp-colobby-label">Host a session</span>
              <label className="cp-colobby-field">
                <span className="cp-colobby-field-label">Your name</span>
                <input className="cp-colobby-input" value={name}
                  onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              </label>
              <button type="button" className="btn btn-primary cp-colobby-cta" onClick={startSession}>
                Start a session
              </button>
            </section>

            <section className="cp-colobby-card">
              <span className="cp-colobby-label">Join a session</span>
              <label className="cp-colobby-field">
                <span className="cp-colobby-field-label">Your name</span>
                <input className="cp-colobby-input" value={name}
                  onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              </label>
              <label className="cp-colobby-field">
                <span className="cp-colobby-field-label">Join code</span>
                <input className="cp-colobby-input" value={ticket} spellCheck={false}
                  onChange={(e) => setTicket(e.target.value)} placeholder="Paste a join code…" />
              </label>
              <button type="button" className="btn btn-ghost cp-colobby-cta"
                disabled={!ticket.trim() || !name.trim() || joining} onClick={joinSession}>
                {joining ? "Connecting…" : "Join"}
              </button>
              {session.error && <div className="cp-colobby-err">{session.error}</div>}
            </section>
          </div>
        )}

        {active && (
          <div className="cp-colobby-card cp-colobby-session">
            <div className="cp-colobby-role">
              <span className={"cp-colobby-live" + (isHost ? " host" : "")} />
              {isHost ? "You're hosting" : "You joined the session"}
            </div>

            {isHost && (
              <div className="cp-colobby-share">
                <span className="cp-colobby-label">Join code</span>
                <div className="cp-colobby-code" title={session.code ?? ""}>{session.code}</div>
                <button type="button" className="btn btn-ghost cp-colobby-copy" onClick={copyCode}>
                  <IconClipboard size={13} />
                  {copied ? "Copied" : "Copy join code"}
                </button>
              </div>
            )}

            <div className="cp-colobby-roster">
              <span className="cp-colobby-label">In the room · {participants.length}</span>
              <ul className="cp-colobby-people">
                {participants.map((p, i) => (
                  <li key={i} className="cp-colobby-person">
                    <span className="cp-colobby-avatar" style={{ ["--co-color" as string]: p.color }}>
                      {initialsOf(p.name)}
                    </span>
                    <span className="cp-colobby-name" title={p.name}>{p.name}</span>
                    {p.isHost && <span className="cp-colobby-chip host"><IconCrown size={10} /> Host</span>}
                    {p.isSelf && <span className="cp-colobby-chip">You</span>}
                  </li>
                ))}
              </ul>
            </div>

            {session.error && <div className="cp-colobby-err">{session.error}</div>}

            <div className="cp-colobby-actions">
              <button type="button" className="btn btn-primary cp-colobby-enter" onClick={onEnterTheater}>
                <IconFilm size={14} /> Enter theater
              </button>
              <button type="button" className="btn btn-ghost cp-colobby-leave" onClick={onLeave}>
                {isHost ? "End session" : "Leave session"}
              </button>
            </div>
          </div>
        )}

        <p className="cp-colobby-note">
          Media never leaves your machine — everyone in a session streams their own copy; only tiny
          review messages cross the wire.
          {localSource && " Co-review is web-source-only: a local file is loaded, so start a session and load a web URL to screen it with guests."}
        </p>
      </div>
    </main>
  );
}
