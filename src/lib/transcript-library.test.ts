import { describe, it, expect } from "vitest";
import {
  mergeTranscriptLibrary, groupTranscriptsByFolder, monthLabel, synthesizeEntry,
} from "./transcript-library";
import type { TranscriptFile } from "../bindings/TranscriptFile";
import type { TranscriptHistoryEntry } from "./transcript-history";

const file = (over: Partial<TranscriptFile> = {}): TranscriptFile => ({
  name: "Clip", path: "/tx/2026-07/Clip.srt", folder: "2026-07",
  size_bytes: 100, modified_ms: 2000, has_diarization: false, format: "srt", ...over,
});

const hist = (over: Partial<TranscriptHistoryEntry> = {}): TranscriptHistoryEntry => ({
  id: "h1", srtPath: "/tx/2026-07/Clip.srt", sourcePath: null, sourceUrl: "https://y/x",
  title: "Real Title", origin: "whisper", createdAt: 1, lastOpenedAt: 1, ...over,
});

describe("mergeTranscriptLibrary", () => {
  it("uses the history title + real entry when a scan path matches", () => {
    const [m] = mergeTranscriptLibrary([file()], [hist()]);
    expect(m.title).toBe("Real Title");
    expect(m.inHistory).toBe(true);
    expect(m.entry.sourceUrl).toBe("https://y/x"); // source linkage preserved for follow-along
  });

  it("synthesizes an openable entry for a transcript with no history", () => {
    const [m] = mergeTranscriptLibrary([file({ path: "/tx/Loose.srt", name: "Loose" })], []);
    expect(m.title).toBe("Loose"); // falls back to the filename stem
    expect(m.inHistory).toBe(false);
    expect(m.entry.srtPath).toBe("/tx/Loose.srt"); // still points at the SRT → opens standalone
    expect(m.entry.sourcePath).toBeNull();
    expect(m.entry.sourceUrl).toBeNull();
  });

  it("sorts newest first", () => {
    const list = mergeTranscriptLibrary(
      [file({ path: "/a.srt", modified_ms: 1000 }), file({ path: "/b.srt", modified_ms: 3000 })],
      [],
    );
    expect(list.map((t) => t.path)).toEqual(["/b.srt", "/a.srt"]);
  });

  it("carries the diarization flag through", () => {
    const [m] = mergeTranscriptLibrary([file({ has_diarization: true })], []);
    expect(m.hasDiarization).toBe(true);
  });

  it("includes a history entry the scan didn't reach (custom location / unreadable)", () => {
    // Scan finds one file; history has that one PLUS another the scan missed.
    const onDisk = file({ path: "/tx/OnDisk.srt", name: "OnDisk", modified_ms: 1000 });
    const elsewhere = hist({ id: "h2", srtPath: "/somewhere/Custom.srt", title: "Custom", lastOpenedAt: 9000 });
    const list = mergeTranscriptLibrary([onDisk], [elsewhere]);
    const paths = list.map((t) => t.path);
    expect(paths).toContain("/tx/OnDisk.srt");
    expect(paths).toContain("/somewhere/Custom.srt"); // union, not just the scan
    // History-only entry is still openable and newest-first.
    expect(list[0].path).toBe("/somewhere/Custom.srt");
    expect(list[0].entry.srtPath).toBe("/somewhere/Custom.srt");
  });

  it("does not double-count a transcript that's both on disk and in history", () => {
    const list = mergeTranscriptLibrary([file()], [hist()]); // same srtPath
    expect(list).toHaveLength(1);
    expect(list[0].inHistory).toBe(true);
  });
});

describe("groupTranscriptsByFolder", () => {
  it("groups by month with the newest group first", () => {
    const files = [
      file({ path: "/tx/2026-06/Old.srt", folder: "2026-06", modified_ms: 1000 }),
      file({ path: "/tx/2026-07/New.srt", folder: "2026-07", modified_ms: 5000 }),
      file({ path: "/tx/2026-07/Newer.srt", folder: "2026-07", modified_ms: 6000 }),
    ];
    const groups = groupTranscriptsByFolder(mergeTranscriptLibrary(files, []));
    expect(groups.map((g) => g.label)).toEqual(["July 2026", "June 2026"]);
    expect(groups[0].items).toHaveLength(2);
  });

  it("labels a root-level transcript group 'Other'", () => {
    const groups = groupTranscriptsByFolder(
      mergeTranscriptLibrary([file({ path: "/tx/Loose.srt", folder: "" })], []),
    );
    expect(groups[0].label).toBe("Other");
  });
});

describe("monthLabel", () => {
  it("maps YYYY-MM to a readable month", () => {
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(monthLabel("2026-12")).toBe("December 2026");
    expect(monthLabel("")).toBe("Other");
    expect(monthLabel("garbage")).toBe("Other");
  });
});

describe("synthesizeEntry", () => {
  it("is stable and keyed by path so it de-dups against itself", () => {
    const e = synthesizeEntry(file({ path: "/x.srt" }));
    expect(e.id).toBe("scan:/x.srt");
  });
});
