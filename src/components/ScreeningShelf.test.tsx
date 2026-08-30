// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ScreeningShelf } from "./ScreeningShelf";

const h = vi.hoisted(() => ({
  rows: [] as unknown[],
  hydrateThrows: false,
  revealed: [] as string[],
}));

vi.mock("../lib/screening-store", () => ({
  hydrateScreeningIndex: async () => {
    if (h.hydrateThrows) throw new Error("no folder yet");
  },
  listScreenings: () => h.rows,
  // A FAITHFUL stand-in: the real store keys its index by the screening's ID
  // and reads the filename out of the entry. This used to be
  // `(file) => dir + file`, an identity function, so the test asserted the
  // mock's own behaviour and passed while the shipping Reveal button was
  // dead - screeningPath was being handed a filename and looking it up in an
  // id-keyed Map, which never hits. A mock that resolves anything it is given
  // cannot tell you which argument the call site passes.
  screeningPath: (id: string) => {
    const r = (h.rows as { id: string; file: string }[]).find((x) => x.id === id);
    return r ? `/Docs/Sauce Bunny/Screenings/${r.file}` : null;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: { path?: string }) => {
    if (cmd === "reveal_in_finder" && args.path) h.revealed.push(args.path);
    return null;
  },
}));

beforeEach(() => {
  h.rows = []; h.hydrateThrows = false; h.revealed = [];
  localStorage.clear();
});

/** The shelf folds by default - it is history on a screen whose job is to
 *  start or join a session - so a test that reads a row opens it first. */
async function openShelf(): Promise<void> {
  const toggle = await screen.findByRole("button", { name: /Past screenings/ });
  toggle.click();
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const row = (over: Record<string, unknown> = {}) => ({
  id: "a", file: "2026-08-01-review-abc.json", title: "Friday review",
  startedAt: 1, endedAt: Date.now() - 3600_000, participants: ["Ada", "Lin"],
  segmentCount: 2, commentCount: 7, bytes: 100, ...over,
});

describe("the screenings shelf", () => {
  it("lists a past session with who was there and how many notes", async () => {
    // The gap this closes: every co-review wrote one of these to Documents and
    // the app's own read functions had no callers outside their tests.
    h.rows = [row()];
    render(<ScreeningShelf />);
    await openShelf();
    expect(await screen.findByText("Friday review")).toBeTruthy();
    expect(screen.getByText(/2 people/)).toBeTruthy();
    expect(screen.getByText(/7 notes/)).toBeTruthy();
  });

  it("says 'note' for one, because '1 notes' is the tell nobody read the string", async () => {
    h.rows = [row({ commentCount: 1 })];
    render(<ScreeningShelf />);
    await openShelf();
    expect(await screen.findByText(/1 note(?!s)/)).toBeTruthy();
  });

  it("names the single participant rather than counting to one", async () => {
    h.rows = [row({ participants: ["Ada"] })];
    render(<ScreeningShelf />);
    await openShelf();
    expect(await screen.findByText(/Ada/)).toBeTruthy();
  });

  it("renders NOTHING before the first session", async () => {
    // An empty "Past screenings" heading on a first run is chrome advertising
    // a feature the user has not reached.
    const { container } = render(<ScreeningShelf />);
    await waitFor(() => expect(container.querySelector(".cp-screenings")).toBeNull());
  });

  it("stays silent when the folder does not exist yet", async () => {
    // The normal state before any session — not a failure worth showing.
    h.hydrateThrows = true;
    const { container } = render(<ScreeningShelf />);
    await waitFor(() => expect(container.querySelector(".cp-screenings")).toBeNull());
  });

  it("reveals the record's real path", async () => {
    h.rows = [row()];
    render(<ScreeningShelf />);
    await openShelf();
    (await screen.findByLabelText(/Reveal Friday review/)).click();
    await waitFor(() => expect(h.revealed)
      .toEqual(["/Docs/Sauce Bunny/Screenings/2026-08-01-review-abc.json"]));
  });

  it("folds by default, so a growing history cannot bury the Join card", async () => {
    // The lobby's job is to start or join a session. This list grows without
    // limit, and unfolded it pushed the second of those two verbs off the
    // bottom of the screen.
    h.rows = [row(), row({ id: "b", title: "Older" })];
    render(<ScreeningShelf />);
    const toggle = await screen.findByRole("button", { name: /Past screenings/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Friday review")).toBeNull();
    // The count is visible while folded, so it still says there is history.
    expect(toggle.textContent).toContain("2");

    toggle.click();
    expect(await screen.findByText("Friday review")).toBeTruthy();
  });

  it("remembers that it was opened", async () => {
    h.rows = [row()];
    const first = render(<ScreeningShelf />);
    await openShelf();
    await screen.findByText("Friday review");
    first.unmount();

    render(<ScreeningShelf />);
    expect(await screen.findByText("Friday review")).toBeTruthy();
  });
});

/**
 * `participants` was never assigned in production, so every screening saved
 * before that was fixed carries an EMPTY list - and the row said "0 people",
 * which is not a smaller number but a false statement: there was at least the
 * person reading it.
 */
describe("a row says only what the record actually knows", () => {
  const meta = () => document.querySelector(".cp-screenings-meta")?.textContent ?? "";

  it("says nothing about people when the roster was never recorded", async () => {
    h.rows = [row({ participants: [], segmentCount: 1, commentCount: 2 })];
    render(<ScreeningShelf />);
    await openShelf();
    await screen.findByText("Friday review");
    expect(meta(), "the legacy record's empty roster").not.toContain("0 people");
    expect(meta(), "but the rest of the row is still reported").toContain("2 notes");
  });

  // Two cases, not one with a cleanup() between: the shelf remembers whether
  // it is open in localStorage, which beforeEach clears per TEST - so a second
  // render inside one test reads back "open" and openShelf() closes it.
  it("names the single person rather than counting to one", async () => {
    h.rows = [row({ participants: ["Ada"] })];
    render(<ScreeningShelf />);
    await openShelf();
    await screen.findByText("Friday review");
    expect(meta()).toContain("Ada");
  });

  it("counts more than one", async () => {
    h.rows = [row({ participants: ["Ada", "Lin", "Sam"] })];
    render(<ScreeningShelf />);
    await openShelf();
    await screen.findByText("Friday review");
    expect(meta()).toContain("3 people");
  });

  it("reports what the room watched", async () => {
    // The segment count is the fact a session shelf exists to carry, and the
    // row never showed it at all.
    h.rows = [row({ participants: ["Ada"], segmentCount: 2 })];
    render(<ScreeningShelf />);
    await openShelf();
    await screen.findByText("Friday review");
    expect(meta()).toContain("2 sources");
  });
});
