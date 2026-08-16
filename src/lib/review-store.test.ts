import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The store talks to disk exclusively through Tauri invoke — stub it at the
// module seam with a tiny in-memory FS so hydration/migration/flush are
// testable end-to-end in node.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  reviewFileName, parseReviewIndex, serializeReviewIndex,
  looksLikeReviewDoc, reviewDocHasContent,
  hydrateReviewStore, getReviewDoc, resetReviewStoreForTests,
  type ReviewIndexEntry,
} from "./review-store";
import { loadReview, saveReview, emptyDoc, type ReviewDoc, type ReviewComment } from "./review";

const LIB = "/docs/Sauce Bunny/Transcripts";
const DIR = "/docs/Sauce Bunny/Reviews";

let fs: Map<string, string>;
let ensuredDirs: string[];

function installInvokeFs(overrides?: { libPath?: unknown }): void {
  vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
    const a = args as { path?: string; text?: string } | undefined;
    if (cmd === "default_transcript_library_path") {
      return overrides && "libPath" in overrides ? overrides.libPath : LIB;
    }
    if (cmd === "read_text_file_capped") {
      const text = fs.get(a?.path ?? "");
      if (text === undefined) throw new Error(`Not a file: ${a?.path}`);
      return text;
    }
    if (cmd === "write_text_to_path") {
      fs.set(a?.path ?? "", a?.text ?? "");
      return null;
    }
    if (cmd === "ensure_dir_exists") {
      ensuredDirs.push(a?.path ?? "");
      return null;
    }
    throw new Error(`unexpected invoke: ${cmd}`);
  });
}

/** Map-backed localStorage with working length/key(i) so the migration scan
 *  can iterate (the shim in review.test.ts is too minimal for that). */
function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
  return store;
}

const mkComment = (versionId: string, id: string, body = "note"): ReviewComment => ({
  id, versionId, parentId: null, timeStart: 1, timeEnd: null, body,
  resolved: false, author: "A", createdAt: 1000, updatedAt: 1000, annotation: null,
});

const mkDoc = (sourceKey: string, over: Partial<ReviewDoc> = {}): ReviewDoc => ({
  ...emptyDoc(sourceKey),
  versions: [{ id: "v1", label: "V1", path: sourceKey, addedAt: 1000 }],
  activeVersionId: "v1",
  ...over,
});

/** Seed the fake FS with a hydratable library: index.json + one file per doc. */
function seedLibrary(...docs: ReviewDoc[]): Map<string, ReviewIndexEntry> {
  const entries = new Map<string, ReviewIndexEntry>();
  for (const d of docs) {
    const file = reviewFileName(d.sourceKey);
    const text = JSON.stringify(d);
    fs.set(`${DIR}/${file}`, text);
    entries.set(d.sourceKey, { file, updatedAt: 1000, count: d.comments.length, bytes: text.length });
  }
  fs.set(`${DIR}/index.json`, serializeReviewIndex(entries));
  return entries;
}

beforeEach(() => {
  resetReviewStoreForTests();
  fs = new Map();
  ensuredDirs = [];
  installLocalStorage();
  installInvokeFs();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
});

describe("reviewFileName (slug + hash mapping)", () => {
  it("is stable for the same key and unique per key", () => {
    const a = reviewFileName("/Users/me/Clips/WING IT.mp4");
    expect(reviewFileName("/Users/me/Clips/WING IT.mp4")).toBe(a);
    expect(reviewFileName("/Users/me/Other/WING IT.mp4")).not.toBe(a); // same tail, different key
  });
  it("sanitizes paths and URLs into safe readable names", () => {
    expect(reviewFileName("/Users/me/Clips/WING IT.mp4")).toMatch(/^wing-it-[0-9a-f]{8}\.json$/);
    expect(reviewFileName("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))
      .toMatch(/^watch-v-dqw4w9wgxcq-[0-9a-f]{8}\.json$/);
    // No separators / traversal characters survive.
    expect(reviewFileName("/a/../b/№☃.mov")).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}\.json$/);
  });
  it("bounds the slug and falls back when the tail is unusable", () => {
    const long = reviewFileName("/x/" + "a".repeat(200) + ".mp4");
    expect(long.length).toBeLessThanOrEqual(40 + 1 + 8 + 5);
    expect(reviewFileName("/")).toMatch(/^review-[0-9a-f]{8}\.json$/);
  });
});

describe("index round-trip", () => {
  it("serialize → parse preserves entries", () => {
    const entries = new Map<string, ReviewIndexEntry>([
      ["/a.mp4", { file: "a-11111111.json", updatedAt: 5, count: 2, bytes: 900 }],
      ["https://y.tube/w?v=1", { file: "w-v-1-22222222.json", updatedAt: 9, count: 0, bytes: 100 }],
    ]);
    expect(parseReviewIndex(serializeReviewIndex(entries))).toEqual(entries);
  });
  it("tolerates garbage: null, corrupt JSON, wrong shapes, unsafe filenames", () => {
    expect(parseReviewIndex(null).size).toBe(0);
    expect(parseReviewIndex("{not json").size).toBe(0);
    expect(parseReviewIndex(JSON.stringify({ version: 1, docs: "nope" })).size).toBe(0);
    // A filename carrying a path separator could escape Reviews/ — dropped.
    const evil = JSON.stringify({ version: 1, docs: { k: { file: "../../etc/x", updatedAt: 1, count: 0, bytes: 0 } } });
    expect(parseReviewIndex(evil).size).toBe(0);
  });
});

describe("migration decision logic (pure)", () => {
  it("looksLikeReviewDoc accepts docs and rejects the prefs sharing the prefix", () => {
    expect(looksLikeReviewDoc(mkDoc("/a.mp4"))).toBe(true);
    expect(looksLikeReviewDoc("Gasper")).toBe(false);            // …review.author
    expect(looksLikeReviewDoc([{ key: "k" }])).toBe(false);       // …review.history
    expect(looksLikeReviewDoc({ fp: "key" })).toBe(false);        // …review.fpindex
    expect(looksLikeReviewDoc(240)).toBe(false);                  // …review.composerHeight
    expect(looksLikeReviewDoc(null)).toBe(false);
  });
  it("reviewDocHasContent keeps comment/status docs and drops version-only shells", () => {
    expect(reviewDocHasContent(mkDoc("/a.mp4"))).toBe(false);
    expect(reviewDocHasContent(mkDoc("/a.mp4", { comments: [mkComment("v1", "c1")] }))).toBe(true);
    expect(reviewDocHasContent(mkDoc("/a.mp4", { status: { v1: { state: "approved", note: "", updatedAt: 1, reviewer: "Nika" } } }))).toBe(true);
  });
});

describe("hydration", () => {
  it("loads index + docs so the SYNC loadReview sees them", async () => {
    const rich = mkDoc("/clips/final.mp4", { comments: [mkComment("v1", "c1", "tighten intro")] });
    seedLibrary(rich);
    await hydrateReviewStore();
    expect(getReviewDoc("/clips/final.mp4")).toEqual(rich);
    expect(loadReview("/clips/final.mp4").comments[0].body).toBe("tighten intro");
    expect(loadReview("/never-seen.mp4").comments).toEqual([]); // unknown key → empty doc
  });
  it("tolerates a missing dir/index and corrupt doc files (empty store, no throw)", async () => {
    await hydrateReviewStore(); // nothing on disk at all
    expect(getReviewDoc("/a.mp4")).toBeUndefined();

    resetReviewStoreForTests();
    const entries = seedLibrary(mkDoc("/ok.mp4", { comments: [mkComment("v1", "c1")] }));
    fs.set(`${DIR}/${entries.get("/ok.mp4")!.file}`, "{corrupt");
    await expect(hydrateReviewStore()).resolves.toBeUndefined();
    expect(getReviewDoc("/ok.mp4")).toBeUndefined(); // skipped, not fatal
  });
  it("degrades to memory-only when the library path is unavailable (e2e mock null)", async () => {
    installInvokeFs({ libPath: null });
    await hydrateReviewStore();
    saveReview(mkDoc("/a.mp4", { comments: [mkComment("v1", "c1")] }));
    await vi.runAllTimersAsync();
    expect(fs.size).toBe(0); // no writes attempted…
    expect(loadReview("/a.mp4").comments).toHaveLength(1); // …but the Map still works
  });
});

describe("localStorage migration", () => {
  it("imports content docs to files, removes doc keys, leaves prefs, sets the flag", async () => {
    const doc = mkDoc("/old/clip.mp4", { comments: [mkComment("v1", "c1", "from localStorage")] });
    localStorage.setItem("saucebunny.review./old/clip.mp4", JSON.stringify(doc));
    localStorage.setItem("saucebunny.review./shell.mp4", JSON.stringify(mkDoc("/shell.mp4"))); // version-only
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Gasper"));
    localStorage.setItem("saucebunny.review.history", JSON.stringify([{ key: "/old/clip.mp4" }]));
    localStorage.setItem("saucebunny.review.fpindex", JSON.stringify({ fp1: "/old/clip.mp4" }));

    await hydrateReviewStore({ migrate: true });
    await vi.runAllTimersAsync(); // debounced import write

    expect(loadReview("/old/clip.mp4").comments[0].body).toBe("from localStorage");
    expect(fs.get(`${DIR}/${reviewFileName("/old/clip.mp4")}`)).toBe(JSON.stringify(doc));
    // Quota relief: BOTH doc entries are gone (the shell wasn't worth a file).
    expect(localStorage.getItem("saucebunny.review./old/clip.mp4")).toBeNull();
    expect(localStorage.getItem("saucebunny.review./shell.mp4")).toBeNull();
    expect(fs.has(`${DIR}/${reviewFileName("/shell.mp4")}`)).toBe(false);
    // Prefs sharing the prefix stay put.
    expect(localStorage.getItem("saucebunny.review.author")).toBe(JSON.stringify("Gasper"));
    expect(localStorage.getItem("saucebunny.review.history")).not.toBeNull();
    expect(localStorage.getItem("saucebunny.review.fpindex")).not.toBeNull();
    expect(localStorage.getItem("saucebunny.reviews.migrated")).toBe("1");
    // The index now knows the migrated doc.
    const idx = parseReviewIndex(fs.get(`${DIR}/index.json`));
    expect(idx.get("/old/clip.mp4")?.count).toBe(1);
  });
  it("files win on conflict — the localStorage copy is dropped, not merged", async () => {
    const fileDoc = mkDoc("/clip.mp4", { comments: [mkComment("v1", "c1", "file canon")] });
    seedLibrary(fileDoc);
    localStorage.setItem(
      "saucebunny.review./clip.mp4",
      JSON.stringify(mkDoc("/clip.mp4", { comments: [mkComment("v1", "c9", "stale legacy")] })),
    );
    await hydrateReviewStore({ migrate: true });
    await vi.runAllTimersAsync();
    expect(loadReview("/clip.mp4").comments.map((c) => c.body)).toEqual(["file canon"]);
    expect(localStorage.getItem("saucebunny.review./clip.mp4")).toBeNull(); // still cleared
  });
  it("skips migration when asked (panel window)", async () => {
    localStorage.setItem(
      "saucebunny.review./clip.mp4",
      JSON.stringify(mkDoc("/clip.mp4", { comments: [mkComment("v1", "c1")] })),
    );
    await hydrateReviewStore({ migrate: false });
    await vi.runAllTimersAsync();
    expect(localStorage.getItem("saucebunny.review./clip.mp4")).not.toBeNull();
    expect(fs.has(`${DIR}/${reviewFileName("/clip.mp4")}`)).toBe(false);
  });
});

describe("write-through (debounced save)", () => {
  it("saveReview lands doc + index on disk after the debounce, dir ensured once", async () => {
    await hydrateReviewStore();
    const doc = mkDoc("/a.mp4", { comments: [mkComment("v1", "c1")] });
    saveReview(doc);
    saveReview({ ...doc, comments: [...doc.comments, mkComment("v1", "c2")] }); // coalesces
    expect(fs.size).toBe(0); // nothing before the debounce fires
    await vi.runAllTimersAsync();

    const file = reviewFileName("/a.mp4");
    const onDisk = JSON.parse(fs.get(`${DIR}/${file}`)!) as ReviewDoc;
    expect(onDisk.comments).toHaveLength(2); // trailing write carries the LAST doc
    expect(ensuredDirs).toEqual([DIR]);
    const idx = parseReviewIndex(fs.get(`${DIR}/index.json`));
    expect(idx.get("/a.mp4")).toMatchObject({ file, count: 2 });
    expect(idx.get("/a.mp4")!.bytes).toBe(fs.get(`${DIR}/${file}`)!.length);
  });
  it("keeps the previous content as .bak when a doc shrinks by >50% (clobber guard)", async () => {
    const big = mkDoc("/big.mp4", {
      comments: [mkComment("v1", "c1", "x".repeat(4000))],
    });
    seedLibrary(big);
    await hydrateReviewStore();
    const file = reviewFileName("/big.mp4");
    const bigText = fs.get(`${DIR}/${file}`)!;

    saveReview(mkDoc("/big.mp4")); // suspicious near-empty overwrite
    await vi.runAllTimersAsync();

    expect(fs.get(`${DIR}/${file}.bak`)).toBe(bigText); // old notes recoverable
    expect((JSON.parse(fs.get(`${DIR}/${file}`)!) as ReviewDoc).comments).toEqual([]);
  });
  it("does not write .bak for ordinary small edits", async () => {
    const doc = mkDoc("/a.mp4", { comments: [mkComment("v1", "c1", "hello")] });
    seedLibrary(doc);
    await hydrateReviewStore();
    saveReview({ ...doc, comments: [mkComment("v1", "c1", "hello!")] });
    await vi.runAllTimersAsync();
    expect(fs.has(`${DIR}/${reviewFileName("/a.mp4")}.bak`)).toBe(false);
  });

  it("does NOT overwrite a review whose file is unreadable (iCloud-evicted)", async () => {
    // The critical data-loss path: hydrate an index that references a doc, then
    // make its file unreadable (iCloud offloaded it → the read throws). Opening
    // the source yields an emptyDoc that tries to save over the real notes.
    const real = mkDoc("/evicted.mp4", { comments: [mkComment("v1", "c1", "important note")] });
    seedLibrary(real);
    await hydrateReviewStore();
    const file = reviewFileName("/evicted.mp4");
    const realText = fs.get(`${DIR}/${file}`)!;
    // Simulate eviction: the file's bytes are gone from disk but the index
    // entry (with the real byte size) remains — exactly what hydration leaves.
    fs.delete(`${DIR}/${file}`);

    saveReview(mkDoc("/evicted.mp4")); // failed-hydration emptyDoc
    await vi.runAllTimersAsync();

    // The store must NOT have written an empty doc over the (evicted) file.
    expect(fs.has(`${DIR}/${file}`)).toBe(false); // no clobber — stays evicted, recoverable
    // And it must not have fabricated a .bak from a file it couldn't read.
    expect(fs.has(`${DIR}/${file}.bak`)).toBe(false);
    // When the file comes back (iCloud re-downloads it), a later flush must
    // succeed — the key stayed dirty, so re-seeding the file and flushing again
    // writes the intended (empty) doc with a real .bak of the recovered notes.
    fs.set(`${DIR}/${file}`, realText);
    saveReview(mkDoc("/evicted.mp4"));
    await vi.runAllTimersAsync();
    expect(fs.get(`${DIR}/${file}.bak`)).toBe(realText); // now recoverable
  });

  it("does NOT retry an eviction-deferred write on its own, only on the next save", async () => {
    // Pins a real limitation rather than a feature. Every other deferral in
    // flushDirtyDocs re-arms; this one cannot, because the debounce is 500ms
    // and re-arming would re-read an evicted placeholder twice a second for as
    // long as it stays evicted.
    //
    // The consequence is user-visible: the deferred write is always one that
    // shrinks or empties the file, so someone who deletes their comments and
    // quits without touching anything else sees them again on reopen. That is
    // the safe direction to fail in, and it is still a behaviour someone
    // should have decided on rather than inherited.
    const real = mkDoc("/offline.mp4", { comments: [mkComment("v1", "c1", "important note")] });
    seedLibrary(real);
    await hydrateReviewStore();
    const file = reviewFileName("/offline.mp4");
    const realText = fs.get(`${DIR}/${file}`)!;
    fs.delete(`${DIR}/${file}`); // evicted

    saveReview(mkDoc("/offline.mp4")); // the user deletes everything
    await vi.runAllTimersAsync();
    expect(fs.has(`${DIR}/${file}`)).toBe(false); // correctly refused

    // The file comes back, and NOTHING else happens: no further edit, no
    // further save. Time alone does not land the deferred write.
    fs.set(`${DIR}/${file}`, realText);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fs.get(`${DIR}/${file}`)).toBe(realText); // still the pre-deletion copy
    expect(fs.has(`${DIR}/${file}.bak`)).toBe(false); // nothing was rewritten

    // One more save is what lands it. This is the whole recovery path.
    saveReview(mkDoc("/offline.mp4"));
    await vi.runAllTimersAsync();
    expect(fs.get(`${DIR}/${file}.bak`)).toBe(realText);
  });

  it("does NOT overwrite a SMALL real review with an empty doc (below the shrink floor)", async () => {
    // Many real reviews are under the 2 KB shrink threshold, so the half-size
    // rule alone never fired — an emptyDoc could silently erase them. The
    // empty-over-content guard covers this even without eviction.
    const small = mkDoc("/small.mp4", { comments: [mkComment("v1", "c1", "short")] });
    seedLibrary(small);
    await hydrateReviewStore();
    const file = reviewFileName("/small.mp4");
    const smallText = fs.get(`${DIR}/${file}`)!;

    saveReview(mkDoc("/small.mp4")); // emptyDoc over a small-but-real review
    await vi.runAllTimersAsync();

    // The real content is backed up before the empty write lands.
    expect(fs.get(`${DIR}/${file}.bak`)).toBe(smallText);
  });
});

describe("boot-race durability (r140)", () => {
  /** Drain pending microtasks so an unawaited hydrate can advance to (and
   *  park on) the gated read. */
  const pump = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

  it("hydration never installs the disk copy over a doc edited this session", async () => {
    const file = reviewFileName("/race.mp4");
    fs.set(`${DIR}/index.json`, serializeReviewIndex(new Map([
      ["/race.mp4", { file, updatedAt: 1, count: 1, bytes: 200 }],
    ])));
    fs.set(`${DIR}/${file}`, JSON.stringify(mkDoc("/race.mp4", { comments: [mkComment("v1", "old", "stale disk copy")] })));
    // Hold the DOC read open - the slow-disk shape the 2s boot race renders
    // through - while the index loads normally.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { path?: string } | undefined;
      if (cmd === "read_text_file_capped" && a?.path === `${DIR}/${file}`) await gate;
      return base(cmd, args as Parameters<typeof base>[1]);
    });
    const hydration = hydrateReviewStore({ migrate: false });
    await pump(); // past the index read, parked on the doc read
    // The UI rendered and the user edited before the disk copy arrived.
    saveReview(mkDoc("/race.mp4", { comments: [mkComment("v1", "new", "fresh edit")] }));
    release();
    await hydration;
    expect(loadReview("/race.mp4").comments[0].body).toBe("fresh edit");
  });

  it("a flush firing before the index hydrates re-arms instead of writing blind", async () => {
    fs.set(`${DIR}/index.json`, serializeReviewIndex(new Map()));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const base = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { path?: string } | undefined;
      if (cmd === "read_text_file_capped" && a?.path === `${DIR}/index.json`) await gate;
      return base(cmd, args as Parameters<typeof base>[1]);
    });
    const hydration = hydrateReviewStore({ migrate: false });
    await pump(); // reviewsDir resolved; index read parked
    saveReview(mkDoc("/early.mp4", { comments: [mkComment("v1", "c1")] }));
    await vi.advanceTimersByTimeAsync(600); // debounce fires; flush must hold
    expect(fs.has(`${DIR}/${reviewFileName("/early.mp4")}`)).toBe(false);
    release();
    await hydration;
    await vi.advanceTimersByTimeAsync(600); // the re-armed flush lands now
    expect(fs.has(`${DIR}/${reviewFileName("/early.mp4")}`)).toBe(true);
  });
});

describe("a failing write backs off instead of hammering the disk", () => {
  /**
   * A failed write re-arms the flush, and the flush was always armed at the
   * 500ms debounce - so a write that fails PERMANENTLY (read-only volume, the
   * folder deleted underneath us, a full disk) became a disk attempt twice a
   * second for as long as the app stayed open, which for this app is all day.
   * The user-visible warning is throttled to one per 30s, so the loop ran
   * invisibly.
   */
  async function setup(): Promise<{ path: string; attempts: () => number; setFailing: (v: boolean) => void }> {
    fs.set(`${DIR}/index.json`, serializeReviewIndex(new Map()));
    await hydrateReviewStore({ migrate: false });
    const path = `${DIR}/${reviewFileName("/fail.mp4")}`;
    let failing = true;
    let attempts = 0;
    const base = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { path?: string } | undefined;
      if (cmd === "write_text_to_path" && a?.path === path) {
        attempts += 1;
        if (failing) throw new Error("EROFS: read-only file system");
      }
      return base(cmd, args as Parameters<typeof base>[1]);
    });
    return { path, attempts: () => attempts, setFailing: (v) => { failing = v; } };
  }

  it("does not retry at the debounce interval forever", async () => {
    const { attempts } = await setup();
    saveReview(mkDoc("/fail.mp4", { comments: [mkComment("v1", "c1")] }));

    await vi.advanceTimersByTimeAsync(600);
    expect(attempts()).toBe(1); // first try

    // Old behaviour: another attempt every 500ms. Two full seconds of that
    // would be four more; the backoff allows at most one.
    await vi.advanceTimersByTimeAsync(600);
    expect(attempts()).toBe(1); // still waiting - backoff is 1000ms now

    await vi.advanceTimersByTimeAsync(600);
    expect(attempts()).toBe(2);
  });

  it("keeps stretching the gap, so an hour of failure is not 7200 attempts", async () => {
    const { attempts } = await setup();
    saveReview(mkDoc("/fail.mp4", { comments: [mkComment("v1", "c1")] }));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    // Doubling to a 30s ceiling: a handful of early tries, then ~2/minute.
    expect(attempts()).toBeLessThan(130);
    expect(attempts()).toBeGreaterThan(5);
  });

  it("never gives up, because the notes exist only in memory until one lands", async () => {
    // Backing off is not abandoning. If the drive comes back, the write must
    // land without the user having to touch anything.
    const { path, attempts, setFailing } = await setup();
    saveReview(mkDoc("/fail.mp4", { comments: [mkComment("v1", "c1")] }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fs.has(path)).toBe(false);
    const during = attempts();
    setFailing(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fs.has(path)).toBe(true);
    expect(attempts()).toBeGreaterThan(during);
  });

  it("returns to the plain debounce once a write succeeds", async () => {
    // The streak must not leave the next ordinary save waiting 30 seconds.
    const { attempts, setFailing } = await setup();
    saveReview(mkDoc("/fail.mp4", { comments: [mkComment("v1", "c1")] }));
    await vi.advanceTimersByTimeAsync(20_000);
    setFailing(false);
    await vi.advanceTimersByTimeAsync(60_000); // recovery write lands
    const settled = attempts();

    saveReview(mkDoc("/fail.mp4", { comments: [mkComment("v1", "c2")] }));
    await vi.advanceTimersByTimeAsync(600); // plain debounce, not a backoff
    expect(attempts()).toBe(settled + 1);
  });
});
