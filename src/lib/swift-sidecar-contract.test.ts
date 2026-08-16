import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Three rules CLAUDE.md states for swift-sidecar/, none of which anything
 * checked. CI builds the package, which proves it COMPILES - not that it
 * compiles against the things it is allowed to use.
 *
 * The WhisperKit rule is the reason this file exists. As written it reads "do
 * not introduce a WhisperKit dependency", and a grep for WhisperKit under
 * swift-sidecar/ returns four hits - so the rule looks violated. It is not:
 * every hit is inside .build/checkouts, the vendored source of
 * argmax-oss-swift, which IS a declared dependency because it ships SpeakerKit
 * (the primary diarizer CLAUDE.md itself names). WhisperKit and SpeakerKit are
 * two products of one package.
 *
 * That distinction is invisible to a reader doing the obvious check, and it
 * cost a real investigation before this was written. So the rule is expressed
 * here as what it actually means - OUR sources must not import WhisperKit;
 * whisper.cpp is the transcription engine - and the vendored tree is excluded
 * where a human would forget to exclude it.
 */

const ROOT = resolve(__dirname, "../..");
const SIDECAR = join(ROOT, "swift-sidecar");

/** Our Swift, never .build/ (vendored dependency source, not ours to police). */
function ourSwiftFiles(dir = join(SIDECAR, "Sources"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === ".build") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) ourSwiftFiles(full, out);
    else if (entry.endsWith(".swift")) out.push(full);
  }
  return out;
}

const sources = ourSwiftFiles();

describe("the Swift sidecar stays macOS-native and off WhisperKit", () => {
  it("scans the sidecar sources it claims to check", () => {
    // A walker pointed at the wrong directory would certify everything by
    // finding nothing - which is how a sibling contract test in this repo
    // passed over zero files.
    expect(sources.length, "no Swift sources scanned").toBeGreaterThanOrEqual(3);
    expect(sources.some((f) => f.includes("saucebunny-diarize"))).toBe(true);
  });

  it("never imports UIKit", () => {
    // This is macOS, not iOS. A UIKit import does not fail a macOS build with
    // a message anyone reads as "wrong platform" - it fails as a missing
    // module, which reads like a broken toolchain.
    const bad = sources.filter((f) => /^\s*import\s+UIKit\b/m.test(readFileSync(f, "utf8")));
    expect(bad.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it("never imports WhisperKit — whisper.cpp is the transcription engine", () => {
    // SpeakerKit, from the SAME package, is allowed and is what the diarizer
    // uses. The line is the product, not the repository.
    const bad = sources.filter((f) => /^\s*import\s+WhisperKit\b/m.test(readFileSync(f, "utf8")));
    expect(bad.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it("uses AVFoundation for audio loading", () => {
    // The positive half of the WhisperKit rule: the diarizer decodes audio
    // itself rather than borrowing a helper from an ASR framework.
    const diarizer = sources.find((f) => f.includes("saucebunny-diarize"))!;
    expect(readFileSync(diarizer, "utf8")).toMatch(/^\s*import\s+AVFoundation\b/m);
  });

  it("keeps no Xcode project in git — SPM generates those on demand", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(xcodeproj|xcworkspace)(\/|$)/.test(f));
    expect(tracked).toEqual([]);
  });

  it("declares argmax-oss-swift for SpeakerKit, not for WhisperKit", () => {
    // Pins the reason the package is here. If someone ever adds the WhisperKit
    // product to a target, this fails and points at the rule above.
    const pkg = readFileSync(join(SIDECAR, "Package.swift"), "utf8");
    expect(pkg).toMatch(/\.product\(name:\s*"SpeakerKit"/);
    expect(pkg).not.toMatch(/\.product\(name:\s*"WhisperKit"/);
  });
});
