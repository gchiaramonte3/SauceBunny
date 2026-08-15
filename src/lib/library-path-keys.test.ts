// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  chosenPosterFor, setChosenPoster, clearChosenPoster, loadChosenPosters,
  sourceTimecodeFor, setSourceTimecode, clearSourceTimecode,
} from "./library";
import { repathIdentity } from "./rename-apply";

/**
 * Path keys survive macOS filename encoding.
 *
 * macOS stores filenames DECOMPOSED. A rename dialog hands back whatever the
 * keyboard sent, which is COMPOSED. Both render identically, so:
 *
 *   rename "clip.mov" to "café.mov"  -> poster stored under the composed key
 *   next library scan                 -> asks with the decomposed path
 *   answer                            -> null
 *
 * The chosen poster frame and the source timecode are simply gone, on that one
 * file, with nothing on screen to explain it. Measured before the fix: the
 * lookup with the typed path returned 12 and the lookup with the scanned path
 * returned null.
 *
 * Same root cause as the library SEARCH fix, one layer down in the key space.
 */
const NFC = "café.mov";                  // as typed
const NFD = NFC.normalize("NFD");        // as the filesystem stores it

describe("poster and timecode keys are encoding-agnostic", () => {
  beforeEach(() => localStorage.clear());

  it("the two spellings really are different strings", () => {
    // Guards the fixture itself: if these ever compared equal, every test
    // below would pass for the wrong reason.
    expect(NFC).not.toBe(NFD);
    expect(NFC.normalize("NFC")).toBe(NFD.normalize("NFC"));
  });

  it("finds a poster stored under the typed name when the scan asks decomposed", () => {
    setChosenPoster(`/lib/${NFC}`, 12);
    expect(chosenPosterFor(`/lib/${NFD}`)).toBe(12);
  });

  it("and the other way round, for a file that was never renamed", () => {
    setChosenPoster(`/lib/${NFD}`, 7);
    expect(chosenPosterFor(`/lib/${NFC}`)).toBe(7);
  });

  it("keeps the poster across a rename to an accented name", () => {
    // The whole chain, which is how this reaches a user.
    setChosenPoster("/lib/clip.mov", 12);
    repathIdentity("/lib/clip.mov", `/lib/${NFC}`, {});
    expect(chosenPosterFor(`/lib/${NFD}`)).toBe(12);
  });

  it("keeps the source timecode across the same rename", () => {
    setSourceTimecode("/lib/clip.mov", "01:00:00:00");
    repathIdentity("/lib/clip.mov", `/lib/${NFC}`, {});
    expect(sourceTimecodeFor(`/lib/${NFD}`)).toBe("01:00:00:00");
  });

  it("clears by either spelling", () => {
    setChosenPoster(`/lib/${NFC}`, 3);
    clearChosenPoster(`/lib/${NFD}`);
    expect(chosenPosterFor(`/lib/${NFC}`)).toBe(null);

    setSourceTimecode(`/lib/${NFD}`, "02:00:00:00");
    clearSourceTimecode(`/lib/${NFC}`);
    expect(sourceTimecodeFor(`/lib/${NFD}`)).toBe(null);
  });

  it("migrates a map an older build wrote, on read", () => {
    // No migration step is needed: load normalises, so the first read of a
    // map written by an older build canonicalises it.
    //
    // Asserted through loadChosenPosters rather than chosenPosterFor on
    // purpose. chosenPosterFor reads a module-level cache that only this
    // module's own writes invalidate, so a map that appears in localStorage
    // by some other route is not picked up until something calls a setter or
    // the process restarts. That is true of the app as well as the test, and
    // worth knowing rather than working around here.
    localStorage.setItem("saucebunny.libraryThumbTimes", JSON.stringify({ [`/lib/${NFD}`]: 5 }));
    expect(Object.keys(loadChosenPosters())).toEqual([`/lib/${NFC}`]);
  });

  it("still treats case as significant", () => {
    // repath.ts turns on the stores being case-SENSITIVE, so a case-only
    // rename does the identity work. Folding case here would undo that.
    setChosenPoster("/lib/Clip.mov", 4);
    expect(chosenPosterFor("/lib/clip.mov")).toBe(null);
  });
});
