import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The diarizer's two boundaries, both of which fail SILENTLY.
 *
 * CLAUDE.md calls the JSON envelope "a contract between Swift, Rust, and JS".
 * It is really two contracts with different shapes, and knowing which is which
 * matters because they break differently:
 *
 *   Swift → Rust   the envelope. `turns[].{speaker,start,end}`.
 *   Rust  → JS     the SRT label. `[SPEAKER_00] text`, and the `SPEAKER_UNK`
 *                  sentinel Rust writes when a cue matches no turn.
 *
 * JS never opens the envelope — Rust merges the turns into the SRT and the
 * viewer parses labels out of that. (Checked: `schema_version` appears nowhere
 * under src/.)
 *
 * WHY THIS NEEDS A TEST. `parse_diarizer_json` is deliberately forgiving —
 * a missing `speaker` becomes SPEAKER_UNK, a missing `start` becomes 0.0, a
 * missing `end` becomes `start` — and then drops any turn where `end > start`
 * is false. So renaming ONE field in the Swift emitter does not raise: every
 * turn collapses to 0.0/0.0, every turn is dropped, and `parse_diarizer_json`
 * returns `Ok(vec![])`. The user gets a transcript with no speakers and an
 * "Speakers not detected" notification that reads like a legitimate outcome.
 * A whole feature turns itself off and every layer reports success.
 *
 * `schema_version` cannot catch it either: Swift emits it and Rust never reads
 * it, so it is documentation rather than a guard. That is fine — the merge only
 * needs turns — but it means the version number buys nothing here, which is
 * worth knowing before relying on it.
 */

const ROOT = resolve(__dirname, "../..");
const swift = readFileSync(
  join(ROOT, "swift-sidecar/Sources/saucebunny-diarize/main.swift"), "utf8");
const rust = readFileSync(join(ROOT, "src-tauri/src/commands/transcript.rs"), "utf8");
const srtTs = readFileSync(join(ROOT, "src/lib/srt.ts"), "utf8");

/** Keys in Swift's `turnsJSON` map literal. */
function swiftTurnKeys(): string[] {
  const m = /turns\.map\s*\{[\s\S]*?\[([\s\S]*?)\]\s*\}/.exec(swift);
  if (!m) return [];
  return [...m[1].matchAll(/"(\w+)"\s*:/g)].map((x) => x[1]).sort();
}

/** Keys `parse_diarizer_json` pulls off each turn. */
function rustTurnKeys(): string[] {
  const fn = /fn parse_diarizer_json[\s\S]*?\n\}/.exec(rust);
  if (!fn) return [];
  return [...new Set([...fn[0].matchAll(/t\.get\("(\w+)"\)/g)].map((x) => x[1]))].sort();
}

describe("Swift → Rust: the turn envelope", () => {
  it("found both sides to compare", () => {
    // A contract that parses nothing passes forever; this repo has shipped
    // four checks that did exactly that.
    expect(swiftTurnKeys().length, "no turn keys parsed out of the Swift emitter")
      .toBeGreaterThan(2);
    expect(rustTurnKeys().length, "no turn keys parsed out of parse_diarizer_json")
      .toBeGreaterThan(2);
  });

  it("emits exactly the fields Rust reads", () => {
    // Rename one on either side and diarization silently returns zero turns.
    expect(swiftTurnKeys()).toEqual(rustTurnKeys());
  });

  it("still names the array `turns`, which is the one hard error Rust raises", () => {
    // The single field whose absence DOES fail loudly ("diarizer json missing
    // `turns` array"). Worth pinning precisely because it is the exception.
    expect(swift).toMatch(/"turns"\s*:/);
    expect(rust).toMatch(/\.get\("turns"\)/);
  });
});

describe("Rust → JS: the label convention", () => {
  it("agrees on the SPEAKER_UNK sentinel", () => {
    // Rust writes this for a cue that matched no turn; the viewer has to
    // recognise it as "unattributed" rather than as a person named
    // SPEAKER_UNK, which is what it would render otherwise.
    expect(rust).toContain("SPEAKER_UNK");
    expect(srtTs).toContain("SPEAKER_UNK");
  });

  it("agrees on the machine-label prefix", () => {
    // `SPEAKER_00` is generated in Swift, carried through Rust, and matched by
    // the SRT parser. Three files, one string, no compiler between them.
    expect(swift).toMatch(/SPEAKER_/);
    expect(srtTs).toMatch(/SPEAKER_/);
  });
});

describe("schema_version", () => {
  it("is emitted by Swift and read by nobody, which is worth stating", () => {
    // Not a defect — the merge only needs `turns`. But a version field nobody
    // validates offers no protection, so this pins the CURRENT arrangement:
    // if Rust ever starts checking it, this test should be updated to match
    // rather than left asserting the old freedom.
    expect(swift).toContain('"schema_version"');
    expect(rust).not.toMatch(/get\("schema_version"\)/);
  });
});
