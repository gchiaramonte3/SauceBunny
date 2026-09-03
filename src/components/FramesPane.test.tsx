// @vitest-environment jsdom
//
// The Frames shelf. Snapshots used to go through a save dialog, so they
// scattered across the Desktop, Downloads and the export folder and the app
// could not show them afterwards. These pin the other half of that fix: one
// managed folder, bundled by source, with the same browser bar, grid and
// list views the folder pane and web shelf use.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearHidden } from "../lib/library-hidden";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FramesPane } from "./FramesPane";

const h = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]>, items: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    h.calls.push([cmd, args]);
    return Promise.resolve(cmd === "list_frames" ? h.items : undefined);
  },
}));
vi.mock("../lib/asset-url", () => ({ assetUrl: (p: string) => `asset://${p}` }));

const frame = (over: Record<string, unknown> = {}) => ({
  path: "/Docs/Sauce Bunny/Frames/Bear_00012304.jpg",
  name: "Bear_00012304.jpg",
  source: "Bear",
  folder: "",
  timecode: "00012304",
  created_at: 100,
  size_bytes: 4096,
  ...over,
});

beforeEach(() => {
  // cleanup(), not a body wipe: the frame viewer renders through a PORTAL,
  // and clearing document.body by hand rips out a node React still owns - the
  // next unmount then throws NotFoundError and the failure lands on whichever
  // test happens to run next.
  cleanup();
  h.calls = []; h.items = []; localStorage.clear();
  clearHidden();
});

const mount = () => render(<FramesPane treeOpen onShowTree={() => {}} />);

describe("the frames shelf", () => {
  it("says how to make one before there are any", async () => {
    mount();
    expect(await screen.findByText(/Press the camera in the player/)).toBeTruthy();
  });

  it("bundles frames by the film they came from", async () => {
    h.items = [
      frame({ path: "/f/a.jpg", name: "Bear_00000100.jpg", source: "Bear" }),
      frame({ path: "/f/b.jpg", name: "Bear_00000200.jpg", source: "Bear" }),
      frame({ path: "/f/c.jpg", name: "Solo_00000100.jpg", source: "Solo" }),
    ];
    mount();
    await screen.findByText("Bear");
    const heads = [...document.querySelectorAll(".cp-web-shelf-head")].map((n) => n.textContent);
    // Biggest bundle first, count beside the name.
    expect(heads[0]).toContain("Bear");
    expect(heads[0]).toContain("2");
    expect(heads[1]).toContain("Solo");
  });

  it("mounts the library's browser bar with the frame nouns", async () => {
    h.items = [frame()];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    expect(screen.getByText("Frames")).toBeTruthy();
    expect(screen.getByLabelText("Search frames")).toBeTruthy();
    expect(screen.getByText("Date grabbed")).toBeTruthy();
  });

  it("renders shared library cards, with the timecode on the art", async () => {
    h.items = [frame()];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    expect(document.querySelector(".cp-lib-cell")).toBeTruthy();
    expect(document.querySelector(".cp-lib-card-dur")?.textContent).toBe("00:01:23:04");
    // The still is its own poster.
    const img = document.querySelector(".cp-lib-card-art img") as HTMLImageElement;
    expect(img.src).toContain("Frames");
  });

  /**
   * Multi-select must survive the view toggle.
   *
   * The pane computed a selection and handed it to the GRID only, and the
   * band's item selector was pinned to `.cp-lib-card` - a class that exists
   * in grid view and nowhere else. So switching to list silently took both
   * shift-click and the lasso away: the rows were there, the gesture drew a
   * rectangle, and it selected nothing. A view toggle must not remove a
   * capability.
   */
  it("shift-click selects a range in LIST view, not just in the grid", async () => {
    h.items = [
      frame(),
      frame({ path: "/f/b.jpg", name: "B_00000100.jpg" }),
      frame({ path: "/f/c.jpg", name: "C_00000200.jpg" }),
    ];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    screen.getByRole("button", { name: "List view" }).click();
    await waitFor(() => expect(document.querySelectorAll(".cp-lib-lrow").length).toBeGreaterThan(2));

    const rows = [...document.querySelectorAll<HTMLButtonElement>(".cp-lib-lrow")];
    rows[0].click();
    rows[2].dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));

    await waitFor(() => {
      expect(document.querySelectorAll(".cp-lib-lrow.selected")).toHaveLength(3);
    });
  });

  it("marks the selected list rows for assistive tech too", async () => {
    // The class paints it; aria-current is what says it out loud.
    h.items = [frame(), frame({ path: "/f/b.jpg", name: "B_00000100.jpg" })];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    screen.getByRole("button", { name: "List view" }).click();
    await waitFor(() => expect(document.querySelectorAll(".cp-lib-lrow").length).toBeGreaterThan(1));

    const rows = [...document.querySelectorAll<HTMLButtonElement>(".cp-lib-lrow")];
    rows[0].click();
    await waitFor(() => {
      expect(rows[0].getAttribute("aria-current")).toBe("true");
    });
  });

  it("gives every list row the identity the lasso reads", async () => {
    // useMarquee finds items by `data-path`. Without it a band can sweep the
    // rows and select nothing, which is what list view did.
    h.items = [frame(), frame({ path: "/f/b.jpg", name: "B_00000100.jpg" })];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    screen.getByRole("button", { name: "List view" }).click();
    await waitFor(() => expect(document.querySelectorAll(".cp-lib-lrow").length).toBeGreaterThan(1));

    const rows = [...document.querySelectorAll(".cp-lib-lrow")];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.getAttribute("data-path")).toBeTruthy();
  });

  it("switching to list view renders one table with sortable headers", async () => {
    h.items = [frame(), frame({ path: "/f/b.jpg", name: "Solo_00000100.jpg", source: "Solo" })];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    screen.getByRole("button", { name: "List view" }).click();
    await waitFor(() => {
      expect(document.querySelectorAll(".cp-lib-list-head")).toHaveLength(1);
    });
    expect(document.querySelectorAll(".cp-web-shelf-head")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Grabbed/ }).getAttribute("aria-sort")).toBe("descending");
  });

  it("REMOVES a frame from the shelf and never deletes the file", async () => {
    // The owner's rule: the app takes things off its own shelves and never
    // deletes anyone's media, nor moves it to the Trash. `delete_frame` was
    // the only permanent unlink in the app and has been removed from the Rust
    // side entirely, so this asserts both halves - the verb still works, and
    // no destructive command is reachable from it.
    h.items = [frame()];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");

    screen.getAllByRole("button", { name: "More actions" })[0].click();
    (await screen.findByRole("menuitem", { name: /Remove from Library/ })).click();

    await waitFor(() => {
      expect(document.querySelectorAll(".cp-lib-card").length).toBe(0);
    });
    expect(
      h.calls.filter(([c]) => c === "delete_frame" || c === "move_to_trash"),
      "a destructive command was invoked; the file must be left alone",
    ).toHaveLength(0);
  });

  it("offers no destructive verb at all", async () => {
    // Break-test anchor: if a "Delete"/"Trash" item ever reappears in this
    // menu, this fails rather than the rule being quietly reversed.
    h.items = [frame()];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    screen.getAllByRole("button", { name: "More actions" })[0].click();
    await screen.findByRole("menuitem", { name: /Remove from Library/ });
    expect(screen.queryByRole("menuitem", { name: /Delete|Trash/ })).toBeNull();
  });
});

describe("folders as containers", () => {
  beforeEach(() => { cleanup(); h.calls = []; h.items = []; localStorage.clear(); clearHidden(); });

  const tree = () => [
    frame({ path: "/f/root.jpg", name: "Bear_00000100.jpg", folder: "", created_at: 10 }),
    frame({ path: "/f/s/a.jpg", name: "Bear_00000200.jpg", folder: "Selects", created_at: 20 }),
    frame({ path: "/f/s/b.jpg", name: "Bear_00000300.jpg", folder: "Selects", created_at: 30 }),
  ];

  it("shows a folder as a tile with a derived cover, and its own frames beside it", async () => {
    h.items = tree();
    mount();
    await screen.findByText("Selects");
    // The container tile is the library's own folder card, not a new idiom.
    const tile = document.querySelector(".cp-lib-foldercard");
    expect(tile, "the folder is not rendered as the shared folder card").toBeTruthy();
    // The root's own loose frame is still shown beside it.
    expect(screen.getAllByText("Bear_00000100.jpg").length).toBeGreaterThan(0);
    // A filed frame is NOT also shown at the root.
    expect(screen.queryAllByText("Bear_00000200.jpg")).toHaveLength(0);
  });

  it("opening a folder drills in, and the crumb walks back out", async () => {
    h.items = tree();
    mount();
    (await screen.findByRole("button", { name: /Selects/ })).click();

    await waitFor(() => {
      expect(screen.getAllByText("Bear_00000200.jpg").length).toBeGreaterThan(0);
    });
    // The root's loose frame is gone; we are one level down.
    expect(screen.queryAllByText("Bear_00000100.jpg")).toHaveLength(0);
    // And "Frames" is now a crumb BUTTON that walks back.
    screen.getByRole("button", { name: "Frames" }).click();
    await waitFor(() => {
      expect(screen.getAllByText("Bear_00000100.jpg").length).toBeGreaterThan(0);
    });
  });

  it("New folder is an inline form, and creates inside the open folder", async () => {
    const { fireEvent } = await import("@testing-library/react");
    h.items = tree();
    mount();
    (await screen.findByRole("button", { name: /Selects/ })).click();
    await waitFor(() => expect(screen.getAllByText("Bear_00000200.jpg").length).toBeGreaterThan(0));

    screen.getByRole("button", { name: /New folder/ }).click();
    const box = await screen.findByLabelText("New folder name");
    fireEvent.change(box, { target: { value: "Day 2" } });
    fireEvent.submit(box.closest("form")!);

    await waitFor(() => {
      const call = h.calls.find(([c]) => c === "create_frames_folder");
      expect(call, "no folder was created").toBeTruthy();
      // Created INSIDE the folder that is open, not at the root.
      expect((call![1] as { parent: string; name: string })).toMatchObject({
        parent: "Selects", name: "Day 2",
      });
    });
  });

  it("search flattens the whole tree, folders included", async () => {
    const { fireEvent } = await import("@testing-library/react");
    h.items = tree();
    mount();
    await screen.findByText("Selects");
    fireEvent.change(screen.getByLabelText("Search frames"), { target: { value: "00000300" } });
    await waitFor(() => {
      expect(screen.getAllByText("Bear_00000300.jpg").length).toBeGreaterThan(0);
    });
    // No folder tiles in a search result - it is a flat answer.
    expect(document.querySelector(".cp-lib-foldercard")).toBeNull();
  });
});

describe("filing a frame into a folder", () => {
  beforeEach(() => { cleanup(); h.calls = []; h.items = []; localStorage.clear(); clearHidden(); });

  it("Move to folder… is a menu item, and moving calls the scoped command", async () => {
    const { fireEvent } = await import("@testing-library/react");
    h.items = [
      frame({ path: "/f/root.jpg", name: "Bear_00000100.jpg", folder: "" }),
      frame({ path: "/f/s/a.jpg", name: "Bear_00000200.jpg", folder: "Selects" }),
    ];
    mount();
    await screen.findAllByText("Bear_00000100.jpg");

    screen.getAllByRole("button", { name: "More actions" })[0].click();
    (await screen.findByRole("menuitem", { name: /Move to folder/ })).click();

    // The dialog offers the root AND every existing folder - a frame needs a
    // way back out as much as a way in.
    const dialog = await screen.findByRole("dialog", { name: "Move frame" });
    expect(dialog).toBeTruthy();
    expect(screen.getByRole("button", { name: /Frames \(top level\)/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Selects" }));
    await waitFor(() => {
      const call = h.calls.find(([c]) => c === "move_frame_to_folder");
      expect(call, "the move never reached the backend").toBeTruthy();
      expect((call![1] as { dest: string }).dest).toBe("Selects");
    });
  });

  it("Create & move makes the folder then moves, in that order", async () => {
    const { fireEvent } = await import("@testing-library/react");
    h.items = [frame({ path: "/f/root.jpg", name: "Bear_00000100.jpg", folder: "" })];
    mount();
    await screen.findAllByText("Bear_00000100.jpg");
    screen.getAllByRole("button", { name: "More actions" })[0].click();
    (await screen.findByRole("menuitem", { name: /Move to folder/ })).click();

    const box = await screen.findByPlaceholderText("New folder name…");
    fireEvent.change(box, { target: { value: "Keepers" } });
    fireEvent.click(screen.getByRole("button", { name: /Create & move/ }));

    await waitFor(() => {
      const names = h.calls.map(([c]) => c);
      expect(names.indexOf("create_frames_folder")).toBeGreaterThan(-1);
      expect(names.indexOf("move_frame_to_folder")).toBeGreaterThan(
        names.indexOf("create_frames_folder"),
      );
    });
  });
});

describe("selecting more than one frame", () => {
  beforeEach(() => { cleanup(); h.calls = []; h.items = []; localStorage.clear(); clearHidden(); });

  const four = () => [
    frame({ path: "/f/1.jpg", name: "a1.jpg", source: "Bear", created_at: 40 }),
    frame({ path: "/f/2.jpg", name: "a2.jpg", source: "Bear", created_at: 30 }),
    frame({ path: "/f/3.jpg", name: "a3.jpg", source: "Bear", created_at: 20 }),
    frame({ path: "/f/4.jpg", name: "a4.jpg", source: "Bear", created_at: 10 }),
  ];

  /** The card button carrying a given frame name. */
  const cardFor = (name: string) =>
    [...document.querySelectorAll(".cp-lib-card")].find(
      (c) => c.querySelector(".cp-lib-card-title")?.textContent?.trim() === name,
    ) as HTMLElement;

  it("gives every card an identity, which is what selection selects by", async () => {
    // The bug: identity was derived from the ART, and a frame's art is
    // REMOTE (the still through the asset protocol), so these cards carried
    // no data-path and were invisible to the band, which skips nodes without
    // one. The shelf looked like it was missing the feature.
    h.items = [frame()];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    const card = document.querySelector(".cp-lib-card")!;
    expect(card.getAttribute("data-path")).toBe("/Docs/Sauce Bunny/Frames/Bear_00012304.jpg");
  });

  it("shift-click takes the range between, in display order", async () => {
    const { fireEvent } = await import("@testing-library/react");
    h.items = four();
    mount();
    await screen.findAllByText("a1.jpg");

    fireEvent.click(cardFor("a1.jpg"));
    fireEvent.click(cardFor("a3.jpg"), { shiftKey: true });

    const selected = [...document.querySelectorAll(".cp-lib-card.selected")]
      .map((c) => c.querySelector(".cp-lib-card-title")?.textContent?.trim());
    expect(selected).toEqual(["a1.jpg", "a2.jpg", "a3.jpg"]);
  });

  it("meta-click toggles one without losing the rest", async () => {
    const { fireEvent } = await import("@testing-library/react");
    h.items = four();
    mount();
    await screen.findAllByText("a1.jpg");

    fireEvent.click(cardFor("a1.jpg"));
    fireEvent.click(cardFor("a3.jpg"), { metaKey: true });
    expect(document.querySelectorAll(".cp-lib-card.selected")).toHaveLength(2);

    fireEvent.click(cardFor("a3.jpg"), { metaKey: true });
    expect(document.querySelectorAll(".cp-lib-card.selected")).toHaveLength(1);
  });

  it("removing from the row menu takes the WHOLE selection off the shelf", async () => {
    // The selection-aware verb survives the removal of the destructive one:
    // right-clicking a card inside a selection acts on the set, and nothing
    // on disk is touched.
    const { fireEvent } = await import("@testing-library/react");
    h.items = four();
    mount();
    await screen.findAllByText("a1.jpg");

    fireEvent.click(cardFor("a1.jpg"));
    fireEvent.click(cardFor("a3.jpg"), { shiftKey: true });
    fireEvent.contextMenu(cardFor("a2.jpg"));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove from Library/ }));

    await waitFor(() => {
      expect(document.querySelectorAll(".cp-lib-card").length).toBe(1);
    });
    expect(
      h.calls.filter(([c]) => c === "delete_frame" || c === "move_to_trash"),
      "a destructive command was invoked for a selection",
    ).toHaveLength(0);
  });

  it("a single click still opens the viewer on double-click, not on the first", async () => {
    const { fireEvent } = await import("@testing-library/react");
    h.items = four();
    mount();
    await screen.findAllByText("a1.jpg");

    fireEvent.click(cardFor("a1.jpg"));
    expect(screen.queryByRole("dialog", { name: /Frame/ })).toBeNull();

    fireEvent.doubleClick(cardFor("a1.jpg"));
    expect(await screen.findByRole("dialog", { name: /Frame/ })).toBeTruthy();
  });
});

describe("the shelf keeps up with the grabber", () => {
  // cleanup() rather than wiping document.body: the viewer renders through a
  // PORTAL, and clearing the body by hand tears out a node React still owns,
  // so the next unmount throws instead of the test failing on its own terms.
  beforeEach(() => { cleanup(); h.calls = []; h.items = []; localStorage.clear(); clearHidden(); });

  it("re-reads when a frame is grabbed, without waiting for a window focus", async () => {
    // The case that actually happens: grab a frame in the Clip workspace,
    // walk to Library and open Frames. The window never lost focus, and this
    // shelf stays MOUNTED behind the other shelves - so before the event
    // there was nothing at all to make it look again.
    h.items = [];
    mount();
    expect(await screen.findByText(/Press the camera in the player/)).toBeTruthy();

    h.items = [frame()];
    const { act } = await import("@testing-library/react");
    const { FRAMES_CHANGED_EVENT } = await import("../lib/frames");
    await act(async () => {
      window.dispatchEvent(new CustomEvent(FRAMES_CHANGED_EVENT));
    });

    expect(await screen.findAllByText("Bear_00012304.jpg")).not.toHaveLength(0);
  });
});
