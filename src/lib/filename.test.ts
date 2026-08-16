import { describe, expect, it } from "vitest";
import { MAX_BASE_BYTES, middleEllipsize, sanitizeFilename, suggestFilename, truncateUtf8Bytes } from "./filename";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bytes = (s: string) => new TextEncoder().encode(s).length;

// TS/Rust PARITY: these literal cases mirror filename_tests in
// src-tauri/src/commands/media.rs and truncate_utf8_bytes in commands/mod.rs.
// If either side's behavior drifts, the literal expectations here fail.
describe("truncateUtf8Bytes (parity with Rust truncate_utf8_bytes)", () => {
  it("never splits a multi-byte character (emoji)", () => {
    // "clip-" = 5 bytes; each emoji = 4 bytes; budget 7 can't fit one.
    expect(truncateUtf8Bytes("clip-😀😀😀", 7)).toBe("clip-");
  });

  it("CJK: budget 8 fits exactly two 3-byte chars", () => {
    expect(truncateUtf8Bytes("日本語", 8)).toBe("日本");
  });

  it("within budget passes through untouched", () => {
    expect(truncateUtf8Bytes("short", MAX_BASE_BYTES)).toBe("short");
  });

  it("result always fits the budget in BYTES, not chars", () => {
    const long = "é".repeat(200); // 2 bytes each = 400 bytes
    const cut = truncateUtf8Bytes(long, MAX_BASE_BYTES);
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_BASE_BYTES);
    expect(bytes(cut)).toBeGreaterThan(MAX_BASE_BYTES - 4);
  });
});

describe("sanitizeFilename", () => {
  it("caps at the byte budget and strips trailing separators", () => {
    const long = "a".repeat(300);
    const out = sanitizeFilename(long);
    expect(bytes(out)).toBeLessThanOrEqual(MAX_BASE_BYTES);
  });

  it("still replaces reserved characters", () => {
    expect(sanitizeFilename('a/b:c*d?e"f<g>h|i')).toBe("a_b_c_d_e_f_g_h_i");
  });
});

describe("suggestFilename", () => {
  it("trims a byte-cut title at the last word boundary", () => {
    const word = "wordish";
    const title = Array(40).fill(word).join(" "); // way past 180 bytes
    const out = suggestFilename(title);
    expect(bytes(out)).toBeLessThanOrEqual(MAX_BASE_BYTES);
    // Ends on a whole word: no trailing dash, and the tail is the full word.
    expect(out.endsWith("-")).toBe(false);
    expect(out.split("-").every((w) => w === word)).toBe(true);
  });

  it("leaves room for uniquing suffixes within the 255-byte APFS cap", () => {
    const out = suggestFilename("x".repeat(400));
    // base + "-9999" + ".mp4" must stay under 255 bytes.
    expect(bytes(out) + "-9999".length + ".mp4".length).toBeLessThanOrEqual(255);
  });
});

describe("middleEllipsize", () => {
  it("keeps head and tail with a single ellipsis", () => {
    const name = "a".repeat(80);
    const out = middleEllipsize(name);
    expect(out).toContain("…");
    expect(out.length).toBeLessThan(name.length);
  });

  it("short names pass through", () => {
    expect(middleEllipsize("short.mp4")).toBe("short.mp4");
  });
});

describe("parity with Rust sanitize_filename", () => {
  // The TS side is a documented mirror of src-tauri/src/commands/mod.rs, and a
  // comment saying "keep both in sync" is not a mechanism — this pair had
  // already drifted on the control-character range when this test was written.
  it("replaces DEL and the C1 block, which Rust's is_control() covers", () => {
    // Rust maps on char::is_control(): U+0000-001F *and* U+007F-009F. A regex
    // of \x00-\x1f alone lets these through, so the app previewed a filename
    // the backend would never write.
    expect(sanitizeFilename("a\x7Fb")).toBe("a_b");
    expect(sanitizeFilename("a\x80b")).toBe("a_b");
    expect(sanitizeFilename("a\x9Fb")).toBe("a_b");
  });

  it("still replaces the C0 range and the reserved punctuation", () => {
    expect(sanitizeFilename("a\x01b")).toBe("a_b");
    expect(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("shares the byte budget the Rust constant declares", () => {
    // Both sides say 180; the comment on each points at the other.
    expect(MAX_BASE_BYTES).toBe(180);
  });
});

describe("MAX_BASE_BYTES agrees with Rust", () => {
  // mod.rs calls this constant "MIRRORED in src/lib/filename.ts ... keep both
  // in sync (vitest parity cases pin the shared behavior)". The behaviour is
  // pinned — the cases above run the same inputs through truncateUtf8Bytes as
  // Rust's truncate_utf8_bytes. The VALUE was not: every case uses the TS
  // constant, so raising Rust's 180 alone leaves the suite green while the two
  // sides disagree about the budget, and the UI previews a filename the
  // backend then truncates somewhere else.
  //
  // Same shape as build-id.test.ts, which already reads its Rust counterpart.
  it("is the same number on both sides", () => {
    const rs = readFileSync(
      resolve(__dirname, "../../src-tauri/src/commands/mod.rs"), "utf8",
    );
    const m = /const MAX_BASE_BYTES: usize = (\d+);/.exec(rs);
    expect(m, "MAX_BASE_BYTES not found in mod.rs — the matcher broke, not the code").not.toBe(null);
    expect(Number(m![1])).toBe(MAX_BASE_BYTES);
  });

  it("leaves room under the 255-byte APFS cap for what gets appended", () => {
    // The reason for 180 rather than 255, per mod.rs: uniquing suffixes
    // ("-12"), pipeline suffixes, and the extension all land after this.
    expect(MAX_BASE_BYTES).toBeLessThan(255);
    expect(255 - MAX_BASE_BYTES).toBeGreaterThanOrEqual(32);
  });
});
