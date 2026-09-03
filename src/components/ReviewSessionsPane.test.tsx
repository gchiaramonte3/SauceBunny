// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReviewSessionsPane } from "./ReviewSessionsPane";

/**
 * "Open in Clip" must open the clip.
 *
 * Reported as: right-clicking a session and choosing Open in Clip revealed the
 * session's JSON in Finder instead. It was wired that way literally -
 * `onOpen={() => revealOne(menuAt.id)}` - and it type-checked because "reveal
 * this record" and "open this source" are both `() => void`. Nothing but a
 * test that presses the item and watches which door opens can catch that.
 *
 * The pane had no opener props at all, which is WHY the wrong handler was
 * there: the capability was never plumbed into this section, so the menu
 * offered a verb the component could not perform.
 */

const h = vi.hoisted(() => ({ rows: [] as unknown[], revealed: [] as string[] }));

vi.mock("../lib/screening-store", () => ({
  hydrateScreeningIndex: async () => {},
  listScreenings: () => h.rows,
  screeningPath: (id: string) => {
    const r = (h.rows as { id: string; file: string }[]).find((x) => x.id === id);
    return r ? `/Docs/Sauce Bunny/Screenings/${r.file}` : null;
  },
  SCREENINGS_CHANGED: "saucebunny:screenings-changed",
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: { path?: string }) => {
    if (cmd === "reveal_in_finder" && args.path) h.revealed.push(args.path);
    return null;
  },
}));

const LOCAL = "/Users/x/Movies/turbores-sample.mov";
const WEB = "https://youtube.com/watch?v=abc";

function row(id: string, title: string, sourceKeys?: string[]) {
  return {
    id, file: `${id}.json`, title, startedAt: 1_756_000_000_000, endedAt: 1_756_000_600_000,
    participants: ["Gasper"], segmentCount: 1, commentCount: 2, bytes: 100, sourceKeys,
  };
}

function mount() {
  const opened = { local: [] as string[], web: [] as string[] };
  render(
    <ReviewSessionsPane
      treeOpen={false}
      onShowTree={() => {}}
      onOpenLocalPath={(p) => opened.local.push(p)}
      onOpenWebUrl={(u) => opened.web.push(u)}
    />,
  );
  return opened;
}

/** Right-click the named row and return the menu. */
async function menuFor(title: string) {
  const cell = await screen.findByText(title);
  fireEvent.contextMenu(cell.closest("button")!);
  return await screen.findByRole("menu").catch(() => document.body);
}

beforeEach(() => { h.rows = []; h.revealed = []; localStorage.clear(); cleanup(); });

describe("Open in Clip", () => {
  it("opens the session's local source, and reveals nothing", async () => {
    h.rows = [row("s1", "Test Session 5", [LOCAL])];
    const opened = mount();
    await menuFor("Test Session 5");
    fireEvent.click(await screen.findByText("Open in Clip"));

    expect(opened.local, "the clip panel was never asked to open anything").toEqual([LOCAL]);
    expect(h.revealed, "Open in Clip opened Finder, which is the reported bug").toEqual([]);
  });

  it("routes a web source to the web opener, not the local one", async () => {
    // A key is a local path OR a url. Handing a url to the local pipeline is
    // an error the backend rejects outright (probe_local_file refuses urls).
    h.rows = [row("s2", "Web Session", [WEB])];
    const opened = mount();
    await menuFor("Web Session");
    fireEvent.click(await screen.findByText("Open in Clip"));

    expect(opened.web).toEqual([WEB]);
    expect(opened.local).toEqual([]);
  });

  it("does not offer the verb for a session that recorded no source", async () => {
    // `sourceKeys` is absent on every entry written before the field existed,
    // and absent means UNKNOWN. Offering the verb and guessing would open the
    // wrong clip; offering it and revealing a json is what this fixes.
    h.rows = [row("s3", "Ancient Session", undefined)];
    mount();
    await menuFor("Ancient Session");
    expect(screen.queryByText("Open in Clip"),
      "a session with no known source must not offer to open one").toBeNull();
    expect(await screen.findByText("Reveal in Finder"),
      "the record is still reachable").toBeTruthy();
  });

  it("double-click opens the source too, like every other library section", async () => {
    h.rows = [row("s4", "Double Session", [LOCAL])];
    const opened = mount();
    const cell = await screen.findByText("Double Session");
    fireEvent.doubleClick(cell.closest("button")!);
    await waitFor(() => expect(opened.local).toEqual([LOCAL]));
    expect(h.revealed).toEqual([]);
  });
});
