import { describe, expect, it } from "vitest";
import {
  fallbackPosterSource, isProjectFolder, makeProject, parseProjects, projectFor, reconcileProjects, updateProject, type TranscriptProject, projectPosterSource,
} from "./transcript-projects";

/**
 * A project is a real directory; the JSON is decoration over it. These pin the
 * two rules that keeps true: the filesystem wins, and the app's own month
 * buckets are never treated as something a person made.
 */
const P = (folder: string, over: Partial<TranscriptProject> = {}): TranscriptProject =>
  ({ ...makeProject(folder, 100), ...over });

describe("what counts as a project", () => {
  it("excludes the month buckets the app files into", () => {
    // Deleting or recolouring "2026-08" would be acting on the app's own
    // filing, and deleting it would take a month of work with it.
    for (const m of ["2026-08", "1999-12", "2026-01"]) {
      expect(isProjectFolder(m), m).toBe(false);
    }
  });

  it("excludes the library root", () => {
    expect(isProjectFolder("")).toBe(false);
  });

  it("includes anything a person would have named", () => {
    for (const f of ["Marry Harry", "S3 selects", "2026-08 pickups", "202608"]) {
      expect(isProjectFolder(f), f).toBe(true);
    }
  });
});

describe("reading the file back", () => {
  it("keeps a well-formed project", () => {
    const got = parseProjects([{ folder: "Show", title: "The Show", color: "#f00", createdMs: 5 }]);
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe("The Show");
    expect(got[0].color).toBe("#f00");
  });

  it("defaults the title to the folder, so a shelf is never nameless", () => {
    expect(parseProjects([{ folder: "Show" }])[0].title).toBe("Show");
    expect(parseProjects([{ folder: "Show", title: "   " }])[0].title).toBe("Show");
  });

  it("drops junk rather than losing the whole shelf", () => {
    // This file lives in the user's Documents and is hand-editable.
    const got = parseProjects([null, 3, "x", {}, { folder: "" }, { folder: "Good" }]);
    expect(got.map((p) => p.folder)).toEqual(["Good"]);
  });

  it("refuses a month bucket even if the file names one", () => {
    expect(parseProjects([{ folder: "2026-08" }])).toEqual([]);
  });

  it("de-duplicates by folder, which is the identity", () => {
    const got = parseProjects([{ folder: "S", title: "first" }, { folder: "S", title: "second" }]);
    expect(got).toHaveLength(1);
    expect(got[0].title).toBe("first");
  });

  it("returns empty for anything that is not a list", () => {
    for (const junk of [null, undefined, {}, "[]", 7]) expect(parseProjects(junk)).toEqual([]);
  });
});

describe("reconciling against the disk", () => {
  it("adopts a folder created outside the app", () => {
    // Made in Finder, or by a move. It should just appear.
    const got = reconcileProjects([], ["Marry Harry"], 42);
    expect(got.map((p) => p.folder)).toEqual(["Marry Harry"]);
    expect(got[0].createdMs).toBe(42);
  });

  it("forgets a folder that no longer exists", () => {
    // The drift that made queued marks appear on the wrong video: state and
    // disk telling two different stories.
    const got = reconcileProjects([P("Gone"), P("Here")], ["Here"], 1);
    expect(got.map((p) => p.folder)).toEqual(["Here"]);
  });

  it("keeps the metadata of a folder that survived", () => {
    const got = reconcileProjects([P("Show", { title: "The Show", color: "#0f0" })], ["Show"], 1);
    expect(got[0].title).toBe("The Show");
    expect(got[0].color).toBe("#0f0");
  });

  it("never adopts a month bucket from the disk listing", () => {
    expect(reconcileProjects([], ["2026-08", "Show"], 1).map((p) => p.folder)).toEqual(["Show"]);
  });

  it("follows disk order, so the panel matches the folder listing", () => {
    const got = reconcileProjects([], ["B", "A"], 1);
    expect(got.map((p) => p.folder)).toEqual(["B", "A"]);
  });
});

describe("posters", () => {
  it("falls back to the NEWEST transcript in the project", () => {
    // A shelf reads as "what am I working on", and the most recent transcript
    // answers that more often than the first one filed.
    const src = fallbackPosterSource([
      { path: "/old.srt", modifiedMs: 1 },
      { path: "/new.srt", modifiedMs: 9 },
      { path: "/mid.srt", modifiedMs: 5 },
    ]);
    expect(src).toBe("/new.srt");
  });

  it("has nothing to show for an empty project", () => {
    expect(fallbackPosterSource([])).toBeNull();
  });
});

describe("editing", () => {
  it("patches one project and leaves the rest alone", () => {
    const got = updateProject([P("A"), P("B")], "B", { color: "#00f" });
    expect(got.find((p) => p.folder === "A")!.color).toBeNull();
    expect(got.find((p) => p.folder === "B")!.color).toBe("#00f");
  });

  it("cannot change the folder, because that is the identity on disk", () => {
    const got = updateProject([P("A")], "A", { title: "Renamed" } as never);
    expect(got[0].folder).toBe("A");
    expect(got[0].title).toBe("Renamed");
  });

  it("finds a project by folder and ignores month buckets", () => {
    const list = [P("Show")];
    expect(projectFor(list, "Show")!.folder).toBe("Show");
    expect(projectFor(list, "2026-08")).toBeNull();
  });
});

describe("projectPosterSource", () => {
  const items = [
    { path: "/lib/Show/a.srt", modifiedMs: 100 },
    { path: "/lib/Show/b.srt", modifiedMs: 300 },
    { path: "/lib/Show/c.srt", modifiedMs: 200 },
  ];

  it("uses the transcript someone picked", () => {
    expect(projectPosterSource({ posterFrom: "/lib/Show/a.srt" }, items)).toBe("/lib/Show/a.srt");
  });

  it("falls back to the newest when nothing was picked", () => {
    expect(projectPosterSource({ posterFrom: null }, items)).toBe("/lib/Show/b.srt");
  });

  it("falls back when the picked transcript has left the project", () => {
    // Moving a transcript out is an ordinary action. A header still pointing
    // at it shows a broken tile, or the picture of something filed elsewhere.
    expect(projectPosterSource({ posterFrom: "/lib/Other/gone.srt" }, items)).toBe("/lib/Show/b.srt");
  });

  it("has no picture for an empty project", () => {
    expect(projectPosterSource({ posterFrom: "/lib/Show/a.srt" }, [])).toBeNull();
  });

  it("treats a project with no metadata as unchosen", () => {
    expect(projectPosterSource(null, items)).toBe("/lib/Show/b.srt");
  });
});
