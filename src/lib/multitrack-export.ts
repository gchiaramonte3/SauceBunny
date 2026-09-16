import type { AafDocument } from "../bindings/AafDocument";
import { audioTrackLabel, sequenceFps, sequenceTimecode, transcriptRows, untimedTranscriptRows } from "./multitrack";
import { secondsToCueTc, type Turn } from "./srt";
import { buildTranscriptPrintDoc } from "../components/transcript/helpers";

/** SRT has one caption lane. Split at speech boundaries and combine concurrent
 * voices, rather than emitting overlapping cues that players may hide. The
 * origin is sequence-relative zero, NOT record timecode or the first speech. */
export function multitrackSrt(document: AafDocument): string {
  const endMs = Math.round(document.manifest.duration_frames / sequenceFps(document.manifest) * 1000);
  const cues = transcriptRows(document).map((cue) => ({
    start: Math.round(cue.startSeconds * 1000), end: Math.round(cue.endSeconds * 1000),
    text: `${cue.owner} (${audioTrackLabel(document, cue.trackId)}): ${cue.text}`.replace(/\s+/g, " ").trim(),
    hasText: !!cue.text.trim(),
  })).filter((cue) => cue.hasText && Number.isSafeInteger(cue.start) && Number.isSafeInteger(cue.end)
    && cue.start >= 0 && cue.end > cue.start && cue.end <= endMs);
  const events = cues.flatMap((cue, id) => [{ time: cue.start, id, start: true }, { time: cue.end, id, start: false }])
    .sort((a, b) => a.time - b.time);
  const active = new Set<number>(), blocks: string[] = [];
  for (let index = 0; index < events.length;) {
    const time = events[index].time;
    while (index < events.length && events[index].time === time) {
      const event = events[index++]; if (event.start) active.add(event.id); else active.delete(event.id);
    }
    if (!active.size || index === events.length) continue;
    const text = [...active].sort((a, b) => a - b).map((id) => cues[id].text).join("\n");
    blocks.push(`${blocks.length + 1}\n${secondsToCueTc(time / 1000)} --> ${secondsToCueTc(events[index].time / 1000)}\n${text}`);
  }
  return blocks.join("\n\n") + (blocks.length ? "\n" : "");
}

/** Reuse the transcript print layout and its escaping. No generated HTML from
 * transcript text is trusted; untimed passages remain visible, without a clock. */
export function multitrackPrintDoc(document: AafDocument, name: string): string {
  const entries = [
    ...transcriptRows(document).map((cue) => ({ ...cue, clock: cue.startFrame })),
    ...untimedTranscriptRows(document).map((cue) => ({ ...cue, clock: -1, text: `${cue.text}\nTiming needs review: ${cue.reason}` })),
  ];
  const turns: Turn[] = entries.map((cue, index) => ({ speaker: `${cue.owner} (${audioTrackLabel(document, cue.trackId)})`, start: cue.clock, end: cue.clock,
    cues: [{ index, start: cue.clock, end: cue.clock, speaker: null, text: cue.text }] }));
  return buildTranscriptPrintDoc(turns, `${document.manifest.name} - ${name}`,
    (_index, speaker) => speaker ?? "", (frame) => frame < 0 ? "Timing needs review" : sequenceTimecode(document.manifest, frame),
    "Mic owners are labels, not verified speakers. ASR timing is unverified.");
}
