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
