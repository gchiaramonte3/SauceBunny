// @vitest-environment jsdom
//
// The Frames shelf. Snapshots used to go through a save dialog, so they
// scattered across the Desktop, Downloads and the export folder and the app
// could not show them afterwards. These pin the other half of that fix: one
// managed folder, bundled by source, with the same browser bar, grid and
// list views the folder pane and web shelf use.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  h.calls = []; h.items = []; document.body.innerHTML = "";
  localStorage.clear();
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

  it("puts delete in the card menu, not on the card, and asks first", async () => {
    // The verb belongs where a card's other verbs already live. A button
    // floating beside the ⋯ that opens that menu is the same action twice.
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    h.items = [frame()];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    expect(document.querySelector(".cp-web-grid .cp-web-forget")).toBeNull();

    screen.getAllByRole("button", { name: "More actions" })[0].click();
    (await screen.findByRole("menuitem", { name: /Delete frame/ })).click();

    await waitFor(() => {
      expect(h.calls.filter(([c]) => c === "delete_frame")).toHaveLength(1);
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it("declining the ask deletes nothing", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    h.items = [frame()];
    mount();
    await screen.findAllByText("Bear_00012304.jpg");
    screen.getAllByRole("button", { name: "More actions" })[0].click();
    (await screen.findByRole("menuitem", { name: /Delete frame/ })).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.filter(([c]) => c === "delete_frame")).toHaveLength(0);
    confirmSpy.mockRestore();
  });
});

describe("folders as containers", () => {
  beforeEach(() => { h.calls = []; h.items = []; document.body.innerHTML = ""; localStorage.clear(); });

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
  beforeEach(() => { h.calls = []; h.items = []; document.body.innerHTML = ""; localStorage.clear(); });

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
