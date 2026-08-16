import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The dictation sidecar's line protocol, which fails by blaming the user.
 *
 * `saucebunny-dictate` writes one JSON object per line to stdout and Rust
 * reads the keys off it untyped, the same way it reads the diarizer envelope.
 * The consequence is worse here. If the Swift side renamed `partial`, Rust
 * would never see a partial or a final, the process would exit without `done`,
 * and the fallback would report:
 *
 *     "I didn't catch any words. Try again."
 *
 * A broken contract, presented to the user as their own diction. Nothing logs
 * an error, nothing exits non-zero, and the obvious next move — speaking more
 * clearly — cannot work.
 *
 * WHY THIS SHAPE KEEPS APPEARING, and where it does not: the screen-capture
 * sidecar's list output is deserialized into a TYPED struct
 * (`serde_json::from_slice::<RawList>` in media.rs, with non-optional
 * `displays` and `windows`), so a rename there fails deserialization and
 * reaches `fallback()` with a parse error. Untyped `.get("field")` with a
 * default is what turns a rename into silence. Two of the three sidecars parse
 * that way; this pins the second of them.
 */

const ROOT = resolve(__dirname, "../..");
const swift = readFileSync(
  join(ROOT, "swift-sidecar/Sources/saucebunny-dictate/main.swift"), "utf8");
const rust = readFileSync(join(ROOT, "src-tauri/src/commands/transcript.rs"), "utf8");

/** Keys Swift emits, from every `emit([...])` literal. */
function emittedKeys(): Set<string> {
  const out = new Set<string>();
  for (const m of swift.matchAll(/emit\(\[([\s\S]*?)\]\)/g)) {
    for (const k of m[1].matchAll(/"(\w+)"\s*:/g)) out.add(k[1]);
  }
  return out;
}

/** Keys Rust pulls off a parsed dictate line. */
function readKeys(): Set<string> {
  const region = /sidecar\("saucebunny-dictate"\)[\s\S]*?\n\}/.exec(rust);
  const scope = region ? region[0] : rust;
  return new Set([...scope.matchAll(/v\.get\("(\w+)"\)/g)].map((m) => m[1]));
}

describe("the dictate line protocol", () => {
  const emitted = emittedKeys();
  const read = readKeys();

  it("found both sides to compare", () => {
    // A contract that parses nothing passes forever.
    expect(emitted.size, "no emit([...]) keys parsed out of the Swift source").toBeGreaterThan(3);
    expect(read.size, "no v.get() keys parsed out of the Rust reader").toBeGreaterThan(2);
  });

  it("emits every key Rust depends on", () => {
    // The direction that matters. Rust reading a key Swift no longer sends is
    // the silent path: no partial, no final, and a message telling the user to
    // speak up.
    const missing = [...read].filter((k) => !emitted.has(k)).sort();
    expect(missing, "Rust reads these off a dictate line and Swift no longer sends them").toEqual([]);
  });

  it("carries the text on EVERY line that reports finality", () => {
    // The invariant a key-presence check misses, and a break-test proved it:
    // renaming `partial` at the recognition site left this file green, because
    // a SECOND emit site (`emit(["partial": "", "final": true])`) still
    // mentioned the key. Rust reads the pair together — it looks up `partial`
    // first and only then consults `final` — so a line carrying one without
    // the other is dropped entirely, which is the silent path.
    const finalSites = [...swift.matchAll(/emit\(\[([\s\S]*?)\]\)/g)]
      .map((m) => m[1])
      .filter((body) => /"final"\s*:/.test(body));
    expect(finalSites.length, "no emit site mentions `final` — the matcher broke")
      .toBeGreaterThan(1);
    for (const body of finalSites) {
      expect(body, `an emit with "final" but no "partial": ${body.trim()}`)
        .toMatch(/"partial"\s*:/);
    }
  });

  it("names the four keys the feature actually runs on", () => {
    // Spelled out rather than derived, so a rename has to be a deliberate edit
    // here as well as in two languages.
    for (const k of ["partial", "final", "level", "error"]) {
      expect(emitted.has(k), `Swift stopped emitting "${k}"`).toBe(true);
      expect(read.has(k), `Rust stopped reading "${k}"`).toBe(true);
    }
  });

  it("records `info` as emitted-but-unread, which is the current arrangement", () => {
    // Swift sends `info` for "listening" and the locale line; Rust reads
    // neither. Not a defect — but it means the sidecar's readiness signal
    // reaches nothing, so the UI cannot show "listening" before the first
    // partial arrives. Pinned so wiring it up is a deliberate change rather
    // than a surprise, and so nobody assumes it is already plumbed.
    expect(emitted.has("info")).toBe(true);
    expect(read.has("info")).toBe(false);
  });
});
