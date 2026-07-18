import { IconCrown } from "./Icons";
import { initialsOf } from "../lib/review";

/** One person in the screening. `color` is their reviewer hue; `isHost` gets
 *  the crown; `isSelf` marks "You". */
export type Participant = { name: string; color: string; isHost: boolean; isSelf: boolean };

/**
 * Screening-mode left rail — everyone in the co-review session, so people
 * logging in see each other (Louper-style). Rounded floating panel: a stack of
 * avatar rows (initials in a colour ring), host crown, "You" chip, a live dot.
 * Reflow-only — App mounts this alongside the untouched Monitor, so entering
 * screening never remounts the player.
 */
export function ParticipantRail({ active, participants, onExit }: {
  /** Always mounted (App renders it as a stable sibling of <main> so entering
   *  screening never remounts the player); renders nothing when inactive. */
  active: boolean;
  participants: Participant[];
  onExit: () => void;
}) {
  if (!active) return null;
  return (
    <aside className="cp-prail" aria-label="Session participants">
      <div className="cp-prail-head">
        <span className="cp-prail-title">People</span>
        <span className="cp-prail-count">{participants.length}</span>
      </div>
      <div className="cp-prail-list">
        {participants.map((p, i) => (
          <div
            /* Roster position is the only stable, collision-free key —
               display names aren't unique (two guests can pick the same one). */
            key={i}
            className={"cp-prail-row" + (p.isSelf ? " self" : "")}
            style={{ ["--pr-color" as string]: p.color, animationDelay: `${Math.min(i, 8) * 40}ms` }}
          >
            <div className="cp-prail-av">
              <span className="cp-prail-initials">{initialsOf(p.name)}</span>
              <span className="cp-prail-live" aria-hidden />
              {p.isHost && (
                <span className="cp-prail-crown" title="Host" aria-label="Host">
                  <IconCrown size={11} />
                </span>
              )}
            </div>
            <div className="cp-prail-meta">
              <span className="cp-prail-name" title={p.name}>{p.name}</span>
              {p.isSelf && <span className="cp-prail-you">You</span>}
            </div>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-ghost cp-prail-exit" onClick={onExit}>
        Leave session
      </button>
    </aside>
  );
}
