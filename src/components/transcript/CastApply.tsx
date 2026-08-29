import { useMemo, useState } from "react";
import { applyAssignment, autoMatch, type Cast, type CastAssignment, type CastTarget } from "../../lib/cast";
import type { RosterItem } from "./SpeakerRosterModal";

/**
 * Assign a saved cast to this transcript's speakers, then write it in.
 *
 * A REVIEW STEP, not a one-click apply, and deliberately so. The only thing
 * the app can prove is an exact name match, which on a fresh diarized
 * transcript matches nothing at all — every speaker is still "SPEAKER_04".
 * Everything else is a human recognising a voice. An apply that guessed would
 * put the wrong name on the right dialogue, which survives into the SRT, the
 * burned captions and the AI summary, and is close to impossible to spot
 * afterwards.
 *
 * Speakers are ordered by talk time so the leads (the ones worth assigning)
 * are at the top, and a member already used elsewhere is removed from the
 * remaining menus — one person cannot be two speakers.
 */
export function CastApply({
  cast, roster, onCommit, onBack,
}: {
  cast: Cast;
  roster: RosterItem[];
  onCommit: (names: Record<string, string>, colors: Record<string, string>, castName: string) => void;
  onBack: () => void;
}) {
  const targets: CastTarget[] = useMemo(
    () => roster
      .filter((r) => r.colorTag !== null)
      .map((r) => ({ tag: r.tag, name: r.name, talkSeconds: r.talkSeconds }))
      .sort((a, b) => b.talkSeconds - a.talkSeconds),
    [roster],
  );

  const [assignment, setAssignment] = useState<CastAssignment>(() => autoMatch(cast, targets));

  const takenBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const [tag, id] of Object.entries(assignment)) if (id) m.set(id, tag);
    return m;
  }, [assignment]);

  const result = applyAssignment(cast, assignment);
  const auto = useMemo(() => autoMatch(cast, targets), [cast, targets]);
  const autoCount = Object.values(auto).filter(Boolean).length;

  return (
    <>
      <p className="cp-cast-lead">
        Assign <strong>{cast.name}</strong> to the speakers in this transcript.
        {autoCount > 0
          ? ` ${autoCount} matched by name.`
          : " Nothing matched by name, which is normal for a fresh transcript."}
      </p>

      <div className="cp-spk-list">
        {targets.length === 0 && <p className="cp-lib-note">This transcript has no named speakers yet.</p>}
        {targets.map((t) => {
          const picked = assignment[t.tag] ?? "";
          const face = picked ? cast.members.find((m) => m.id === picked)?.avatar : null;
          return (
            <div key={t.tag} className="cp-cast-assign">
              <span className="cp-cast-from" title={t.name}>{t.name}</span>
              <span className="cp-cast-arrow" aria-hidden="true">→</span>
              {/* A <select> cannot render an image in its options, so the face
                  of whoever is currently chosen sits beside it. That is the
                  signal that makes this screen answerable at a glance: you are
                  matching a voice you just heard to a face you can see. */}
              {face && (
                <span
                  className="cp-cast-optface"
                  style={{ background: `center/cover url("${face}")` }}
                  aria-hidden="true"
                />
              )}
              <select
                className="cp-select cp-spk-merge cp-cast-select"
                value={picked}
                onChange={(e) => setAssignment((p) => ({ ...p, [t.tag]: e.target.value || null }))}
                aria-label={`Cast member for ${t.name}`}
              >
                <option value="">Leave as is</option>
                {cast.members
                  // Hide members already spoken for, except this row's own.
                  .filter((m) => !takenBy.has(m.id) || takenBy.get(m.id) === t.tag)
                  .map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          );
        })}
      </div>

      <div className="cp-spk-foot">
        <span className="cp-spk-footcount">
          {result.count === 0
            ? "Nothing assigned"
            : `${result.count} of ${targets.length} will be renamed`}
        </span>
        <button type="button" className="btn btn-ghost btn-compact" onClick={onBack}>Back</button>
        <button
          type="button"
          className="btn btn-compact"
          disabled={result.count === 0}
          onClick={() => onCommit(result.names, result.colors, cast.name)}
        >
          Apply
        </button>
      </div>
    </>
  );
}
