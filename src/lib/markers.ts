// Serialize Review notes as NLE timeline markers — five pure emitters, one per
// target (Avid Media Composer, Adobe Premiere, DaVinci Resolve, Final Cut Pro,
// universal CSV). Each is `(doc, settings, title) => string` and reads the
// active version's ROOT comments (parentId === null) in timecode order, exactly
// like the review markdown export. Replies fold into the parent's note.
//
// ALL time conversion lives in ./marker-time (the verified frame-math core) —
// this module never re-derives seconds→frame. It only shapes text per format
// and snaps the reviewer's colour to what each NLE can actually store.
//
// The hard truths per format (see marker-spec §2): Avid has no file-import span
// (we emit a bracket pair), Premiere drops all marker colour on native import
// (we omit it), FCP has no free colour (it's a function of the to-do state), and
// Resolve/Avid/CSV use fixed colour name sets we snap to.

import { parseHex, rgbToHsv, type Rgb } from "./color";
import {
  RATE_TABLE,
  durationFrames,
  frameIndex,
  framesToRational,
  framesToTc,
  secondsToRational,
  tcStartRational,
  tcToFrames,
  totalFrames,
  type MarkerExportSettings,
} from "./marker-time";
import {
  avatarColor,
  labelSuffix,
  repliesOf,
  rootComments,
  type ReviewComment,
  type ReviewDoc,
} from "./review";

// ── internal marker model ────────────────────────────────────────────────────
// One per root comment. Seconds stay real playback time; the emitters convert.
type ExportMarker = {
  name: string;             // root comment author
  inSeconds: number;        // timeStart
  outSeconds: number | null; // timeEnd (null = point marker)
  noteSingle: string;       // body + folded replies, flattened to one line
  noteMulti: string;        // body + folded replies, one line per reply
  colorHex: string;         // reviewer colour of the author (color.ts vocabulary)
  resolved: boolean;        // drives FCP's completed=… to-do state
};

/** Strip tabs/newlines and trim — for the single-line fields every format but
 *  CSV's Notes cell demands. Also drops the other C0 control chars (NUL, BEL,
 *  VT, FF, …) outright: pasted text can carry them, and a raw NUL byte corrupts
 *  the plain-text Avid/CSV imports (and is illegal in XML). This is the single
 *  choke point for every single-line field, so cleaning here covers all formats.*/
function inlineClean(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
}

/** CMX3600 |M: marker text is delimited by `|` (the |C:/|M:/|D: tokens), so a
 *  literal pipe inside the name/note would be misread as a new token and split
 *  the marker — replace pipes with `/`. Also drop any C0 control char (inlineClean
 *  only handles \t\r\n) so a pasted \x00 can't corrupt the single-line event.
 *  Applied to the EDL marker text ONLY — the other formats tolerate `|`. */
function edlMarkerClean(s: string): string {
  return s.replace(/\|/g, "/").replace(/[\x00-\x1F]/g, " ").replace(/\s+/g, " ").trim();
}

/** Fold a root comment's body + its replies into one note. Replies read
 *  `↳ <author>: <body>`, ordered by createdAt. Single-line flattens onto one
 *  line with a ` ↳ ` separator; multiline keeps each reply on its own line
 *  (for the CSV Notes cell). */
function foldNote(rootBody: string, replies: ReviewComment[], multiline: boolean): string {
  const sorted = [...replies].sort((a, b) => a.createdAt - b.createdAt);
  const root = inlineClean(rootBody);
  const replyStrs = sorted.map((r) => `${inlineClean(r.author)}: ${inlineClean(r.body)}`);
  if (!multiline) return [root, ...replyStrs].join(" ↳ ");
  return [root, ...replyStrs.map((s) => `↳ ${s}`)].join("\n");
}

function buildMarkers(doc: ReviewDoc): ExportMarker[] {
  return rootComments(doc, doc.activeVersionId, "time").map((c) => {
    const replies = repliesOf(doc, c.id);
    const body = c.body + labelSuffix(c);
    return {
      name: c.author,
      inSeconds: c.timeStart,
      outSeconds: c.timeEnd != null && c.timeEnd > c.timeStart ? c.timeEnd : null,
      noteSingle: foldNote(body, replies, false),
      noteMulti: foldNote(body, replies, true),
      colorHex: avatarColor(c.author),
      resolved: c.resolved,
    };
  });
}

// ── colour snapping ──────────────────────────────────────────────────────────
// The reviewer colour is an arbitrary hex; each NLE stores only a fixed name
// set, so we snap. Canonical 8 (Avid/CSV) by hue; Resolve's 16 by RGB nearest.

export type CanonicalColor =
  | "red" | "green" | "blue" | "cyan" | "yellow" | "magenta" | "white" | "black";

const CANONICAL_HUES: { name: CanonicalColor; hue: number }[] = [
  { name: "red", hue: 0 },
  { name: "yellow", hue: 60 },
  { name: "green", hue: 120 },
  { name: "cyan", hue: 180 },
  { name: "blue", hue: 240 },
  { name: "magenta", hue: 300 },
];

/** Nearest of Avid's portable 8 (lowercase). Near-greyscale snaps to
 *  white/black by value; otherwise nearest chromatic anchor by circular hue. */
export function nearestCanonicalColor(hex: string): CanonicalColor {
  const rgb = parseHex(hex);
  if (!rgb) return "white";
  const { h, s, v } = rgbToHsv(rgb);
  if (s < 0.15) return v < 0.5 ? "black" : "white";
  let best = CANONICAL_HUES[0];
  let bestD = 360;
  for (const c of CANONICAL_HUES) {
    const raw = Math.abs(h - c.hue);
    const d = Math.min(raw, 360 - raw);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best.name;
}

// Resolve's fixed 16 marker colours, with a representative RGB for nearest-match.
const RESOLVE_COLORS: { name: string; rgb: Rgb }[] = [
  { name: "Blue", rgb: { r: 0x00, g: 0x00, b: 0xcc } },
  { name: "Cyan", rgb: { r: 0x00, g: 0xcc, b: 0xcc } },
  { name: "Green", rgb: { r: 0x00, g: 0xcc, b: 0x00 } },
  { name: "Yellow", rgb: { r: 0xcc, g: 0xcc, b: 0x00 } },
  { name: "Red", rgb: { r: 0xcc, g: 0x00, b: 0x00 } },
  { name: "Pink", rgb: { r: 0xff, g: 0x6e, b: 0xc7 } },
  { name: "Purple", rgb: { r: 0x80, g: 0x00, b: 0x80 } },
  { name: "Fuchsia", rgb: { r: 0xcc, g: 0x00, b: 0xcc } },
  { name: "Rose", rgb: { r: 0xff, g: 0x00, b: 0x7f } },
  { name: "Lavender", rgb: { r: 0xb5, g: 0x7e, b: 0xdc } },
  { name: "Sky", rgb: { r: 0x87, g: 0xce, b: 0xeb } },
  { name: "Mint", rgb: { r: 0x98, g: 0xfb, b: 0x98 } },
  { name: "Lemon", rgb: { r: 0xfd, g: 0xe9, b: 0x10 } },
  { name: "Sand", rgb: { r: 0xc2, g: 0xb2, b: 0x80 } },
  { name: "Cocoa", rgb: { r: 0x7b, g: 0x3f, b: 0x00 } },
  { name: "Cream", rgb: { r: 0xff, g: 0xfd, b: 0xd0 } },
];

/** Nearest of Resolve's 16 marker-colour names (Euclidean RGB). Falls back to
 *  Blue on an unparseable hex — Resolve itself defaults unknown names to Blue. */
export function nearestResolveColor(hex: string): string {
  const rgb = parseHex(hex);
  if (!rgb) return "Blue";
  let best = RESOLVE_COLORS[0];
  let bestD = Infinity;
  for (const c of RESOLVE_COLORS) {
    const d = (rgb.r - c.rgb.r) ** 2 + (rgb.g - c.rgb.g) ** 2 + (rgb.b - c.rgb.b) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best.name;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ── shared small helpers ─────────────────────────────────────────────────────

/** XML text/attribute escape. Attributes additionally pass through inlineClean
 *  upstream so a stray newline can't split an attribute value.
 *  Pasted comment text can carry raw C0 control chars (\x00–\x1F); XML 1.0
 *  forbids all but \t\n\r even as numeric entities, so a single stray \x00 makes
 *  the whole file unparseable. Strip the illegal ones FIRST, then escape. */
function xmlEsc(s: string): string {
  return s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Absolute sequence timecode for a playhead second (includes the Start-TC
 *  offset), drop-frame-aware per the settings. */
function absTc(seconds: number, settings: MarkerExportSettings): string {
  return framesToTc(totalFrames(seconds, settings), settings.frameRate, settings.dropFrame);
}

const startFramesOf = (s: MarkerExportSettings) =>
  tcToFrames(s.sequenceStartTc, s.frameRate, s.dropFrame) ?? 0;

// ── 1. Avid Media Composer — tab-delimited .txt (no header, LF, UTF-8) ───────
// 5 cols: Name⇥TC⇥Track⇥Color⇥Comment. Point = one line. Spanned has no file
// import in Avid, so we emit a bracket pair (>> RANGE START / << RANGE END).
export function markersToAvidTxt(
  doc: ReviewDoc, settings: MarkerExportSettings, _title: string,
): string {
  const lines: string[] = [];
  for (const m of buildMarkers(doc)) {
    const name = inlineClean(m.name);
    const color = nearestCanonicalColor(m.colorHex); // already lowercase
    const note = inlineClean(m.noteSingle);
    const row = (tc: string, comment: string) => `${name}\t${tc}\tV1\t${color}\t${comment}`;
    if (m.outSeconds == null) {
      lines.push(row(absTc(m.inSeconds, settings), note));
    } else {
      lines.push(row(absTc(m.inSeconds, settings), `>> RANGE START | ${note}`));
      lines.push(row(absTc(m.outSeconds, settings), `<< RANGE END | ${note}`));
    }
  }
  return lines.join("\n") + "\n";
}

/** One transcript cue → one Avid marker: speaker → Username, cue start →
 *  absolute sequence timecode (the Start-TC offset carries the source's burn-in
 *  origin for alignment), cue text → Comment. Same 5-column tab-delimited
 *  contract as {@link markersToAvidTxt}: `Name⇥TC⇥V1⇥color⇥Comment`, no header,
 *  LF, UTF-8 (no BOM). Empty / annotation-only cues are skipped. Sequential
 *  cues never share a frame in practice, so no overlap-import risk. */
export type TranscriptMarkerCue = { start: number; speaker: string; text: string };

export function transcriptToAvidTxt(
  cues: TranscriptMarkerCue[], settings: MarkerExportSettings, color: CanonicalColor = "red",
): string {
  const lines: string[] = [];
  for (const c of cues) {
    const comment = inlineClean(c.text);
    if (!comment) continue;
    const name = inlineClean(c.speaker) || "Speaker";
    lines.push(`${name}\t${absTc(c.start, settings)}\tV1\t${color}\t${comment}`);
  }
  return lines.join("\n") + "\n";
}

// ── 2. Adobe Premiere Pro — FCP7 / XMEML .xml ────────────────────────────────
// <in>/<out> are 0-based frame counts from sequence frame 0 (the <timecode>
// block carries the display start separately). Point = <out>-1</out>. Colour is
// dropped on native import, so we omit it.
export function markersToPremiereXml(
  doc: ReviewDoc, settings: MarkerExportSettings, title: string,
): string {
  const spec = RATE_TABLE[settings.frameRate];
  const markers = buildMarkers(doc);
  const rateBlock = `<rate><timebase>${spec.timebase}</timebase><ntsc>${spec.ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;
  const startF = startFramesOf(settings);
  const displayFmt = settings.dropFrame && spec.dropAllowed ? "DF" : "NDF";

  // Sequence must be long enough that Premiere builds it and every marker lands
  // inside it: one second past the last marker's end frame.
  const lastFrame = markers.reduce((mx, m) => {
    const end = m.outSeconds != null ? frameIndex(m.outSeconds, settings.frameRate) : frameIndex(m.inSeconds, settings.frameRate) + 1;
    return Math.max(mx, end);
  }, 0);
  const seqFrames = lastFrame + spec.timebase;
  const seqName = inlineClean(title) || "Sauce Bunny Review Notes";

  const markerXml = markers.map((m) => {
    const inF = frameIndex(m.inSeconds, settings.frameRate);
    const outF = m.outSeconds != null ? frameIndex(m.outSeconds, settings.frameRate) : -1;
    return [
      "    <marker>",
      `      <name>${xmlEsc(inlineClean(m.name))}</name>`,
      `      <comment>${xmlEsc(m.noteSingle)}</comment>`,
      `      <in>${inF}</in>`,
      `      <out>${outF}</out>`,
      "    </marker>",
    ].join("\n");
  }).join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE xmeml>`,
    `<xmeml version="4">`,
    `  <sequence id="${xmlEsc(seqName)}">`,
    `    <name>${xmlEsc(seqName)}</name>`,
    `    <duration>${seqFrames}</duration>`,
    `    ${rateBlock}`,
    `    <timecode>`,
    `      ${rateBlock}`,
    `      <string>${framesToTc(startF, settings.frameRate, settings.dropFrame)}</string>`,
    `      <frame>${startF}</frame>`,
    `      <displayformat>${displayFmt}</displayformat>`,
    `    </timecode>`,
    `    <media>`,
    `      <video>`,
    `        <format>`,
    `          <samplecharacteristics>`,
    `            ${rateBlock}`,
    `            <width>1920</width><height>1080</height>`,
    `          </samplecharacteristics>`,
    `        </format>`,
    `        <track></track>`,
    `      </video>`,
    `      <audio></audio>`,
    `    </media>`,
    markerXml,
    `  </sequence>`,
    `</xmeml>`,
    ``,
  ].join("\n");
}

// ── 3. DaVinci Resolve — CMX3600 .edl with marker tokens ─────────────────────
// 1-frame events placed by absolute Record In; |D: drives the marker length.
// Name+note collapse into |M: (Resolve's Note field stays empty on EDL import).
export function markersToResolveEdl(
  doc: ReviewDoc, settings: MarkerExportSettings, title: string,
): string {
  const df = settings.dropFrame && RATE_TABLE[settings.frameRate].dropAllowed;
  const safeTitle = inlineClean(title) || "Sauce Bunny Review";
  const lines = [`TITLE: ${safeTitle}`, `FCM: ${df ? "DROP FRAME" : "NON-DROP FRAME"}`, ""];
  let n = 1;
  for (const m of buildMarkers(doc)) {
    const inFrames = totalFrames(m.inSeconds, settings);
    const recIn = framesToTc(inFrames, settings.frameRate, settings.dropFrame);
    const recOut = framesToTc(inFrames + 1, settings.frameRate, settings.dropFrame);
    const ev = String(n++).padStart(3, "0");
    const color = nearestResolveColor(m.colorHex);
    const dur = m.outSeconds != null
      ? durationFrames(m.inSeconds, m.outSeconds, settings.frameRate)
      : 1;
    const marker = edlMarkerClean(`${inlineClean(m.name)} — ${inlineClean(m.noteSingle)}`);
    lines.push(`${ev}  001      V     C        ${recIn} ${recOut} ${recIn} ${recOut}`);
    lines.push(` |C:ResolveColor${color} |M:${marker} |D:${dur}`);
  }
  return lines.join("\n") + "\n";
}

// ── 4. Final Cut Pro — .fcpxml ───────────────────────────────────────────────
// Rational time, frame-aligned by construction (numerator = frames × 1001).
// Point duration = one frame; spanned = out−in. Colour is type-only, so we key
// completed= off the resolved state (green=done, red=open). Spanned notes also
// get a <keyword> so the range draws as a visible bar.
export function markersToFcpxml(
  doc: ReviewDoc, settings: MarkerExportSettings, title: string,
): string {
  const spec = RATE_TABLE[settings.frameRate];
  const markers = buildMarkers(doc);
  const frameDur = `${spec.frameDuration.num}/${spec.frameDuration.den}s`;
  const tcFormat = settings.dropFrame && spec.dropAllowed ? "DF" : "NDF";

  const lastFrame = markers.reduce((mx, m) => {
    const end = m.outSeconds != null ? frameIndex(m.outSeconds, settings.frameRate) : frameIndex(m.inSeconds, settings.frameRate) + 1;
    return Math.max(mx, end);
  }, 0);
  const seqDur = framesToRational(lastFrame + spec.timebase, settings.frameRate);
  const eventName = inlineClean(title) || "Sauce Bunny Review";
  const src = `file:///${encodeURIComponent(eventName)}.mov`;

  const body = markers.map((m) => {
    const start = secondsToRational(m.inSeconds, settings);
    const durFrames = m.outSeconds != null
      ? durationFrames(m.inSeconds, m.outSeconds, settings.frameRate)
      : 1;
    const duration = framesToRational(durFrames, settings.frameRate);
    const value = xmlEsc(inlineClean(m.name));
    const note = xmlEsc(inlineClean(m.noteSingle));
    const completed = m.resolved ? "1" : "0";
    const out = [
      `              <marker start="${start}" duration="${duration}" value="${value}" note="${note}" completed="${completed}"/>`,
    ];
    // Spanned notes: an extra keyword range so FCP draws a visible bar (markers
    // themselves render as point icons even with a duration).
    if (m.outSeconds != null) {
      out.push(`              <keyword start="${start}" duration="${duration}" value="${value}"/>`);
    }
    return out.join("\n");
  }).join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE fcpxml>`,
    `<fcpxml version="1.10">`,
    `  <resources>`,
    `    <format id="r1" frameDuration="${frameDur}" width="1920" height="1080"/>`,
    `    <asset id="r2" start="0s" duration="${seqDur}" hasVideo="1" hasAudio="1" format="r1">`,
    `      <media-rep kind="original-media" src="${src}"/>`,
    `    </asset>`,
    `  </resources>`,
    `  <library>`,
    `    <event name="${xmlEsc(eventName)}">`,
    `      <project name="Review Notes">`,
    `        <sequence format="r1" tcStart="${tcStartRational(settings)}" tcFormat="${tcFormat}" duration="${seqDur}">`,
    `          <spine>`,
    `            <asset-clip ref="r2" offset="0s" start="0s" duration="${seqDur}" format="r1">`,
    body,
    `            </asset-clip>`,
    `          </spine>`,
    `        </sequence>`,
    `      </project>`,
    `    </event>`,
    `  </library>`,
    `</fcpxml>`,
    ``,
  ].join("\n");
}

// ── 5. Universal CSV — RFC-4180 .csv (UTF-8 no BOM) ──────────────────────────
// Human-readable interchange artifact. Point = In only; spanned = In+Out+
// Duration. The Notes cell keeps folded replies on separate lines.

/** RFC-4180 field quoting, mirroring review.ts csvCell's formula-injection
 *  guard but PRESERVING newlines (the multiline Notes cell relies on them). */
function csvField(s: string): string {
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  const escaped = guarded.replace(/"/g, '""');
  return /[",\r\n]/.test(escaped) ? `"${escaped}"` : escaped;
}

export function markersToCsv(
  doc: ReviewDoc, settings: MarkerExportSettings, _title: string,
): string {
  const rows = ["Name,In,Out,Duration,Color,Track,Notes"];
  for (const m of buildMarkers(doc)) {
    const inTc = absTc(m.inSeconds, settings);
    const spanned = m.outSeconds != null;
    const outTc = spanned ? absTc(m.outSeconds as number, settings) : "";
    const dur = spanned
      ? framesToTc(durationFrames(m.inSeconds, m.outSeconds as number, settings.frameRate), settings.frameRate, settings.dropFrame)
      : "";
    const color = cap(nearestCanonicalColor(m.colorHex));
    rows.push([
      csvField(inlineClean(m.name)),
      inTc,
      outTc,
      dur,
      color,
      "V1",
      csvField(m.noteMulti),
    ].join(","));
  }
  return rows.join("\n") + "\n";
}
