import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconUsers, IconClipboard, IconFilm, IconCrown } from "./Icons";
import { CoReviewJoinForm } from "./CoReviewJoinForm";
import type { Participant } from "./ParticipantRail";
import type { SessionState } from "../bindings/SessionState";

/**
 * Co-Review lobby — the first-class destination (nav rail ⌘3) that promotes
 * the watch-party from a toolbar afterthought to a full surface. It's a
 * parallel view over the SAME useCoReview state the toolbar CoReviewPopover
 * reads; nothing here owns session state (that lives in Rust). Two faces:
 *   · off      → an invite: start hosting, or join by code (CoReviewJoinForm).
 *   · in a session → the join code + roster + a door into the theater.
 * "Enter theater" jumps to Clip AND flips screening on (the theater overlays
 * the Clip player), so the lobby can hand you straight into the screening.
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
  const active = session.role !== "off";

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
          <span className="cp-colobby-mark" aria-hidden="true"><IconUsers size={22} /></span>
          <div>
            <h1 className="cp-colobby-title">Co-Review</h1>
            <p className="cp-colobby-sub">
              {active
                ? "Everyone in the session follows the host's playhead — comment and review together, live."
                : "Watch and review together. Start a session and share the code, or join one you were sent."}
            </p>
          </div>
        </header>

        {!active && (
          <div className="cp-colobby-card cp-colobby-start">
            <CoReviewJoinForm localSource={localSource} onStart={onStart} onJoin={onJoin} hideHeading />
          </div>
        )}

        {active && (
          <div className="cp-colobby-card">
            <div className="cp-colobby-role">
              <span className={"cp-colobby-live" + (session.role === "host" ? " host" : "")} />
              {session.role === "host" ? "Hosting" : "Joined a session"}
            </div>

            {session.role === "host" && (
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
                    <span className="cp-colobby-dot" style={{ ["--co-color" as string]: p.color }} />
                    <span className="cp-colobby-name" title={p.name}>{p.name}</span>
                    {p.isHost && (
                      <span className="cp-colobby-chip host">
                        <IconCrown size={10} /> Host
                      </span>
                    )}
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
                Leave session
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
