/**
 * Speaker analytics over a diarized transcript — pure functions, no DOM.
 *
 * Everything derives from the `Cue[]` already in memory (speaker + start/end +
 * text). Two consumers: the transcript header's Insights popover (per-speaker
 * numbers) and the timeline's speaker lanes (who talks when, as colored bands).
 */

import type { Cue } from "./srt";

export type SpeakerStat = {
  speaker: string | null;
  /** Sum of this speaker's cue durations (ms). */
  talkMs: number;
  /** Share of all spoken time, 0..100. */
  sharePct: number;
  /** Number of turns (runs of consecutive cues by the same speaker). */
  turns: number;
  words: number;
  /** Words per minute over their own talk time. */
  wpm: number;
  /** Longest single turn (ms). */
  longestTurnMs: number;
};

export type SpeakerLane = {
  speaker: string | null;
  startMs: number;
  endMs: number;
};

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Merge consecutive same-speaker cues into lanes (turn spans) for the timeline. */
export function speakerLanes(cues: Cue[]): SpeakerLane[] {
  const lanes: SpeakerLane[] = [];
  for (const c of cues) {
    const startMs = Math.round(c.start * 1000);
    const endMs = Math.round(c.end * 1000);
    if (endMs <= startMs) continue;
    const last = lanes[lanes.length - 1];
    if (last && last.speaker === c.speaker && startMs - last.endMs < 1500) {
      // Same speaker continuing (bridge sub-1.5s gaps so lanes read as turns,
      // not confetti).
      last.endMs = Math.max(last.endMs, endMs);
    } else {
      lanes.push({ speaker: c.speaker, startMs, endMs });
    }
  }
  return lanes;
}

/** Per-speaker talk-time stats, sorted by talk time descending. */
export function speakerStats(cues: Cue[]): SpeakerStat[] {
  type Acc = { talkMs: number; turns: number; words: number; longestTurnMs: number };
  const acc = new Map<string | null, Acc>();
  let totalTalk = 0;

  for (const lane of speakerLanes(cues)) {
    const dur = lane.endMs - lane.startMs;
    const a = acc.get(lane.speaker) ?? { talkMs: 0, turns: 0, words: 0, longestTurnMs: 0 };
    a.talkMs += dur;
    a.turns += 1;
    a.longestTurnMs = Math.max(a.longestTurnMs, dur);
    acc.set(lane.speaker, a);
    totalTalk += dur;
  }
  // Words come from cues (lanes merge away the text).
  for (const c of cues) {
    const a = acc.get(c.speaker);
    if (a) a.words += wordsOf(c.text);
  }

  return [...acc.entries()]
    .map(([speaker, a]) => ({
      speaker,
      talkMs: a.talkMs,
      sharePct: totalTalk > 0 ? (a.talkMs / totalTalk) * 100 : 0,
      turns: a.turns,
      words: a.words,
      wpm: a.talkMs > 0 ? a.words / (a.talkMs / 60_000) : 0,
      longestTurnMs: a.longestTurnMs,
    }))
    .sort((x, y) => y.talkMs - x.talkMs);
}

/** "1h 02m", "12m 05s", "42s" — compact talk-time formatting for the popover. */
export function fmtTalkTime(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
