import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * `--download-sections` must never ride along with the concurrent downloader.
 *
 * It switches yt-dlp off its native fragment downloader and onto a
 * SINGLE-CONNECTION ffmpeg read of the source URL, which YouTube throttles to
 * roughly real time. Every `--concurrent-fragments` and `--http-chunk-size`
 * on the same command becomes inert.
 *
 * Measured on a real 2h11m 1.18 GB source:
 *
 *   section download of a 60s clip : 54.5s  @ 285 KB/s
 *   the WHOLE FILE, flags working  : <25s   @ 47.3 MB/s
 *   local lossless cut of 5m17s    : 0.15s
 *
 * The entire file arrives faster than one minute of it did, so there is no
 * clip length at which sectioning wins and no threshold worth having.
 *
 * This is a contract rather than a comment because it was already FOUND,
 * measured and written down once, in transcript.rs, and the two export paths
 * kept the flag anyway - one of them under a nine-line comment claiming the
 * concurrency it had just disabled was "the actual 10x speedup". A note in
 * one file did not stop it; a failing test will.
 *
 * The range is cut afterwards, locally, by ffmpeg.
 */

const CMD_DIR = join(__dirname, "../../src-tauri/src/commands");

/** Rust source with comments stripped: this rule is ABOUT what the comments say. */
function code(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

function rustFiles(): { name: string; text: string }[] {
  return readdirSync(CMD_DIR)
    .filter((f) => f.endsWith(".rs"))
    .map((name) => ({ name, text: code(readFileSync(join(CMD_DIR, name), "utf8")) }));
}

describe("the downloader is never silently single-connection", () => {
  const files = rustFiles();

  it("reads the command sources at all, so the rule cannot pass vacuously", () => {
    expect(files.length).toBeGreaterThan(4);
    const withYtdlp = files.filter((f) => f.text.includes("concurrent-fragments"));
    expect(
      withYtdlp.length,
      "no file asks for concurrent fragments — either the flag was renamed or this scan broke",
    ).toBeGreaterThan(0);
  });

  it("passes --download-sections nowhere", () => {
    const offenders = files
      .filter((f) => f.text.includes("--download-sections"))
      .map((f) => f.name);
    expect(
      offenders,
      "--download-sections cancels the concurrent downloader and costs ~160x throughput.\n" +
        "Download the source and cut the range locally with ffmpeg instead:\n",
    ).toEqual([]);
  });

  it("still asks for concurrency on every path that had it", () => {
    // COUNTS, not presence. media.rs has two download paths, video and audio,
    // and an earlier version of this test only asked whether the file
    // mentioned the flag anywhere - so deleting the concurrency from ONE of
    // them left it green. That is the same "passes by finding something else"
    // failure the rest of this suite keeps meeting; the mutation that exposed
    // it removed exactly one of the two.
    //
    // A floor, so adding a path is free and losing one is not.
    const floor: Record<string, number> = { "media.rs": 2, "download.rs": 2 };
    for (const [name, want] of Object.entries(floor)) {
      const f = files.find((x) => x.name === name);
      expect(f, `${name} is gone`).toBeTruthy();
      const got = f!.text.split('"--concurrent-fragments"').length - 1;
      expect(got, `${name} lost a concurrent download path (${got} left, ${want} expected)`)
        .toBeGreaterThanOrEqual(want);
    }
  });

  it("sizes the chunks wherever it asks for concurrency", () => {
    for (const f of files.filter((x) => x.text.includes('"--concurrent-fragments"'))) {
      expect(f.text, `${f.name} asks for concurrency without sizing its chunks`)
        .toContain('"--http-chunk-size"');
    }
  });
});
