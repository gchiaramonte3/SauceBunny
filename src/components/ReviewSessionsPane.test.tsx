// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReviewSessionsPane } from "./ReviewSessionsPane";

// The archive reader has its own integration coverage; these tests protect
// the list's navigation boundary (never Finder or a source loader on open).
vi.mock("./SavedReviewSession", () => ({ SavedReviewSession: ({ id }: { id: string }) => <section aria-label="Saved review session">{id}</section> }));

/**
 * Open session must show its archive, regardless of media availability.
 *
 * Reported as: right-clicking a session and choosing Open in Clip revealed the
 * session's JSON in Finder instead. It was wired that way literally -
 * `onOpen={() => revealOne(menuAt.id)}` - and it type-checked because "reveal
 * this record" and "open this source" are both `() => void`. Nothing but a
 * test that presses the item and watches which door opens can catch that.
 *
 * The older fix opened a known clip but still exposed JSON for source-less
 * sessions. Both routes now enter the saved-session reader. Source opening
 * is a separate explicit action inside that reader.
 */

const h = vi.hoisted(() => ({ rows: [] as unknown[], revealed: [] as string[] }));

vi.mock("../lib/screening-store", () => ({
  hydrateScreeningIndex: async () => {},
  listScreenings: () => h.rows,
  loadScreening: async () => null,
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

describe("Open session", () => {
  it("copies the clicked session name rather than acting on the whole selection", async () => {
    h.rows = [row("s1", "First session"), row("s2", "Second session")];
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
    mount(); await menuFor("Second session");
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy session name" }));
    expect(copy).toHaveBeenCalledWith("Second session");
    expect(await screen.findByText("Session name copied.")).toBeTruthy();
  });
  it("opens the local session reader, and reveals nothing", async () => {
    h.rows = [row("s1", "Test Session 5", [LOCAL])];
    const opened = mount();
    await menuFor("Test Session 5");
    fireEvent.click(await screen.findByText("Open session"));

    expect(opened.local).toEqual([]);
    expect(screen.getByRole("region", { name: "Saved review session" }).textContent).toBe("s1");
    expect(h.revealed, "Open in Clip opened Finder, which is the reported bug").toEqual([]);
  });

  it("reads a web session without automatically opening its media", async () => {
    // A key is a local path OR a url. Handing a url to the local pipeline is
    // an error the backend rejects outright (probe_local_file refuses urls).
    h.rows = [row("s2", "Web Session", [WEB])];
    const opened = mount();
    await menuFor("Web Session");
    fireEvent.click(await screen.findByText("Open session"));

    expect(opened.web).toEqual([]);
    expect(screen.getByRole("region", { name: "Saved review session" }).textContent).toBe("s2");
    expect(opened.local).toEqual([]);
  });

  it("opens legacy records even without sourceKeys", async () => {
    // `sourceKeys` is absent on every entry written before the field existed,
    // and absent means UNKNOWN. Offering the verb and guessing would open the
    // wrong clip; offering it and revealing a json is what this fixes.
    h.rows = [row("s3", "Ancient Session", undefined)];
    mount();
    await menuFor("Ancient Session");
    expect(screen.queryByText("Open in Clip"),
      "a session with no known source must not offer to open one").toBeNull();
    expect(screen.queryByText("Reveal in Finder")).toBeNull();
    fireEvent.click(await screen.findByText("Open session"));
    expect(screen.getByRole("region", { name: "Saved review session" }).textContent).toBe("s3");
  });

  it("double-click opens the saved record", async () => {
    h.rows = [row("s4", "Double Session", [LOCAL])];
    const opened = mount();
    const cell = await screen.findByText("Double Session");
    fireEvent.doubleClick(cell.closest("button")!);
    await waitFor(() => expect(screen.getByRole("region", { name: "Saved review session" }).textContent).toBe("s4"));
    expect(opened.local).toEqual([]);
    expect(h.revealed).toEqual([]);
  });
});
