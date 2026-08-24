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

beforeEach(() => { h.rows = []; h.hydrateThrows = false; h.revealed = []; });
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
    expect(await screen.findByText("Friday review")).toBeTruthy();
    expect(screen.getByText(/2 people/)).toBeTruthy();
    expect(screen.getByText(/7 notes/)).toBeTruthy();
  });

  it("says 'note' for one, because '1 notes' is the tell nobody read the string", async () => {
    h.rows = [row({ commentCount: 1 })];
    render(<ScreeningShelf />);
    expect(await screen.findByText(/1 note(?!s)/)).toBeTruthy();
  });

  it("names the single participant rather than counting to one", async () => {
    h.rows = [row({ participants: ["Ada"] })];
    render(<ScreeningShelf />);
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
    (await screen.findByLabelText(/Reveal Friday review/)).click();
    await waitFor(() => expect(h.revealed)
      .toEqual(["/Docs/Sauce Bunny/Screenings/2026-08-01-review-abc.json"]));
  });
});
