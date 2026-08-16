import { useMemo, useState } from "react";
import { KindGlyph } from "./KindGlyph";
import type { Turn } from "../../lib/srt";
import { fmtTalkSeconds } from "../../lib/speaker-stats";

export type SpeakerGroup = {
  tag: string;
  name: string;
  color: string;
  talkSeconds: number;
  turnCount: number;
  turnIdxs: number[];
  /** Explicit badge icon, if the user picked one. */
  icon?: string | null;
};

/**
 * The transcript by PERSON instead of by time.
 *
 * WHY THIS EXISTS AT ALL. The "Text / Speakers" pill used to be a search
 * SCOPE — it changed whether the box below matched cue text or speaker names,
 * and with an empty box it did nothing whatsoever. It looked like a view
 * switcher, sat where a view switcher sits, and so read as broken: you press
 * it and the transcript does not change, because there was never a second view
 * for it to switch to. There is now, and the pill means what it looks like.
 *
 * ORDERED BY TALK TIME, not by who spoke first. Chronological order is what
 * the Text view is for; repeating it here would make the second view a worse
 * copy of the first. The question this view answers is "who is in this, and
 * how much of it is them" — so the lead is at the top, and a two-line bit part
 * is at the bottom where it belongs rather than third because the diarizer
 * happened to hear it early.
 *
 * COLLAPSED BY DEFAULT. A twenty-six person cast expanded is just the
 * transcript again in a stranger order. Collapsed, it is a cast list you can
 * read in one screen — which is the actual reason to come here.
 */
export function SpeakerGroups({
  groups, turns, cueStartIndices, activeCueIdx, query, onSeek, formatTime,
}: {
  /** Already ordered by the caller. */
  groups: SpeakerGroup[];
  turns: Turn[];
  /** Cumulative index of each turn's first cue, for seeking and highlighting. */
  cueStartIndices: number[];
  activeCueIdx: number;
  /** Speaker-name query. Non-matching groups dim rather than disappear. */
  query: string;
  onSeek: (seconds: number) => void;
  formatTime: (seconds: number) => string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const q = query.trim().toLowerCase();

  /** Which group, if any, is speaking right now. */
  const speakingTag = useMemo(() => {
    if (activeCueIdx < 0) return null;
    for (const g of groups) {
      for (const ti of g.turnIdxs) {
        const start = cueStartIndices[ti];
        if (activeCueIdx >= start && activeCueIdx < start + turns[ti].cues.length) return g.tag;
      }
    }
    return null;
  }, [groups, turns, cueStartIndices, activeCueIdx]);

  const toggle = (tag: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    return next;
  });

  return (
    <div className="cp-tx-groups">
      {groups.map((g) => {
        const expanded = open.has(g.tag);
        const dim = q.length > 0 && !g.name.toLowerCase().includes(q);
        return (
          <div
            key={g.tag}
            className={"cp-tx-group" + (dim ? " dim" : "") + (g.tag === speakingTag ? " speaking" : "")}
          >
            <button
              type="button"
              className="cp-tx-group-head"
              onClick={() => toggle(g.tag)}
              aria-expanded={expanded}
            >
              <span className={"cp-tx-group-chev" + (expanded ? " open" : "")} aria-hidden="true">›</span>
              <span className="cp-tx-group-chip" style={{ background: g.color }} aria-hidden="true">
                <KindGlyph tag={g.tag} name={g.name} override={g.icon} />
              </span>
              <span className="cp-tx-group-name">{g.name}</span>
              {/* Talk time is the sort key, so it has to be on screen — an
                  order with no visible reason reads as no order at all. */}
              <span className="cp-tx-group-talk">{fmtTalkSeconds(g.talkSeconds)}</span>
              <span className="cp-tx-group-turns">
                {g.turnCount === 1 ? "1 line" : `${g.turnCount} lines`}
              </span>
            </button>

            {expanded && (
              <div className="cp-tx-group-lines">
                {g.turnIdxs.map((ti) => {
                  const turn = turns[ti];
                  const start = cueStartIndices[ti];
                  const live = activeCueIdx >= start && activeCueIdx < start + turn.cues.length;
                  const at = turn.cues[0]?.start ?? 0;
                  return (
                    <button
                      key={ti}
                      type="button"
                      className={"cp-tx-group-line" + (live ? " live" : "")}
                      onClick={() => onSeek(at)}
                      title="Jump to this line"
                    >
                      <span className="cp-tx-group-tc">{formatTime(at)}</span>
                      <span className="cp-tx-group-text">
                        {turn.cues.map((c) => c.text).join(" ")}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Talk time, short enough for a row that also carries a name and a count. */
