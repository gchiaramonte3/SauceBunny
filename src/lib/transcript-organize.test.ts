import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIPT_FILTER, folderLabel, organizeTranscripts, type TranscriptFilter, withEmptyProjects,
} from "./transcript-organize";
import type { LibraryTranscript } from "./transcript-library";

/**
 * The Transcripts panel at a hundred items.
 *
 * It was a flat list grouped by folder with no way to narrow it, so finding one
 * transcript meant scrolling past every month you had ever worked in. These pin
 * the decisions that make it navigable — and one outright bug: a folder the
 * user named themselves was displayed as "Other".
 */
const t = (over: Partial<LibraryTranscript>): LibraryTranscript => ({
  path: `/lib/${over.title ?? "x"}.srt`,
  title: "x", folder: "2026-08", modifiedMs: 1000, sizeBytes: 100,
  format: "srt", hasDiarization: false, hasAnalysis: false, inHistory: true,
  // The history entry is only read when a row is opened; these tests are about
  // ordering and filtering, so a stub keeps the fixture honest about that.
  entry: { srtPath: `/lib/${over.title ?? "x"}.srt` } as LibraryTranscript["entry"],
  ...over,
});

const f = (over: Partial<TranscriptFilter> = {}): TranscriptFilter =>
  ({ ...DEFAULT_TRANSCRIPT_FILTER, ...over });

describe("folder labels", () => {
  it("keeps a month folder friendly", () => {
    expect(folderLabel("2026-07")).toBe("July 2026");
  });

  it("KEEPS THE NAME of a folder the user made", () => {
    // The bug. "Move to folder…" lets you create "Marry Harry", and the panel
    // showed it as "Other" — which reads as the app having lost it.
    expect(folderLabel("Marry Harry")).toBe("Marry Harry");
    expect(folderLabel("Season 3 selects")).toBe("Season 3 selects");
  });

  it("says what the root is instead of calling it Other", () => {
    expect(folderLabel("")).toBe("Loose transcripts");
  });
});

describe("organizing transcripts", () => {
  const list = [
    t({ title: "Jimmy Carr", folder: "2026-07", modifiedMs: 300, hasDiarization: true }),
    t({ title: "Episode 10", folder: "Marry Harry", modifiedMs: 200, sizeBytes: 900 }),
    t({ title: "Episode 2", folder: "Marry Harry", modifiedMs: 100, hasAnalysis: true }),
    t({ title: "Climate talk", folder: "2026-08", modifiedMs: 400 }),
  ];

  it("groups by folder and counts honestly when idle", () => {
    const r = organizeTranscripts(list, f());
    expect(r.searching).toBe(false);
    expect(r.total).toBe(4);
    expect(r.shown).toBe(4);
    expect(r.groups.map((g) => g.label)).toContain("Marry Harry");
  });

  it("flattens into one result list while searching", () => {
    // Splitting three matches across three month headings buries the answer in
    // chrome; Finder collapses the same way once you type.
    const r = organizeTranscripts(list, f({ query: "episode" }));
    expect(r.searching).toBe(true);
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].items.map((i) => i.title)).toEqual(["Episode 10", "Episode 2"]);
    expect(r.groups[0].label).toBe("2 matches");
  });

  it("searches the folder name too", () => {
    const r = organizeTranscripts(list, f({ query: "marry" }));
    expect(r.shown).toBe(2);
  });

  it("reports the total even when the view is narrowed", () => {
    // "3 of 105" is the honest status; a bare "3" hides what was filtered out.
    const r = organizeTranscripts(list, f({ query: "climate" }));
    expect(r.shown).toBe(1);
    expect(r.total).toBe(4);
  });

  it("sorts names the way episodes are numbered", () => {
    // Episode 2 before Episode 10 — plain lexicographic gets this backwards,
    // and episodic work is exactly what fills this panel.
    const r = organizeTranscripts(list, f({ query: "episode", sort: "name" }));
    expect(r.groups[0].items.map((i) => i.title)).toEqual(["Episode 2", "Episode 10"]);
  });

  it("orders the GROUPS by the same key as the items", () => {
    // Otherwise picking A–Z leaves the headings in date order and looks broken.
    const r = organizeTranscripts(list, f({ sort: "oldest" }));
    const firstItems = r.groups.map((g) => g.items[0].modifiedMs);
    expect([...firstItems]).toEqual([...firstItems].sort((a, b) => a - b));
  });

  it("filters to transcripts that actually have speakers", () => {
    const r = organizeTranscripts(list, f({ speakersOnly: true }));
    expect(r.shown).toBe(1);
    expect(r.groups[0].items[0].title).toBe("Jimmy Carr");
  });

  it("filters to transcripts with a saved analysis", () => {
    const r = organizeTranscripts(list, f({ analyzedOnly: true }));
    expect(r.shown).toBe(1);
    expect(r.groups[0].items[0].title).toBe("Episode 2");
  });

  it("returns no groups rather than an empty heading when nothing matches", () => {
    const r = organizeTranscripts(list, f({ query: "zzz" }));
    expect(r.groups).toEqual([]);
    expect(r.shown).toBe(0);
    expect(r.total).toBe(4);
  });

  it("never mutates the caller's list", () => {
    const before = list.map((i) => i.title);
    organizeTranscripts(list, f({ sort: "name" }));
    expect(list.map((i) => i.title)).toEqual(before);
  });
});

describe("withEmptyProjects", () => {
  const g = (folder: string) => ({ folder, label: folder, items: [] as never[] });

  it("shows a project that holds nothing yet", () => {
    // Otherwise "New project" makes a folder that never appears, which reads
    // as a button that does nothing.
    const out = withEmptyProjects([g("2026-08")], ["Marry Harry"], false);
    expect(out.map((x) => x.folder)).toEqual(["Marry Harry", "2026-08"]);
    expect(out[0].items).toEqual([]);
  });

  it("does not duplicate a project that already has transcripts", () => {
    const out = withEmptyProjects([g("Marry Harry")], ["Marry Harry"], false);
    expect(out.map((x) => x.folder)).toEqual(["Marry Harry"]);
  });

  it("stays out of the way of a search", () => {
    // A query asks for matches. An empty project cannot be one, so listing it
    // above the results is chrome burying the answer.
    expect(withEmptyProjects([g("__results__")], ["Marry Harry"], true).map((x) => x.folder))
      .toEqual(["__results__"]);
  });

  it("returns the same array when there is nothing to add", () => {
    const groups = [g("2026-08")];
    expect(withEmptyProjects(groups, [], false)).toBe(groups);
  });
});
