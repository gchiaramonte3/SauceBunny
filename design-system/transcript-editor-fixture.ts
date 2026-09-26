import { framesToTc, secondsToFrames, tcToFrames } from "../src/lib/timecode";
import type { TeSpeaker, TeWord, TeEdit } from "./transcript-editor-model";

/**
 * A generated scene for the Transcript Editor prototype. Not a recording:
 * lines are invented, word times are computed from word length, and the
 * waveforms are drawn from those times. Some lines start before the previous
 * one ends, because crosstalk is the normal case in a reality scene.
 */
export const teSpeakers: TeSpeaker[] = [
  { id: "rosa", name: "Rosa", track: 1 },
  { id: "dev", name: "Dev", track: 2 },
  { id: "imani", name: "Imani", track: 3 },
  { id: "wes", name: "Wes", track: 4 },
  { id: "tamsin", name: "Tamsin", track: 5 },
];

/** [speaker, line, seconds of pause before it (negative = overlaps the previous line)] */
const script: [string, string, number][] = [
  ["rosa", "Okay, everybody, circle up. We have twenty minutes and a kitchen that looks like a crime scene.", 0.6],
  ["dev", "Um, I mean, that's not on us. The other team left it like that.", 0.8],
  ["imani", "It doesn't matter whose mess it is. It's our mess now.", 0.5],
  ["wes", "Can we just, like, pick stations? I'll take the grill.", 0.9],
  ["tamsin", "You took the grill last time and it was a disaster.", -0.4],
  ["wes", "That was one burger. One.", 0.3],
  ["rosa", "Guys. Guys. Focus. Dev, you're on prep. Imani, sauces.", 1.1],
  ["dev", "Fine, but I'm not doing the onions again. My eyes are still recovering.", 0.7],
  ["imani", "I'll do the onions. I don't care. Let's just move.", 0.6],
  ["tamsin", "Honestly, I think we can actually win this if we stop arguing.", 1.4],
  ["rosa", "Let's go, guys, dig in deep. This is the one that sends somebody home.", 0.8],
  ["wes", "Dig in deep. Okay. I like that. I'm writing that on my hand.", 0.5],
  ["dev", "You know what, you're right. I'm sorry I snapped earlier.", 1.3],
  ["imani", "We're good. We're good. Pass me the whisk.", 0.4],
  ["tamsin", "Ten minutes! Ten minutes, people!", 2.0],
  ["rosa", "Plate it. Plate it now. Wipe the edges, the judges notice the edges.", 0.5],
  ["wes", "I swear if this sauce breaks I'm going to lose it.", -0.3],
  ["imani", "It's not going to break. Trust me. Just keep stirring.", 0.4],
  ["dev", "We actually did it. I can't believe we actually did it.", 1.6],
  ["rosa", "Whatever happens, I'm proud of this team. For real.", 0.7],
];

function buildWords(): TeWord[] {
  const words: TeWord[] = [];
  let lineEnd = 1.0;
  script.forEach(([speaker, line, pause], lineIndex) => {
    let t = lineEnd + pause;
    line.split(" ").forEach((text, wordIndex) => {
      const letters = text.replace(/[^A-Za-z']/g, "").length;
      const length = 0.16 + letters * 0.045 + (/[,.!?]$/.test(text) ? 0.08 : 0);
      words.push({ id: `w${lineIndex}-${wordIndex}`, speaker, text, start: round(t), end: round(t + length) });
      t += length + (/[.!?]$/.test(text) ? 0.32 : /,$/.test(text) ? 0.18 : 0.06);
    });
    lineEnd = Math.max(lineEnd, t);
  });
  return words;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export const teWords: TeWord[] = buildWords();
export const teSourceDuration = round(Math.max(...teWords.map((word) => word.end)) + 1.5);

/** The whole scene as one segment: what a new edit starts from. */
export const teWholeScene = (): TeEdit => ({ segments: [{ id: "seg-scene", srcIn: 0, srcOut: teSourceDuration }], mutes: [] });

/** Words by half-second bin, so a waveform bucket looks at a handful of words, not all of them. */
const BIN = 0.5;
const bins = new Map<number, TeWord[]>();
for (const word of teWords) {
  for (let bin = Math.floor(word.start / BIN); bin <= Math.floor(word.end / BIN); bin++) bins.set(bin, [...(bins.get(bin) ?? []), word]);
}

/** Peaks for one speaker's mic over a source range: loud on their own words,
 *  a little bleed on everyone else's, room tone underneath. */
export function tePeaks(speaker: string, srcIn: number, srcOut: number, buckets: number): [number, number][] {
  const out: [number, number][] = [];
  const step = (srcOut - srcIn) / Math.max(1, buckets);
  for (let index = 0; index < buckets; index++) {
    const t = srcIn + (index + 0.5) * step;
    let level = 0.035 + 0.02 * Math.abs(Math.sin(t * 13.1));
    for (const word of bins.get(Math.floor(t / BIN)) ?? []) {
      if (t < word.start || t > word.end) continue;
      const shape = Math.sin(((t - word.start) / (word.end - word.start)) * Math.PI);
      const texture = 0.55 + 0.45 * Math.abs(Math.sin(t * 41 + word.text.length));
      level = Math.max(level, (word.speaker === speaker ? 0.85 : 0.12) * shape * texture);
    }
    out.push([-level, level]);
  }
  return out;
}

/** Scene metadata the prototype shows; invented, like the rest. */
export const teScene = {
  sequence: "EP104 Kitchen Challenge · MG 3",
  aaf: "EP104_KITCHEN_MG3.aaf",
  startTc: "14:22:05:00",
  fps: 24000 / 1001,
};

/** Where the edit's record timecode starts, as Avid numbers a new sequence. */
export const teRecordStart = "01:00:00:00";

/**
 * Timecode `seconds` after a starting timecode. Counted in FRAMES: at 23.976
 * a second of media is not a second of timecode, so adding 3600 seconds and
 * formatting lands 3.6 s short of 01:00:00:00.
 */
export function teTc(seconds: number, fps: number, base = teRecordStart) {
  return framesToTc((tcToFrames(base, fps) ?? 0) + secondsToFrames(seconds, fps), fps);
}
