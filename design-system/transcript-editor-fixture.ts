import { framesToTc, secondsToFrames, tcToFrames } from "../src/lib/timecode";
import type { TeSpeaker, TeWord, TeEdit } from "./transcript-editor-model";

/**
 * Generated sources for the Transcript Editor prototype. Not recordings:
 * people, lines and timings are invented, word times are computed from word
 * length, and the waveforms are drawn from those times. Some lines start
 * before the previous one ends, because crosstalk is the normal case in a
 * reality scene.
 */
export const teSpeakers: TeSpeaker[] = [
  { id: "rosa", name: "Rosa", track: 1 },
  { id: "dev", name: "Dev", track: 2 },
  { id: "imani", name: "Imani", track: 3 },
  { id: "wes", name: "Wes", track: 4 },
  { id: "tamsin", name: "Tamsin", track: 5 },
  { id: "laurent", name: "Chef Laurent", track: 6 },
  { id: "mara", name: "Mara", track: 7 },
];

/** [speaker, line, seconds of pause before it (negative = overlaps the previous line)] */
type Script = [string, string, number][];

const kitchen: Script = [
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

const judges: Script = [
  ["laurent", "Blue team. Tell me about this plate.", 0.8],
  ["rosa", "Um, so we went with a seared chicken, a pan sauce, and charred onions.", 0.9],
  ["laurent", "The onions are the best thing on the plate. Who cooked them?", 1.2],
  ["imani", "That was me, Chef.", 0.4],
  ["mara", "The sauce is broken. You can see it separating on the rim.", 1.5],
  ["wes", "It was fine a minute ago. I swear it was fine.", 0.3],
  ["mara", "A minute ago is not when we tasted it.", -0.2],
  ["laurent", "Rosa, you're the captain. Is this your best?", 1.0],
  ["rosa", "Honestly? No. We lost ten minutes arguing about stations.", 1.1],
  ["laurent", "I respect that answer. Blue team, step back.", 0.9],
];

const interview: Script = [
  ["rosa", "When I walked into that kitchen I thought, we are going home tonight.", 0.7],
  ["rosa", "Everybody wanted the grill. Nobody wanted the onions.", 0.9],
  ["rosa", "Um, you know, being captain means you eat the mistakes too.", 1.2],
  ["rosa", "When Chef asked if it was our best, I just told him the truth.", 1.0],
  ["rosa", "I'd rather lose honest than win pretending.", 1.4],
  ["rosa", "Dig in deep. That's what I kept saying. Dig in deep.", 0.8],
];

/** A source the editor can open: an AAF Audio sequence, or a clip with one mic. */
/** `mention` is how Ask refers to it: @Kitchen. */
export type TeSource = { id: string; name: string; short: string; mention: string; startTc: string; duration: number; speakers: string[] };

const round = (value: number) => Math.round(value * 1000) / 1000;

function buildWords(source: string, script: Script): TeWord[] {
  const words: TeWord[] = [];
  let lineEnd = 1.0;
  script.forEach(([speaker, line, pause], lineIndex) => {
    let t = lineEnd + pause;
    line.split(" ").forEach((text, wordIndex) => {
      const letters = text.replace(/[^A-Za-z']/g, "").length;
      const length = 0.16 + letters * 0.045 + (/[,.!?]$/.test(text) ? 0.08 : 0);
      words.push({ id: `${source}-${lineIndex}-${wordIndex}`, source, speaker, text, start: round(t), end: round(t + length) });
      t += length + (/[.!?]$/.test(text) ? 0.32 : /,$/.test(text) ? 0.18 : 0.06);
    });
    lineEnd = Math.max(lineEnd, t);
  });
  return words;
}

const scripts: [Omit<TeSource, "duration" | "speakers">, Script][] = [
  [{ id: "mg3", name: "EP104 Kitchen Challenge · MG 3", short: "MG 3 Kitchen", mention: "Kitchen", startTc: "14:22:05:00" }, kitchen],
  [{ id: "mg1", name: "EP104 Judges Table · MG 1", short: "MG 1 Judges", mention: "Judges", startTc: "16:05:12:00" }, judges],
  [{ id: "itm", name: "EP104 ITM Rosa", short: "ITM Rosa", mention: "ITM", startTc: "19:41:30:00" }, interview],
];

export const teWords: TeWord[] = scripts.flatMap(([source, script]) => buildWords(source.id, script));

export const teSources: TeSource[] = scripts.map(([source]) => {
  const own = teWords.filter((word) => word.source === source.id);
  return { ...source, duration: round(Math.max(...own.map((word) => word.end)) + 1.5), speakers: [...new Set(own.map((word) => word.speaker))] };
});

export const teDurations: Record<string, number> = Object.fromEntries(teSources.map((source) => [source.id, source.duration]));

/** One whole source as a single segment: what a new edit starts from. */
export const teWholeScene = (source = "mg3"): TeEdit => ({ segments: [{ id: `seg-${source}`, source, srcIn: 0, srcOut: teDurations[source] }], mutes: [] });

/** Words by source and half-second bin, so a waveform bucket looks at a handful of words, not all of them. */
const BIN = 0.5;
const bins = new Map<string, TeWord[]>();
for (const word of teWords) {
  for (let bin = Math.floor(word.start / BIN); bin <= Math.floor(word.end / BIN); bin++) {
    const key = `${word.source}:${bin}`;
    bins.set(key, [...(bins.get(key) ?? []), word]);
  }
}

/** Peaks for one speaker's mic over a source range: loud on their own words,
 *  a little bleed on everyone else's, room tone underneath. */
export function tePeaks(source: string, speaker: string, srcIn: number, srcOut: number, buckets: number): [number, number][] {
  const out: [number, number][] = [];
  const step = (srcOut - srcIn) / Math.max(1, buckets);
  for (let index = 0; index < buckets; index++) {
    const t = srcIn + (index + 0.5) * step;
    let level = 0.035 + 0.02 * Math.abs(Math.sin(t * 13.1));
    for (const word of bins.get(`${source}:${Math.floor(t / BIN)}`) ?? []) {
      if (t < word.start || t > word.end) continue;
      const shape = Math.sin(((t - word.start) / (word.end - word.start)) * Math.PI);
      const texture = 0.55 + 0.45 * Math.abs(Math.sin(t * 41 + word.text.length));
      level = Math.max(level, (word.speaker === speaker ? 0.85 : 0.12) * shape * texture);
    }
    out.push([-level, level]);
  }
  return out;
}

/** Project metadata the prototype shows; invented, like the rest. */
export const teScene = { aaf: "EP104_KITCHEN_MG3.aaf", fps: 24000 / 1001 };

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
