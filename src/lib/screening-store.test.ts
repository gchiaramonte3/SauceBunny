import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  parseScreeningIndex, screeningFileName, indexEntryFor,
  saveScreening, listScreenings, loadScreening, resetScreeningStoreForTests,
} from "./screening-store";

const LIB = "/docs/Sauce Bunny/Transcripts";
const DIR = "/docs/Sauce Bunny/Screenings";
import { newScreening, openSegment, noteComment } from "./screening";
import type { SessionSource } from "../hooks/use-co-review";

const web = (url: string, title: string): SessionSource => ({
  kind: "web", url, fingerprint: null, title, duration: 10, reviewKey: url,
});

describe("parseScreeningIndex tolerance", () => {
  it("returns an empty index for junk rather than throwing", () => {
    // A corrupt index must never stop the app booting; the worst outcome is
    // that the list looks empty.
    for (const junk of [null, undefined, "", "not json", "[]", '{"version":1}', "{}"]) {
      expect(parseScreeningIndex(junk as unknown).size, String(junk)).toBe(0);
    }
  });

  it("rejects a filename that could escape the folder", () => {
    const evil = JSON.stringify({
      version: 1,
      screenings: {
        ok: { file: "fine.json", title: "T", startedAt: 1, endedAt: 2, participants: [], segmentCount: 0, commentCount: 0, bytes: 0 },
        bad: { file: "../../../etc/passwd", title: "T", startedAt: 1, endedAt: 2, participants: [], segmentCount: 0, commentCount: 0, bytes: 0 },
        alsoBad: { file: "sub/dir.json", title: "T", startedAt: 1, endedAt: 2, participants: [], segmentCount: 0, commentCount: 0, bytes: 0 },
      },
    });
    const idx = parseScreeningIndex(evil);
    expect([...idx.keys()]).toEqual(["ok"]);
  });

  it("fills in defaults for missing fields instead of dropping the row", () => {
    const partial = JSON.stringify({
      version: 1,
      screenings: { s1: { file: "a.json" } },
    });
    const e = parseScreeningIndex(partial).get("s1")!;
    expect(e.title).toBe("Screening");
    expect(e.commentCount).toBe(0);
    expect(e.participants).toEqual([]);
  });
});

describe("screeningFileName", () => {
  it("leads with the date so the folder sorts chronologically", () => {
    const doc = newScreening("id-1", "Friday Review", "host", Date.UTC(2026, 6, 20, 12));
    expect(screeningFileName(doc)).toMatch(/^2026-07-\d{2}-friday-review-[0-9a-f]{8}\.json$/);
  });

  it("survives a title made entirely of punctuation", () => {
    const doc = newScreening("id-2", "!!! ???", "host", Date.UTC(2026, 0, 2, 12));
    expect(screeningFileName(doc)).toMatch(/^2026-01-\d{2}-screening-[0-9a-f]{8}\.json$/);
  });

  it("gives two screenings with the same title different files", () => {
    const a = newScreening("id-a", "Review", "host", Date.UTC(2026, 6, 20, 12));
    const b = newScreening("id-b", "Review", "host", Date.UTC(2026, 6, 20, 12));
    expect(screeningFileName(a)).not.toBe(screeningFileName(b));
  });
});

describe("indexEntryFor", () => {
  it("summarises a screening without opening its segments", () => {
    let d = newScreening("s1", "Friday", "host", 1000);
    d.participants = [{ name: "Me", isHost: true }, { name: "Gasper", isHost: false }];
    d = openSegment(d, web("https://a", "A"), "kA", 1000);
    d = noteComment(d, "c1");
    d = openSegment(d, web("https://b", "B"), "kB", 2000);
    d = noteComment(d, "c2");
    d = noteComment(d, "c3");

    const e = indexEntryFor(d, 1234);
    expect(e.segmentCount).toBe(2);
    expect(e.commentCount).toBe(3);
    expect(e.participants).toEqual(["Me", "Gasper"]);
    expect(e.bytes).toBe(1234);
  });
});

describe("saveScreening does not erase earlier screenings (r148)", () => {
  // The bug: index.json is rewritten wholesale from the module-level Map, but
  // nothing ever read it back in. So on every fresh launch the Map was empty
  // and the first save of the session replaced the whole index with one row.
  // The documents survived on disk as orphans; the index lost them.
  it("merges into the on-disk index instead of replacing it", async () => {
    resetScreeningStoreForTests();
    const priorRow = {
      file: "2026-07-01-old.json", title: "Yesterday's cut", startedAt: 1, endedAt: 2,
      participants: ["Gasper"], segmentCount: 1, commentCount: 3, bytes: 100,
    };
    const files = new Map<string, string>([
      [`${DIR}/index.json`, JSON.stringify({ version: 1, screenings: { old: priorRow } })],
    ]);
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { path?: string; text?: string } | undefined;
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "ensure_dir_exists") return null;
      if (cmd === "read_text_file_capped") {
        const hit = files.get(a?.path ?? "");
        if (hit === undefined) throw new Error("ENOENT");
        return hit;
      }
      if (cmd === "write_text_to_path") { files.set(a?.path ?? "", a?.text ?? ""); return null; }
      return null;
    });

    const doc = newScreening("code-1", "Today's cut", "host");
    await saveScreening(doc);

    const written = JSON.parse(files.get(`${DIR}/index.json`)!) as {
      screenings: Record<string, { title: string }>;
    };
    // Both rows must be present: the new one AND the one from the last launch.
    expect(Object.keys(written.screenings).sort()).toEqual(["old", doc.id].sort());
    expect(written.screenings.old.title).toBe("Yesterday's cut");
  });
});

describe("the read path", () => {
  /**
   * `listScreenings` and `loadScreening` have no UI consumer yet — the screening
   * recorder landed before the browser that will show what it recorded. That
   * makes them exactly the kind of code a dead-symbol sweep deletes, which
   * would leave a store writing files nothing on earth could read back.
   *
   * So they get proven here instead. A round trip is what makes them
   * groundwork rather than rot: if the write format and the read format ever
   * drift apart, this fails, and the eventual browser starts from something
   * known to work rather than something that merely compiles.
   */
  function diskBackedInvoke() {
    const files = new Map<string, string>();
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { path?: string; text?: string } | undefined;
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "ensure_dir_exists") return null;
      if (cmd === "read_text_file_capped") {
        const hit = files.get(a?.path ?? "");
        if (hit === undefined) throw new Error("ENOENT");
        return hit;
      }
      if (cmd === "write_text_to_path") { files.set(a?.path ?? "", a?.text ?? ""); return null; }
      return null;
    });
    return files;
  }

  it("reads back what it wrote, newest first", async () => {
    resetScreeningStoreForTests();
    diskBackedInvoke();

    const older = newScreening("code-1", "Monday pass", "host");
    older.startedAt = 1000;
    await saveScreening(older);

    const newer = newScreening("code-2", "Tuesday pass", "host");
    newer.startedAt = 2000;
    await saveScreening(newer);

    const listed = listScreenings();
    expect(listed.map((r) => r.title)).toEqual(["Tuesday pass", "Monday pass"]);

    const round = await loadScreening(newer.id);
    expect(round).not.toBeNull();
    expect(round!.id).toBe(newer.id);
    expect(round!.title).toBe("Tuesday pass");
  });

  it("returns null for an id it has never seen, rather than throwing", async () => {
    resetScreeningStoreForTests();
    diskBackedInvoke();
    expect(await loadScreening("no-such-id")).toBeNull();
  });

  it("returns null when the index knows a file the disk has lost", async () => {
    // Documents live in the user's Documents folder, where they can be moved,
    // renamed or deleted between sessions. A missing file is a normal state,
    // not an exception to propagate into a render.
    resetScreeningStoreForTests();
    const files = diskBackedInvoke();
    const doc = newScreening("code-1", "Deleted later", "host");
    await saveScreening(doc);
    for (const key of [...files.keys()]) if (!key.endsWith("index.json")) files.delete(key);
    expect(await loadScreening(doc.id)).toBeNull();
    // …and the row stays listed, so a browser can show it as missing rather
    // than silently pretending the screening never happened.
    expect(listScreenings().map((r) => r.id)).toContain(doc.id);
  });
});
