import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, TRANSCRIPT_EXTENSIONS,
  fileExtension, isMediaFile, isTranscriptFile, mediaKindOf,
} from "./import-extensions";

const RUST = resolve(__dirname, "../../src-tauri/src/commands/library.rs");

/** The `const NAME: &[&str] = &["a", "b"];` list from the Rust scanner. */
function rustList(name: string): string[] {
  const src = readFileSync(RUST, "utf8");
  const m = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(src);
  if (!m) throw new Error(`${name} not found in library.rs — the matcher broke, not the code`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * The two extension lists that must agree across the IPC boundary.
 *
 * library.rs decides what the scanner puts on a shelf; import-extensions.ts
 * decides what the app will open. Its Rust counterpart already carries the
 * rule — "add it HERE too (and vice versa)" — and a comment is exactly the
 * kind of enforcement this loop keeps finding on the losing side of a drift.
 *
 * Neither direction fails loudly. Add one to TS alone and a file the user can
 * drag in never appears in their library. Add one to Rust alone and it appears
 * on the shelf and then does nothing when clicked, because isMediaFile says no.
 */
describe("media extensions agree with the Rust scanner", () => {
  it("has the same video list on both sides", () => {
    expect([...VIDEO_EXTENSIONS].sort()).toEqual(rustList("VIDEO_EXTENSIONS").sort());
  });

  it("has the same audio list on both sides", () => {
    expect([...AUDIO_EXTENSIONS].sort()).toEqual(rustList("AUDIO_EXTENSIONS").sort());
  });

  it("really is reading the Rust file, not an empty match", () => {
    // A scraper's failure mode is matching nothing and calling it agreement.
    expect(rustList("VIDEO_EXTENSIONS").length).toBeGreaterThan(3);
    expect(rustList("AUDIO_EXTENSIONS").length).toBeGreaterThan(3);
  });

  it("keeps transcripts OUT of the media lists", () => {
    // library.rs says so deliberately: "the library browses playable media
    // only". An .srt on a video shelf would be a row that cannot be played.
    for (const t of TRANSCRIPT_EXTENSIONS) {
      expect(VIDEO_EXTENSIONS).not.toContain(t);
      expect(AUDIO_EXTENSIONS).not.toContain(t);
    }
  });

  it("never classes one extension as both video and audio", () => {
    // mediaKindOf checks audio first, so an overlap would silently make a
    // video file render with waveform art and no picture.
    expect(VIDEO_EXTENSIONS.filter((v) => AUDIO_EXTENSIONS.includes(v))).toEqual([]);
  });
});

describe("fileExtension", () => {
  it("reads the extension regardless of case", () => {
    expect(fileExtension("/lib/CLIP.MP4")).toBe("mp4");
    expect(isMediaFile("/lib/CLIP.MOV")).toBe(true);
  });

  it("treats a dotfile as having no extension", () => {
    // `.hidden` is a name, not an extension — hence `dot > 0`, not `>= 0`.
    expect(fileExtension("/lib/.hidden")).toBe("");
    expect(isMediaFile("/lib/.mp4")).toBe(false);
  });

  it("ignores dots in the directories above it", () => {
    expect(fileExtension("/My.Project.v2/clip")).toBe("");
    expect(fileExtension("/My.Project.v2/clip.mov")).toBe("mov");
  });

  it("handles a trailing dot and a bare name", () => {
    expect(fileExtension("/lib/clip.")).toBe("");
    expect(fileExtension("clip.mp4")).toBe("mp4"); // no separator at all
    expect(fileExtension("")).toBe("");
  });

  it("classifies by extension, not by hope", () => {
    expect(isMediaFile("/lib/notes.txt")).toBe(false);
    expect(isTranscriptFile("/lib/notes.srt")).toBe(true);
    expect(isTranscriptFile("/lib/clip.mov")).toBe(false);
    expect(mediaKindOf("/lib/take.wav")).toBe("audio");
    expect(mediaKindOf("/lib/take.mov")).toBe("video");
  });

  it("calls an unknown extension video, which is the fallback callers rely on", () => {
    // mediaKindOf has no "unknown": anything not audio is video. Worth pinning
    // because it means a new AUDIO extension added to only one of the two
    // lists shows up as a video file rather than as an error.
    expect(mediaKindOf("/lib/mystery.xyz")).toBe("video");
  });
});
