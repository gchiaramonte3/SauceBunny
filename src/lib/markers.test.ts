import { describe, expect, it } from "vitest";
import {
  markersToAvidTxt,
  markersToCsv,
  markersToFcpxml,
  markersToPremiereXml,
  markersToResolveEdl,
  nearestCanonicalColor,
  nearestResolveColor,
} from "./markers";
import type { MarkerExportSettings } from "./marker-time";
import type { ReviewComment, ReviewDoc } from "./review";

// The spec §3 sample is three notes — a point at 38s, a span 60→90s, a point at
// 253s — at 23.976 NDF with Start TC 01:00:00:00. The frame math is verified in
// marker-time.test; here we assert the SERIALIZERS place those exact frames in
// each format. The sample's artificial names ("Reaction" etc.) are replaced
// with realistic authors/bodies — the frame-exact invariants don't depend on
// them, so the golden numbers (911 / 1439→2158 / 719 / 01:00:37:23 …) stay.

const S976: MarkerExportSettings = {
  frameRate: "23.976",
  sequenceStartTc: "01:00:00:00",
  dropFrame: false,
};

let idc = 0;
function mkComment(p: Partial<ReviewComment>): ReviewComment {
  return {
    id: p.id ?? `c${idc++}`,
    versionId: "v1",
    parentId: p.parentId ?? null,
    timeStart: p.timeStart ?? 0,
    timeEnd: p.timeEnd ?? null,
    body: p.body ?? "",
    resolved: p.resolved ?? false,
    author: p.author ?? "Reviewer",
    createdAt: p.createdAt ?? 0,
    updatedAt: p.updatedAt ?? 0,
    annotation: p.annotation ?? null,
    likes: p.likes,
  };
}

function makeDoc(comments: ReviewComment[]): ReviewDoc {
  return {
    sourceKey: "s",
    versions: [{ id: "v1", label: "V1", path: "/clip.mov", addedAt: 0 }],
    activeVersionId: "v1",
    comments,
    status: {},
  };
}

// Three-note sample doc (no replies): point 38s, span 60→90s, point 253s.
const sampleDoc = makeDoc([
  mkComment({ id: "a", timeStart: 38, author: "Dana", body: "Grab a new audience reaction here", resolved: false, createdAt: 1 }),
  mkComment({ id: "b", timeStart: 60, timeEnd: 90, author: "Kim", body: "Rework the music bed through here", resolved: false, createdAt: 2 }),
  mkComment({ id: "c", timeStart: 253, author: "Lee", body: "Post music kicks in", resolved: true, createdAt: 3 }),
]);

describe("Avid .txt", () => {
  const txt = markersToAvidTxt(sampleDoc, S976, "Clip");
  const lines = txt.trimEnd().split("\n");

  it("places each note on the frame-exact absolute sequence timecode", () => {
    expect(txt).toContain("\t01:00:37:23\t"); // note a, 38s
    expect(txt).toContain("\t01:00:59:23\t"); // note b in, 60s (range start)
    expect(txt).toContain("\t01:01:29:22\t"); // note b out, 90s (range end)
    expect(txt).toContain("\t01:04:12:18\t"); // note c, 253s
  });

  it("emits exactly two bracket point markers for the spanned note", () => {
    const starts = lines.filter((l) => l.includes(">> RANGE START"));
    const ends = lines.filter((l) => l.includes("<< RANGE END"));
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(1);
    // Same author + colour on both bracket lines, one at each end.
    expect(starts[0]).toContain("01:00:59:23");
    expect(ends[0]).toContain("01:01:29:22");
    expect(starts[0].startsWith("Kim\t")).toBe(true);
    expect(ends[0].startsWith("Kim\t")).toBe(true);
  });

  it("is 5 tab-delimited columns per line with a V1 track and no header", () => {
    expect(lines[0].split("\t")).toHaveLength(5);
    expect(lines).toHaveLength(4); // 2 points + 1 span (2 bracket lines)
    for (const l of lines) expect(l.split("\t")[2]).toBe("V1");
  });
});

describe("Premiere .xml (FCP7 / XMEML)", () => {
  const xml = markersToPremiereXml(sampleDoc, S976, "Clip");

  it("uses 0-based frame counts from sequence start", () => {
    expect(xml).toContain("<in>911</in>");  // 38s
    expect(xml).toContain("<in>6066</in>"); // 253s
  });

  it("spans via <out> > <in>", () => {
    expect(xml).toContain("<in>1439</in>");
    expect(xml).toContain("<out>2158</out>");
  });

  it("marks point markers with <out>-1</out>", () => {
    const points = xml.match(/<out>-1<\/out>/g) ?? [];
    expect(points).toHaveLength(2); // the two point notes
  });

  it("carries the display Start TC in the timecode block", () => {
    expect(xml).toContain("<frame>86400</frame>");
    expect(xml).toContain("<string>01:00:00:00</string>");
    expect(xml).toContain("<ntsc>TRUE</ntsc>"); // 23.976 is NTSC
  });
});

describe("Resolve .edl (CMX3600)", () => {
  const edl = markersToResolveEdl(sampleDoc, S976, "My Review");

  it("drives spanned length through |D:<frames>", () => {
    expect(edl).toContain("|D:719"); // 60→90s span
  });

  it("uses |D:1 for point markers", () => {
    const ones = edl.match(/\|D:1(?!\d)/g) ?? [];
    expect(ones).toHaveLength(2);
  });

  it("places events on the absolute record timecode + 1-frame out", () => {
    expect(edl).toContain("01:00:37:23 01:00:38:00"); // note a rec in/out
    expect(edl).toContain("01:00:59:23 01:01:00:00"); // note b rec in/out
  });

  it("has the CMX3600 header and per-marker colour token", () => {
    expect(edl.startsWith("TITLE: My Review\nFCM: NON-DROP FRAME")).toBe(true);
    expect(edl).toMatch(/\|C:ResolveColor[A-Z][a-z]+ \|M:/);
  });
});

describe("FCPXML", () => {
  const x = markersToFcpxml(sampleDoc, S976, "My Review");

  it("frame-aligns every rational (numerator = frames × 1001)", () => {
    expect(x).toContain('start="911911/24000s"');   // note a, frame 911
    expect(x).toContain('start="1440439/24000s"');  // note b in, frame 1439
    expect(x).toContain('duration="719719/24000s"'); // note b span, 719 frames
  });

  it("carries the Start TC as tcStart", () => {
    expect(x).toContain('tcStart="86486400/24000s"');
  });

  it("gives point markers a one-frame duration", () => {
    expect(x).toContain('duration="1001/24000s"');
  });

  it("keys completed= off the resolved state and adds a keyword for spans", () => {
    expect(x).toContain('completed="1"'); // note c is resolved
    expect(x).toContain('completed="0"'); // notes a/b are open
    expect(x).toContain("<keyword "); // spanned note b gets a range keyword
  });
});

describe("CSV", () => {
  const csv = markersToCsv(sampleDoc, S976, "Clip");
  const rows = csv.trimEnd().split("\n");

  it("has the exact header", () => {
    expect(rows[0]).toBe("Name,In,Out,Duration,Color,Track,Notes");
  });

  it("leaves Out/Duration blank for point markers", () => {
    const dana = rows.find((r) => r.startsWith("Dana,")) as string;
    const cells = dana.split(",");
    expect(cells[1]).toBe("01:00:37:23"); // In = absolute timecode
    expect(cells[2]).toBe("");            // Out blank
    expect(cells[3]).toBe("");            // Duration blank
    expect(cells[5]).toBe("V1");          // Track
    expect(cells[6]).toBe("Grab a new audience reaction here"); // Notes
  });

  it("populates In+Out+Duration for the spanned note", () => {
    const kim = rows.find((r) => r.startsWith("Kim,")) as string;
    const cells = kim.split(",");
    expect(cells[1]).toBe("01:00:59:23"); // In
    expect(cells[2]).toBe("01:01:29:22"); // Out
    expect(cells[3]).toBe("00:00:29:23"); // Duration (719 frames @23.976)
  });
});

describe("reply folding", () => {
  const doc = makeDoc([
    mkComment({ id: "root", timeStart: 38, author: "Dana", body: "Reaction shot here", createdAt: 1 }),
    mkComment({ id: "r1", parentId: "root", timeStart: 38, author: "Sam", body: "agree", createdAt: 100 }),
    mkComment({ id: "r2", parentId: "root", timeStart: 38, author: "Pat", body: "will fix", createdAt: 200 }),
  ]);

  it("folds both replies onto one line in Avid (single-line format)", () => {
    const avid = markersToAvidTxt(doc, S976, "Clip");
    const lines = avid.trimEnd().split("\n");
    expect(lines).toHaveLength(1); // one root → one marker
    expect(lines[0]).toContain("Reaction shot here ↳ Sam: agree ↳ Pat: will fix");
  });

  it("folds both replies onto one line in the EDL |M: field", () => {
    const edl = markersToResolveEdl(doc, S976, "Clip");
    expect(edl).toContain("↳ Sam: agree ↳ Pat: will fix");
  });

  it("keeps replies on separate lines in the CSV Notes cell", () => {
    const csv = markersToCsv(doc, S976, "Clip");
    expect(csv).toContain("↳ Sam: agree\n↳ Pat: will fix");
    // A multiline cell must be quoted (RFC-4180).
    expect(csv).toContain('"Reaction shot here\n↳ Sam: agree\n↳ Pat: will fix"');
  });
});

// Adversarial hardening: real import files must survive hostile comment text —
// EDL pipe collisions, XML metacharacters, and raw C0 control chars pasted in.
describe("hostile-text hardening", () => {
  const hostile = makeDoc([
    mkComment({
      id: "x", timeStart: 38, author: "O'Brien & Co",
      body: 'Fix & <this> > "now" | ↳ — done', createdAt: 1,
    }),
    mkComment({ id: "y", timeStart: 60, author: "Ctl", body: "bad\x00\x07\x0B\x0C\x1Fchars", createdAt: 2 }),
  ]);

  it("EDL: a note pipe never spawns a stray |C:/|M:/|D: token", () => {
    const edl = markersToResolveEdl(hostile, S976, "T");
    const tokenLines = edl.split("\n").filter((l) => l.startsWith(" |C:"));
    expect(tokenLines).toHaveLength(2);
    for (const l of tokenLines) {
      expect((l.match(/\|/g) ?? []).length).toBe(3); // exactly |C: |M: |D:
      expect(l).toMatch(/^ \|C:ResolveColor\w+ \|M:.* \|D:\d+$/);
    }
    expect(edl).not.toContain('"now" |'); // the body pipe was replaced, not kept
  });

  it("Premiere XML escapes every metacharacter (no raw & < >)", () => {
    const xml = markersToPremiereXml(hostile, S976, 'Title & <x>');
    expect(xml).toContain("O&apos;Brien &amp; Co");
    expect(xml).toContain("Fix &amp; &lt;this&gt; &gt; &quot;now&quot;");
    // No unescaped ampersand anywhere.
    expect(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(xml)).toBe(false);
  });

  it("FCPXML escapes attribute values (no raw & < >)", () => {
    const x = markersToFcpxml(hostile, S976, "T");
    expect(x).toContain('value="O&apos;Brien &amp; Co"');
    expect(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/.test(x)).toBe(false);
  });

  it("strips XML-illegal C0 control chars from every format", () => {
    const hasCtl = (s: string) => /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s);
    expect(hasCtl(markersToAvidTxt(hostile, S976, "T"))).toBe(false);
    expect(hasCtl(markersToPremiereXml(hostile, S976, "T"))).toBe(false);
    expect(hasCtl(markersToResolveEdl(hostile, S976, "T"))).toBe(false);
    expect(hasCtl(markersToFcpxml(hostile, S976, "T"))).toBe(false);
    expect(hasCtl(markersToCsv(hostile, S976, "T"))).toBe(false);
  });
});

describe("colour snapping", () => {
  it("snaps hues to the canonical 8", () => {
    expect(nearestCanonicalColor("#ff0000")).toBe("red");
    expect(nearestCanonicalColor("#00ff00")).toBe("green");
    expect(nearestCanonicalColor("#00ffff")).toBe("cyan");
    expect(nearestCanonicalColor("#ffffff")).toBe("white");
    expect(nearestCanonicalColor("#000000")).toBe("black");
  });

  it("snaps to Resolve's fixed 16 names", () => {
    expect(nearestResolveColor("#ff0000")).toBe("Red");
    expect(nearestResolveColor("#00ffff")).toBe("Cyan");
    expect(nearestResolveColor("#00ff00")).toBe("Green");
  });
});
