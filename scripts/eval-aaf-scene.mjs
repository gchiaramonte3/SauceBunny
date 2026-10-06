#!/usr/bin/env node
/**
 * Measure transcript accuracy on a real AAF without hand labels
 * (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md, phases 0, 3 and 4). A
 * developer tool: it runs the same sidecars the app runs and writes its
 * report OUTSIDE the repo (real footage and transcripts are never committed).
 *
 *   node scripts/eval-aaf-scene.mjs --aaf <file.aaf> --document <id> [--minutes 4] [--mics 4] [--out <dir>]
 *
 * What it can measure honestly with no one listening:
 *  1. The real scene: Parakeet v3 against Ultra (how often they disagree, and
 *     where), measured word times against the old length-based guess, and
 *     what the bleed resolver labels, on levels read from the audio itself.
 *  2. Bleed with a KNOWN answer: stretches where one person clearly dominates
 *     their own lav are mixed into a neighbour's mic at realistic levels and
 *     delays, in turns and talking over each other, and the resolver is scored
 *     against what was mixed.
 *  3. Real voices: how alike the cast's voiceprints are, same person against
 *     different people.
 *  4. A short list of lines to check by ear, with timecodes, instead of a
 *     whole scene to label.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BIN = join(ROOT, "src-tauri", "binaries");
const AAF = join(BIN, "saucebunny-aaf-aarch64-apple-darwin");
const FFMPEG = join(BIN, "ffmpeg-aarch64-apple-darwin");
const DIARIZE = join(BIN, "saucebunny-diarize-aarch64-apple-darwin");
const APP = join(ROOT, "src-tauri", "target", "debug", "sauce-bunny");
const MODELS = join(homedir(), "Library", "Application Support", "com.saucebunny.desktop", "models", "parakeet");

const arg = (flag, fallback) => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : fallback; };
const aaf = arg("--aaf"), documentId = arg("--document");
if (!aaf || !documentId) { console.error("--aaf <file> --document <id> are required"); process.exit(2); }
const minutes = Number(arg("--minutes", "4")), micCount = Number(arg("--mics", "4"));
const out = resolve(arg("--out", join(homedir(), "Documents", "Sauce Bunny Eval", `scene-${documentId.slice(0, 8)}`)));
mkdirSync(out, { recursive: true });
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: "utf8", maxBuffer: 1 << 28, ...options });
const say = (line) => { console.log(line); report.push(line); };
const report = [];

// ── The scene: the busiest stretch of the sequence, its busiest mics ──
const document = JSON.parse(readFileSync(join(homedir(), "Documents", "Sauce Bunny", "Transcripts", "Multitrack", `${documentId}.json`), "utf8"));
const rate = document.manifest.edit_rate.numerator / document.manifest.edit_rate.denominator;
const span = Math.round(minutes * 60 * rate);
const cueFrame = (sample) => Math.floor(sample / 16000 * rate);
let best = { start: 0, count: -1 };
for (let start = 0; start + span <= document.manifest.duration_frames; start += Math.round(30 * rate)) {
  const count = document.transcripts.reduce((sum, t) => sum + t.cues.filter((c) => cueFrame(c.start_sample) >= start && cueFrame(c.start_sample) < start + span).length, 0);
  if (count > best.count) best = { start, count };
}
const busy = document.transcripts.map((t) => ({ track: t.track_id, cues: t.cues.filter((c) => cueFrame(c.start_sample) >= best.start && cueFrame(c.start_sample) < best.start + span).length }))
  .sort((a, b) => b.cues - a.cues).slice(0, micCount).map((item) => item.track);
const owner = (track) => document.labels.find((label) => label.track_id === track)?.owner_name || track;
const tc = (seconds) => {
  const fps = document.manifest.timecode_fps, frame = document.manifest.start_frame + best.start + Math.round(seconds * rate);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(frame / (fps * 3600)))}:${pad(Math.floor(frame / (fps * 60)) % 60)}:${pad(Math.floor(frame / fps) % 60)}:${pad(frame % fps)}`;
};
say(`# ${document.manifest.name}: ${minutes} minutes from ${tc(0)}, mics ${busy.map(owner).join(", ")}`);

// ── 1. Audio: each mic at 16 kHz, as the app prepares it ──
for (const track of busy) {
  const wav = join(out, `${track}.wav`);
  if (existsSync(wav)) continue;
  const raw = join(out, `${track}.raw.wav`);
  run(AAF, ["extract", "--input", aaf, "--track", track, "--start-frame", String(best.start), "--duration-frames", String(span), "--output", raw]);
  run(FFMPEG, ["-loglevel", "error", "-y", "-i", raw, "-ar", "16000", "-ac", "1", wav]);
}

// ── 2. Recognition, v3 and Ultra, words kept ──
const transcribe = (model, files) => {
  const items = files.map(({ wav, base }) => ({ input: wav, output: `${base}.${model}.srt`, words: `${base}.${model}.words.json` }));
  if (items.every((item) => existsSync(item.words))) return;
  writeFileSync(join(out, `batch.${model}.json`), JSON.stringify(items));
  run(DIARIZE, ["--asr", "--asr-model", model, "--batch", join(out, `batch.${model}.json`), "--models-dir", MODELS]);
};
const mics = busy.map((track) => ({ track, wav: join(out, `${track}.wav`), base: join(out, track) }));
const models = ["v3", "ultra"];
for (const model of models) transcribe(model, mics);
const words = (base, model) => JSON.parse(readFileSync(`${base}.${model}.words.json`, "utf8"));

// ── 3. The bleed resolver on the real scene ──
const resolveBleed = (name, list, truth) => {
  const file = join(out, `${name}.run.json`), labels = join(out, `${name}.labels.json`);
  writeFileSync(file, JSON.stringify({ mics: list.map((mic) => ({ track: mic.track, wav: mic.wav, words: mic.words })), out: labels, truth, fps: rate }));
  return { text: run(APP, ["--eval-bleed", file]).trim(), labels: JSON.parse(readFileSync(labels, "utf8")) };
};
const real = {};
for (const model of models) {
  real[model] = resolveBleed(`real.${model}`, mics.map((mic) => ({ ...mic, words: `${mic.base}.${model}.words.json` })));
  say(`\n## Real scene, Parakeet ${model}\n${real[model].text}`);
}

// ── Text helpers: the same normalising and alignment the scorer uses ──
const normal = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const align = (a, b) => {
  const cost = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1, cost[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const pairs = []; let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) { pairs.push([i - 1, null]); i--; }
    else { pairs.push([null, j - 1]); j--; }
  }
  return { distance: cost[a.length][b.length], pairs: pairs.reverse() };
};
const shown = (labels, track) => labels.filter((w) => w.track === track && w.label !== "bleed");

// ── 4. v3 against Ultra: how often they disagree, and where ──
let compared = 0, differ = 0;
const disagreements = [];
for (const { track } of mics) {
  const a = shown(real.v3.labels, track), b = shown(real.ultra.labels, track);
  const { distance, pairs } = align(a.map((w) => normal(w.text)), b.map((w) => normal(w.text)));
  compared += Math.max(a.length, b.length); differ += distance;
  for (const [i, j] of pairs) if (i !== null && j !== null && normal(a[i].text) !== normal(b[j].text) && disagreements.length < 60) disagreements.push({ track, at: a[i].start, v3: a[i].text, ultra: b[j].text });
}
say(`\n## v3 against Ultra\nThey differ on ${(differ / Math.max(1, compared) * 100).toFixed(1)}% of words shown (${differ} edits over ${compared}). Without a reference this says how much changes, not which is right; the list at the end is where to listen.`);

// ── 5. Measured word times against the old guess from word length ──
const shifts = [];
for (const { base } of mics) {
  const srt = readFileSync(`${base}.v3.srt`, "utf8").split(/\n\n+/).map((block) => {
    const m = block.match(/(\d+):(\d+):(\d+),(\d+) --> (\d+):(\d+):(\d+),(\d+)\n([\s\S]+)/);
    if (!m) return null;
    const s = (h, mi, se, ms) => +h * 3600 + +mi * 60 + +se + +ms / 1000;
    return { start: s(m[1], m[2], m[3], m[4]), end: s(m[5], m[6], m[7], m[8]), text: m[9].replace(/\n/g, " ").trim() };
  }).filter(Boolean);
  const measured = words(base, "v3");
  for (const cue of srt) {
    const inside = measured.filter((w) => (w.start + w.end) / 2 >= cue.start && (w.start + w.end) / 2 <= cue.end);
    const parts = cue.text.split(/\s+/).filter(Boolean);
    if (inside.length !== parts.length) continue;
    const weight = parts.map((p) => [...p].filter((c) => /[\p{L}\p{N}]/u.test(c)).length + 1), total = weight.reduce((a, b) => a + b, 0);
    let sum = 0;
    parts.forEach((_, index) => { shifts.push(Math.abs(cue.start + (cue.end - cue.start) * sum / total - inside[index].start) * 1000); sum += weight[index]; });
  }
}
shifts.sort((a, b) => a - b);
const frameMs = 1000 / rate;
say(`\n## Word times: measured against the old length-based guess\nOver ${shifts.length} words the guess was off by ${(shifts.reduce((a, b) => a + b, 0) / Math.max(1, shifts.length)).toFixed(0)} ms on average, ${shifts[Math.floor(shifts.length * 0.9)]?.toFixed(0)} ms at the 90th percentile; ${(shifts.filter((s) => s > frameMs).length / Math.max(1, shifts.length) * 100).toFixed(0)}% of words moved by more than a frame.`);

// ── 6. Bleed with a known answer: real voices, mixed ──
// A mic's clean speech: stretches where it dominates by 15 dB, or, when no
// mic does (AFF BANK 1), the words only that mic heard, as the voice check does.
const joinSpans = (spans, shortest) => {
  const joined = [];
  for (const w of spans) { const last = joined[joined.length - 1]; if (last && w.start - last.end <= 0.3) last.end = Math.max(last.end, w.end); else joined.push({ start: w.start, end: w.end }); }
  return joined.filter((s) => s.end - s.start >= shortest);
};
const stretches = (labels, track) => {
  const loud = joinSpans(labels.filter((w) => w.track === track && w.label === "owner" && (w.delta_db ?? 0) >= 15).sort((a, b) => a.start - b.start), 2);
  if (loud.reduce((t, s) => t + s.end - s.start, 0) >= 15) return loud;
  const all = labels.filter((w) => normal(w.text));
  const alone = all.filter((w) => w.track === track && !all.some((v) => v.track !== track && Math.abs(v.start - w.start) <= 0.15 && normal(v.text) === normal(w.text)));
  return joinSpans(alone.sort((a, b) => a.start - b.start), 1.5);
};
const solo = mics.map((mic) => ({ ...mic, spans: stretches(real.v3.labels, mic.track) })).filter((mic) => mic.spans.length).sort((a, b) =>
  b.spans.reduce((t, s) => t + s.end - s.start, 0) - a.spans.reduce((t, s) => t + s.end - s.start, 0));
say(`\n## Bleed with a known answer`);
if (solo.length < 2) say("Fewer than two mics had stretches of clear dominance in this scene, so no mixes were made.");
else {
  const clean = solo.slice(0, 2).map((mic) => {
    let total = 0; const take = [];
    for (const s of mic.spans) { if (total >= 40) break; take.push(s); total += s.end - s.start; }
    const file = join(out, `clean-${mic.track}.wav`);
    const filter = take.map((s, i) => `[0]atrim=${s.start.toFixed(3)}:${s.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`).join(";") + ";" + take.map((_, i) => `[a${i}]`).join("") + `concat=n=${take.length}:v=0:a=1[o]`;
    run(FFMPEG, ["-loglevel", "error", "-y", "-i", mic.wav, "-filter_complex", filter, "-map", "[o]", "-ar", "16000", "-ac", "1", file]);
    return { track: mic.track, wav: file, base: join(out, `clean-${mic.track}`), seconds: total };
  });
  transcribe("v3", clean);
  const [A, B] = clean;
  const cleanWords = clean.map((c) => words(c.base, "v3"));
  say(`Clean stretches: ${owner(A.track)} ${A.seconds.toFixed(0)} s, ${owner(B.track)} ${B.seconds.toFixed(0)} s, from where their mic dominates or, failing that, words only their mic heard. Bleed at -3 dB is this footage's own separation; -12 to -24 dB is what separate lavs usually give.`);
  const sameWord = (x, y) => x === y || (Math.min(x.length, y.length) >= 4 && align([...x], [...y]).distance <= 1);
  const mixes = [];
  for (const shape of ["turns", "overtalk"]) for (const gain of [-3, -12, -18, -24]) for (const delay of [3, 9]) {
    const name = `mix-${shape}${gain}-${delay}`;
    const offsetB = shape === "turns" ? A.seconds : 0;
    const d = Math.round(delay * 16), at = (seconds) => Math.round(seconds * 16000);
    const mix = (own, ownAt, other, otherAt, file) => run(FFMPEG, ["-loglevel", "error", "-y", "-i", own, "-i", other, "-filter_complex",
      `[0]adelay=delays=${at(ownAt)}S:all=1[o];[1]volume=${gain}dB,adelay=delays=${at(otherAt) + d}S:all=1[b];[o][b]amix=inputs=2:normalize=0:duration=longest[m]`, "-map", "[m]", "-ar", "16000", "-ac", "1", file]);
    const micA = { track: "a", wav: join(out, `${name}-a.wav`), base: join(out, `${name}-a`) }, micB = { track: "b", wav: join(out, `${name}-b.wav`), base: join(out, `${name}-b`) };
    mix(A.wav, 0, B.wav, offsetB, micA.wav);
    mix(B.wav, offsetB, A.wav, 0, micB.wav);
    transcribe("v3", [micA, micB]);
    // The answer, word by word: a word on a mic is its owner's when the clean
    // transcript of that owner has it at that moment, bleed when the other's does.
    const rows = ["track,start,end,text,speaker,role"];
    for (const [mic, mine, theirs, mineAt, theirsAt] of [[micA, cleanWords[0], cleanWords[1], 0, offsetB], [micB, cleanWords[1], cleanWords[0], offsetB, 0]]) {
      for (const w of words(mic.base, "v3")) {
        const text = normal(w.text), near = (list, shift) => list.some((c) => Math.abs(c.start + shift - w.start) <= 0.35 && sameWord(normal(c.text), text));
        const role = near(mine, mineAt) ? "owner" : near(theirs, theirsAt) ? "bleed" : null;
        if (role && text) rows.push(`${mic.track},${w.start.toFixed(3)},${w.end.toFixed(3)},${w.text.replace(/,/g, "")},${mic.track},${role}`);
      }
    }
    writeFileSync(join(out, `${name}.csv`), rows.join("\n") + "\n");
    const resolved = resolveBleed(name, [{ ...micA, words: `${micA.base}.v3.words.json` }, { ...micB, words: `${micB.base}.v3.words.json` }], join(out, `${name}.csv`));
    const scored = resolved.text;
    if (gain === -3) mixes.push({ name, shape, delay, micA, micB, labels: resolved.labels, truth: rows.slice(1).map((row) => row.split(",")) });
    const hidden = scored.match(/owner words wrongly hidden (\d+) \(([^)]+)\)/), left = scored.match(/bleed left showing (\d+) of (\d+) \(([^)]+)\)/);
    say(`- ${shape}, bleed ${gain} dB, ${delay} ms late: owner words wrongly hidden ${hidden?.[1] ?? "?"} (${hidden?.[2] ?? "?"}); bleed left showing ${left?.[1] ?? "?"} of ${left?.[2] ?? "?"} (${left?.[3] ?? "?"})`);
  }
  // Where levels cannot decide (-3 dB), does the voice check? The app's rule:
  // learn each owner's voice, then call an unsure word by the voice in it; an
  // owner's voice on the other person's mic, with the same word on their own
  // mic, makes that copy bleed.
  const voiceOf = (wav, spans) => {
    const spanFile = join(out, "vc-spans.json"), printFile = join(out, "vc-prints.json");
    writeFileSync(spanFile, JSON.stringify(spans));
    run(DIARIZE, ["--embed", "--input", wav, "--spans", spanFile, "--output", printFile]);
    return JSON.parse(readFileSync(printFile, "utf8"));
  };
  const centroid = (list) => { const v = list.filter(Boolean); if (!v.length) return null; const sum = v[0].map((_, k) => v.reduce((t, x) => t + x[k], 0)); const n = Math.hypot(...sum); return sum.map((x) => x / n); };
  const chunks = (seconds) => Array.from({ length: Math.floor(seconds / 3) }, (_, i) => [i * 3, i * 3 + 3]);
  const voices = { a: centroid(voiceOf(A.wav, chunks(A.seconds))), b: centroid(voiceOf(B.wav, chunks(B.seconds))) };
  const dot = (x, y) => x.reduce((t, v, k) => t + v * y[k], 0);
  for (const mix of mixes) {
    const decided = mix.labels.map((w) => ({ ...w }));
    for (const mic of ["a", "b"]) {
      const unsure = decided.filter((w) => w.track === mic && w.label === "unsure");
      if (!unsure.length) continue;
      const prints = voiceOf((mic === "a" ? mix.micA : mix.micB).wav, unsure.map((w) => { const m = (w.start + w.end) / 2; return [Math.max(0, m - 0.75), m + 0.75]; }));
      unsure.forEach((w, i) => {
        if (!prints[i]) return;
        const other = mic === "a" ? "b" : "a", own = dot(prints[i], voices[mic]), theirs = dot(prints[i], voices[other]);
        if (own >= 0.4 && own - theirs >= 0.1) w.label = "owner";
        else if (theirs >= 0.4 && theirs - own >= 0.1) w.label = decided.some((v) => v.track === other && Math.abs(v.start - w.start) <= 0.15 && sameWord(normal(v.text), normal(w.text))) ? "bleed" : "other";
      });
    }
    const truth = new Map(mix.truth.map(([track, start, , , , role]) => [`${track}@${start}`, role]));
    let owners = 0, hiddenOwners = 0, bleeds = 0, caught = 0;
    for (const w of decided) {
      const role = truth.get(`${w.track}@${w.start.toFixed(3)}`);
      if (role === "owner") { owners++; if (w.label === "bleed") hiddenOwners++; }
      if (role === "bleed") { bleeds++; if (w.label === "bleed") caught++; }
    }
    say(`- with voices, ${mix.shape} at -3 dB, ${mix.delay} ms: bleed hidden ${caught} of ${bleeds} (${(caught / Math.max(1, bleeds) * 100).toFixed(0)}%); owner words wrongly hidden ${hiddenOwners} of ${owners}`);
  }
}

// ── 7. Real voices: how alike are this cast? ──
say(`\n## Real voices`);
const prints = [];
for (const mic of solo.slice(0, 4)) {
  const halves = [mic.spans.filter((_, i) => i % 2 === 0).slice(0, 8), mic.spans.filter((_, i) => i % 2 === 1).slice(0, 8)];
  const centres = halves.map((spans, half) => {
    if (!spans.length) return null;
    const spanFile = join(out, `spans-${mic.track}-${half}.json`), printFile = join(out, `prints-${mic.track}-${half}.json`);
    writeFileSync(spanFile, JSON.stringify(spans.map((s) => [s.start, Math.min(s.end, s.start + 10)])));
    run(DIARIZE, ["--embed", "--input", mic.wav, "--spans", spanFile, "--output", printFile]);
    const list = JSON.parse(readFileSync(printFile, "utf8")).filter(Boolean);
    if (!list.length) return null;
    const sum = list[0].map((_, k) => list.reduce((t, v) => t + v[k], 0));
    const norm = Math.hypot(...sum);
    return sum.map((v) => v / norm);
  });
  if (centres.every(Boolean)) prints.push({ track: mic.track, centres });
}
const cos = (a, b) => a.reduce((t, v, k) => t + v * b[k], 0);
if (prints.length >= 2) {
  const same = prints.map((p) => cos(p.centres[0], p.centres[1]));
  const different = [];
  for (let i = 0; i < prints.length; i++) for (let j = i + 1; j < prints.length; j++) different.push({ pair: `${owner(prints[i].track)} / ${owner(prints[j].track)}`, score: cos(prints[i].centres[0], prints[j].centres[0]) });
  say(`Same person, two halves of their speech: ${same.map((s, i) => `${owner(prints[i].track)} ${s.toFixed(2)}`).join(", ")}.`);
  say(`Different people: ${different.map((d) => `${d.pair} ${d.score.toFixed(2)}`).join(", ")}.`);
  say(`The voice check calls a match at 0.40 with a 0.10 margin, and two owners at 0.60 or more "too alike".`);
} else say("Fewer than two mics had enough clear speech to learn a voice from.");

// ── 8. Lines to check by ear ──
say(`\n## Lines to check by ear (a few minutes)`);
const pick = (label, count) => real.v3.labels.filter((w) => w.label === label).filter((w, i, all) => i === 0 || w.start - all[i - 1].start > 4).slice(0, count);
for (const w of pick("bleed", 6)) say(`- ${tc(w.start)} on ${owner(w.track)}'s mic: "${w.text}...", labelled bleed from ${owner(w.heard_on)}'s mic. Is that who said it?`);
for (const w of pick("overtalk", 3)) say(`- ${tc(w.start)} on ${owner(w.track)}'s mic: "${w.text}...", labelled overtalk (two people at once). Is ${owner(w.track)} speaking here?`);
for (const w of pick("unsure", 3)) say(`- ${tc(w.start)} on ${owner(w.track)}'s mic: "${w.text}...", left unsure. Who is it?`);
for (const d of disagreements.filter((d, i, all) => i === 0 || d.at - all[i - 1].at > 4).slice(0, 8)) say(`- ${tc(d.at)} on ${owner(d.track)}'s mic: v3 heard "${d.v3}", Ultra heard "${d.ultra}". Which is right?`);
writeFileSync(join(out, "report.md"), report.join("\n") + "\n");
console.log(`\nReport: ${join(out, "report.md")}`);
