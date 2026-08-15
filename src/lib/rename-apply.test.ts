// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { repathIdentity } from "./rename-apply";
import { loadChosenPosters, setChosenPoster, setSourceTimecode, sourceTimecodeFor, chosenPosterFor } from "./library";
import { linkFingerprint, resolveByFingerprint, reviewFingerprint } from "./review";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));

/**
 * The failure this file exists to prevent has no error message. A renamed clip
 * whose review stayed on the old fingerprint still has its notes on disk and
 * its media on disk; they simply stop finding each other, and it reads as the
 * app having lost the notes.
 */

const OLD = "/m/Interview Final.mp4";
const NEW = "/m/Interview Approved.mp4";
const ID = { durationSec: 237.9, width: 1920, height: 1080, sizeBytes: 12_345_678 };

beforeEach(() => localStorage.clear());

describe("the review follows the rename", () => {
  it("resolves the NEW name to the review the old name owned", () => {
    const oldFp = reviewFingerprint("Interview Final.mp4", 237.9, 1920, 1080, 12_345_678);
    linkFingerprint(oldFp, "/m/some-review-key.mp4");

    repathIdentity(OLD, NEW, ID);

    const newFp = reviewFingerprint("Interview Approved.mp4", 237.9, 1920, 1080, 12_345_678);
    expect(resolveByFingerprint(newFp)).toBe("/m/some-review-key.mp4");
  });

  it("falls back to the OLD PATH when the file had no review yet", () => {
    // A clip with no notes still gets linked, so notes taken AFTER the rename
    // land on the key the app would have used all along.
    repathIdentity(OLD, NEW, ID);
    const newFp = reviewFingerprint("Interview Approved.mp4", 237.9, 1920, 1080, 12_345_678);
    expect(resolveByFingerprint(newFp)).toBe(OLD);
  });

  it("SKIPS the review link when duration is unknown, rather than guessing", () => {
    // A fingerprint built from guessed numbers would point the new name at
    // somebody else's review, which is far worse than leaving it unlinked.
    repathIdentity(OLD, NEW, { durationSec: null, width: 1920, height: 1080, sizeBytes: 1 });
    const newFp = reviewFingerprint("Interview Approved.mp4", 0, 1920, 1080, 1);
    expect(resolveByFingerprint(newFp)).toBeNull();
  });
});

describe("the poster and timecode follow too", () => {
  it("moves a chosen poster to the new path", () => {
    setChosenPoster(OLD, 42);
    repathIdentity(OLD, NEW, ID);
    expect(chosenPosterFor(NEW)).toBe(42);
    expect(chosenPosterFor(OLD)).toBeNull();
  });

  it("moves a source timecode to the new path", () => {
    setSourceTimecode(OLD, "01:00:00:00");
    repathIdentity(OLD, NEW, ID);
    expect(sourceTimecodeFor(NEW)).toBe("01:00:00:00");
    expect(sourceTimecodeFor(OLD)).toBeNull();
  });

  it("leaves other files' records alone", () => {
    setChosenPoster("/m/other.mp4", 7);
    setChosenPoster(OLD, 42);
    repathIdentity(OLD, NEW, ID);
    expect(chosenPosterFor("/m/other.mp4")).toBe(7);
  });

  it("does nothing at all for a no-op rename", () => {
    setChosenPoster(OLD, 42);
    const before = JSON.stringify(loadChosenPosters());
    repathIdentity(OLD, OLD, ID);
    expect(JSON.stringify(loadChosenPosters())).toBe(before);
  });

  it("handles a CASE-ONLY rename, which the stores see as a different key", () => {
    // The filesystem is case-insensitive; localStorage is not. Skipping this
    // leaves the poster on a key nothing will ever ask for again.
    const cased = "/m/interview final.mp4";
    setChosenPoster(cased, 9);
    repathIdentity(cased, "/m/Interview Final.mp4", ID);
    expect(chosenPosterFor("/m/Interview Final.mp4")).toBe(9);
  });
});

describe("review identity survives macOS filename encoding", () => {
  // The highest-stakes member of this family. macOS stores filenames
  // DECOMPOSED; a rename dialog returns what the keyboard sent, which is
  // COMPOSED. Unnormalised, the same file fingerprints two different ways, so
  // renaming a video to an accented name meant opening it later and finding no
  // review. The notes were never destroyed - they sat on disk under the old
  // key, which is exactly why nothing looked broken.
  const NFC = "Café Interview.mov";
  const NFD = NFC.normalize("NFD");

  it("the two spellings really are different strings", () => {
    expect(NFC).not.toBe(NFD);
  });

  it("fingerprints a file the same whichever spelling asks", () => {
    expect(reviewFingerprint(NFC, 237.9, 1920, 1080, 12_345_678))
      .toBe(reviewFingerprint(NFD, 237.9, 1920, 1080, 12_345_678));
  });

  it("resolves a review linked under one spelling when asked with the other", () => {
    const fp = reviewFingerprint(NFD, 237.9, 1920, 1080, 12_345_678);
    linkFingerprint(fp, "/reviews/interview");
    expect(resolveByFingerprint(reviewFingerprint(NFC, 237.9, 1920, 1080, 12_345_678)))
      .toBe("/reviews/interview");
  });

  it("recovers an index entry written before fingerprints were normalised", () => {
    // The legacy shape: a raw decomposed key, straight into the index.
    const legacy = `${NFD.toLowerCase().replace(/\.[^.]+$/, "")}|2379|1920x1080|12345678`;
    linkFingerprint(legacy, "/reviews/old");
    expect(resolveByFingerprint(reviewFingerprint(NFC, 237.9, 1920, 1080, 12_345_678)))
      .toBe("/reviews/old");
  });

  it("still tells genuinely different files apart", () => {
    const a = reviewFingerprint("Interview A.mov", 237.9, 1920, 1080, 1);
    const b = reviewFingerprint("Interview B.mov", 237.9, 1920, 1080, 1);
    expect(a).not.toBe(b);
  });
});

