import { beforeEach, describe, expect, it, vi } from "vitest";
import { CustomSource, UrlSource } from "mediabunny";

/**
 * Which mediabunny Source a path gets, and why it matters.
 *
 * This is a two-line function guarding a real failure. `UrlSource` range-fetches
 * over Tauri's `asset://` protocol, and that STALLS on large local files — an
 * 800 MB h264/aac mp4 never loads, which is the bug `localFileSource` exists to
 * avoid by doing native byte-range reads instead. Route a local path to
 * `UrlSource` and large files break; route the loopback proxy URL to
 * `localFileSource` and `read_file_range` is handed an http URL as a filesystem
 * path. Both branches are live: nine call sites pass local paths, and the
 * web-stream path passes `http://127.0.0.1:…`.
 *
 * `CustomSource` and `UrlSource` here are the REAL mediabunny classes, not
 * stubs, so `instanceof` is a genuine check of what the app will construct.
 * Only `invoke` is mocked, because the alternative is a real 800 MB file.
 *
 * The `read` callback turned out to be drivable through the public API after
 * all: `getSize()` starts mediabunny's prefetch, which calls it. That is how the
 * offset/length mapping below is exercised without a real container — and
 * mediabunny validates that a read returns exactly the requested byte count, so
 * a wrong length here fails loudly rather than silently.
 */

/**
 * Sizes keyed by PATH, not one global number.
 *
 * A single shared size cross-contaminates: `getSize()` starts a prefetch that
 * outlives the test, so a read for the 812 MB file can land after the next test
 * has set the size to something smaller — the orchestrator then reads past EOF
 * and throws inside mediabunny. Every test still passed; the run failed on an
 * unhandled rejection, which vitest reports separately and CI treats as a
 * non-zero exit. Per-path sizes make a late read from any source satisfiable.
 */
const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: unknown }>,
  sizes: new Map<string, number>(),
  defaultSize: 8_000_000,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "get_file_size") {
      const { path } = args as { path: string };
      return h.sizes.get(path) ?? h.defaultSize;
    }
    // Must honour the requested length: mediabunny validates that a read
    // returns exactly what it asked for, and a short buffer throws.
    if (cmd === "read_file_range") return new ArrayBuffer((args as { length: number }).length);
    return undefined;
  },
}));

// Imported after the mock is declared, which vi.mock hoisting guarantees.
const { localFileSource, mediabunnySource } = await import("./mediabunny-source");

// Calls are cleared per test; sizes are NOT, so an in-flight prefetch from an
// earlier test still gets a consistent answer.
beforeEach(() => { h.calls.length = 0; });

describe("routing a URL to UrlSource", () => {
  it("sends http and https to UrlSource", () => {
    expect(mediabunnySource("http://127.0.0.1:9123/fmp4/v1/abc")).toBeInstanceOf(UrlSource);
    expect(mediabunnySource("https://example.com/a.mp4")).toBeInstanceOf(UrlSource);
  });

  it("is case-insensitive, so an uppercased scheme is not read as a file path", () => {
    // The regex carries /i. Without it, "HTTPS://…" would be handed to
    // read_file_range as though it were a path on disk.
    expect(mediabunnySource("HTTP://127.0.0.1/x")).toBeInstanceOf(UrlSource);
    expect(mediabunnySource("HtTpS://example.com/a.mp4")).toBeInstanceOf(UrlSource);
  });
});

describe("routing a path to localFileSource", () => {
  it("sends an absolute POSIX path to CustomSource", () => {
    // The case the module exists for: native byte-range reads, not asset://.
    expect(mediabunnySource("/Users/me/Movies/big.mp4")).toBeInstanceOf(CustomSource);
  });

  it("sends a path containing spaces and unicode to CustomSource", () => {
    expect(mediabunnySource("/Users/me/My Films/café 🎬.mov")).toBeInstanceOf(CustomSource);
  });

  it("is anchored, so 'https://' inside a filename does not fool it", () => {
    // A real filename can contain the substring. Only a leading scheme counts.
    expect(mediabunnySource("/Users/me/notes about https://x.mp4")).toBeInstanceOf(CustomSource);
    expect(mediabunnySource("/tmp/http://weird.mp4")).toBeInstanceOf(CustomSource);
  });

  it("treats a relative path as local", () => {
    expect(mediabunnySource("clip.mp4")).toBeInstanceOf(CustomSource);
    expect(mediabunnySource("./clip.mp4")).toBeInstanceOf(CustomSource);
  });

  it("treats the empty string as local rather than throwing", () => {
    // Reaching here at all is a caller bug, but it must fail later at
    // get_file_size with a real error, not throw while choosing a source.
    expect(() => mediabunnySource("")).not.toThrow();
    expect(mediabunnySource("")).toBeInstanceOf(CustomSource);
  });
});

describe("boundaries worth knowing about", () => {
  it("treats a file:// URL as a local PATH, which would not resolve", () => {
    // Pinned as a known boundary, not a bug: nothing in the app constructs a
    // file:// URL (checked), so this never fires today. If a future caller
    // starts producing them, `read_file_range` receives "file:///Users/…" as a
    // path and fails — and this test is where that expectation is written down.
    expect(mediabunnySource("file:///Users/me/a.mp4")).toBeInstanceOf(CustomSource);
  });

  it("treats a leading-whitespace URL as a local path", () => {
    // The regex is anchored at ^, so " https://x" is not a URL to it. Recorded
    // so the behaviour is a decision rather than a surprise; callers should not
    // be passing untrimmed input.
    expect(mediabunnySource(" https://example.com/a.mp4")).toBeInstanceOf(CustomSource);
  });

  it("treats a protocol-relative URL as a local path", () => {
    expect(mediabunnySource("//example.com/a.mp4")).toBeInstanceOf(CustomSource);
  });
});

describe("the size path, which is public", () => {
  it("asks the backend for the size of the exact path it was given", async () => {
    h.sizes.set("/Users/me/Movies/big.mp4", 812_345_678);
    const src = localFileSource("/Users/me/Movies/big.mp4");
    await expect(src.getSize()).resolves.toBe(812_345_678);
    // The size is asked for FIRST and exactly once. Not "only one call
    // happened" — getSize also kicks off a prefetch read, which is mediabunny's
    // business and covered separately below.
    expect(h.calls[0].cmd).toBe("get_file_size");
    expect(h.calls[0].args).toEqual({ path: "/Users/me/Movies/big.mp4" });
    expect(h.calls.filter((c) => c.cmd === "get_file_size")).toHaveLength(1);
  });

  it("passes the path through byte-for-byte, without encoding or trimming it", () => {
    // A path is not a URL. Percent-encoding or trimming it here would make
    // read_file_range miss a file whose name legitimately contains those
    // characters.
    const path = "/Users/me/A film + 100% (final) #2.mov";
    localFileSource(path).getSize();
    expect((h.calls[0].args as { path: string }).path).toBe(path);
  });

  it("asks for byte ranges as offset+length, matching [start, end)", async () => {
    // Our arithmetic, not mediabunny's: the callback receives (start, end) and
    // must invoke read_file_range with offset=start and length=end-start. An
    // off-by-one here hands the decoder a frame short of its data.
    h.sizes.set("/Users/me/big.mp4", 4_000_000);
    await localFileSource("/Users/me/big.mp4").getSize();
    const reads = h.calls.filter((c) => c.cmd === "read_file_range")
      .map((c) => c.args as { path: string; offset: number; length: number });
    expect(reads.length, "prefetch never issued a read").toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.length, `non-positive length at offset ${r.offset}`).toBeGreaterThan(0);
      expect(r.offset).toBeGreaterThanOrEqual(0);
      expect(r.offset + r.length, "a read ran past the end of the file")
        .toBeLessThanOrEqual(4_000_000);
      expect(r.path).toBe("/Users/me/big.mp4");
    }
  });
});
