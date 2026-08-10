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
