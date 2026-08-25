import { useRef } from "react";
import { createPortal } from "react-dom";
import { fmtTalkTime, type SpeakerStat } from "../../lib/speaker-stats";
import { useDismiss } from "../../hooks/use-dismiss";

/**
 * "Speaker insights" popover anchored to the Insights button in the
 * transcript viewer header. Portaled to <body> so it can overflow the
 * right-docked drawer and float above scroll — same chrome and
 * positioning rules as HistoryPopover.
 *
 * Pure renderer: the stats are computed by the parent (speakerStats over
 * the loaded cues) and the per-speaker colour resolution — user override
 * or palette — is passed in so the bars match the transcript bubbles.
 */

type Props = {
  /** Bounding rect of the Insights trigger button — used for positioning. */
  anchor: DOMRect;
  stats: SpeakerStat[];
  /** Resolves a speaker tag to its display colour (override or palette). */
  colorOf: (speaker: string | null) => string;
  /**
   * Resolves a speaker tag to the name the transcript shows for it.
   *
   * This panel used to print `s.speaker` - the raw diarization tag - so it
   * said SPEAKER_00 while the turns beside it said "Jimmy". It skipped BOTH
   * the user's rename and the humanising the rest of the app does, which
   * made a working rename look like it had not saved.
   */
  nameOf: (speaker: string | null) => string;
  onClose: () => void;
};

export function InsightsPopover({ anchor, stats, colorOf, nameOf, onClose }: Props) {
  const popRef = useRef<HTMLDivElement>(null);
  useDismiss(popRef, onClose);

  const POP_W = 340;
  const POP_H_MAX = 360;
  // Position under the button, right-aligned to it so it doesn't spill
  // off-screen on a narrow drawer.
  const top = Math.min(window.innerHeight - 16, anchor.bottom + 4);
  const left = Math.max(
    8,
    Math.min(window.innerWidth - POP_W - 8, anchor.right - POP_W),
  );

  return createPortal(
    <div
      ref={popRef}
      className="cp-tx-insights"
      style={{ top, left, width: POP_W, maxHeight: POP_H_MAX }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Speaker insights"
    >
      <div className="cp-tx-insights-head">
        <span>Speaker insights</span>
      </div>
      {stats.length === 0 ? (
        <div className="cp-tx-insights-empty">
          No spoken cues to analyze yet.
        </div>
      ) : (
        <div className="cp-tx-insights-list">
          {stats.map((s) => (
            <div className="cp-tx-insights-row" key={s.speaker ?? "__NULL__"}>
              <div className="cp-tx-insights-row-top">
                <span className="cp-tx-insights-name" title={nameOf(s.speaker)}>
                  {nameOf(s.speaker)}
                </span>
                <span className="cp-tx-insights-nums">
                  {fmtTalkTime(s.talkMs)} · {Math.round(s.sharePct)}%
                </span>
              </div>
              <div className="cp-tx-insights-bar">
                <div
                  className="cp-tx-insights-bar-fill"
                  style={{ width: `${s.sharePct}%`, background: colorOf(s.speaker) }}
                />
              </div>
              <div className="cp-tx-insights-meta">
                {s.turns} turns · {s.words} words · {Math.round(s.wpm)} wpm
                · longest {fmtTalkTime(s.longestTurnMs)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}
