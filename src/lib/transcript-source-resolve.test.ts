import { describe, it, expect, beforeEach } from "vitest";
import { buildRecentIndex, transcriptArt } from "./transcript-source-resolve";
import type { LibraryTranscript } from "./transcript-library";
import type { RecentSource } from "./recent-sources";
import type { TranscriptHistoryEntry } from "./transcript-history";

function installLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
}

function tx(title: string, entry: Partial<TranscriptHistoryEntry> = {}): LibraryTranscript {
  return {
    path: `/T/${title}.srt`, title, folder: "", modifiedMs: 0, sizeBytes: 0,
    format: "srt", hasDiarization: false, hasAnalysis: false, inHistory: false,
    entry: {
      id: "x", srtPath: `/T/${title}.srt`, sourcePath: null, sourceUrl: null,
      title, origin: "unknown", createdAt: 0, lastOpenedAt: 0, ...entry,
    },
  };
}
function recent(kind: "url" | "file", value: string, title: string): RecentSource {
  return { kind, value, title, lastOpenedAt: 0 };
}

describe("transcriptArt re-association", () => {
  beforeEach(() => { installLocalStorage(); });

  it("uses the transcript's own source keys when present", () => {
    expect(transcriptArt(tx("x", { sourcePath: "/v/Mr.mp4" }), []))
      .toEqual({ kind: "local", path: "/v/Mr.mp4", media: "video" });
    const art = transcriptArt(tx("x", { sourceUrl: "https://youtu.be/abc123DEF45" }), []);
    expect(art.kind).toBe("remote");
    expect(art.kind === "remote" && art.url).toContain("abc123DEF45");
  });

  it("re-associates a SOURCE-LESS transcript to a matching local recent by slug", () => {
    const idx = buildRecentIndex([recent("file", "/lib/Mr.mp4", "Mr.mp4")]);
    // Synthesized transcript titled from the source filename.
    expect(transcriptArt(tx("Mr.mp4"), idx)).toEqual({ kind: "local", path: "/lib/Mr.mp4", media: "video" });
  });

  it("matches through a caption/uniquing suffix (.en, -orig) at a separator", () => {
    const idx = buildRecentIndex([recent("url", "https://youtu.be/KT776vidid0", "KT #776 BRIAN MOSES")]);
    const art = transcriptArt(tx("KT-#776-BRIAN-MOSES.en"), idx);
    expect(art.kind).toBe("remote");
    expect(art.kind === "remote" && art.url).toContain("KT776vidid0");
  });

  it("does NOT prefix-match across a word boundary (Foo ≠ Foobar)", () => {
    const idx = buildRecentIndex([recent("file", "/lib/Foo.mp4", "Foo")]);
    expect(transcriptArt(tx("Foobar"), idx)).toEqual({ kind: "remote", url: null });
  });

  it("falls back to the glyph (remote/null) when nothing matches", () => {
    const idx = buildRecentIndex([recent("file", "/lib/Other.mp4", "Something Else")]);
    expect(transcriptArt(tx("Unmatched-Transcript"), idx)).toEqual({ kind: "remote", url: null });
  });

  it("does not cross-match degenerate titles that both slug to nothing", () => {
    // Two unrelated all-non-Latin sources/transcripts must NOT match (they used
    // to both collapse to the "clip" fallback slug and borrow each other's poster).
    const idx = buildRecentIndex([recent("file", "/lib/a.mp4", "日本語")]);
    expect(transcriptArt(tx("한국어"), idx)).toEqual({ kind: "remote", url: null });
  });

  it("prefers the longest (most specific) recent slug on a prefix tie", () => {
    const idx = buildRecentIndex([
      recent("file", "/lib/short.mp4", "Interview"),
      recent("file", "/lib/long.mp4", "Interview With The Director"),
    ]);
    expect(transcriptArt(tx("Interview-With-The-Director"), idx))
      .toEqual({ kind: "local", path: "/lib/long.mp4", media: "video" });
  });
});
