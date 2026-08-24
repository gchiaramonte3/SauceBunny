// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CachedWebPane } from "./CachedWebPane";
import { __resetWebCollectionStore } from "../lib/web-collection-store";

const h = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]>, items: [] as unknown[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    h.calls.push([cmd, args]);
    return Promise.resolve(cmd === "list_cached_web" ? h.items : undefined);
  },
}));

/**
 * The forget affordance.
 *
 * CLAUDE.md's co-review rule is that a multi-GB consequence gets named in the
 * control the user clicks, never only in a tooltip. Deleting a downloaded copy
 * is that same bargain in reverse, and this button was originally a bare icon
 * with the consequence in a `title` and no confirm at all: one click removed a
 * file that may have taken a quarter of an hour to fetch.
 *
 * The confirm is deliberately NOT uniform. Most rows in this pane are
 * resolve-only - that is the whole design of the shelf - and the entire cost
 * of forgetting one is the ten seconds of extraction it was saving. Making
 * those rows confirm would train the confirm away on the rows that matter.
 */
const item = (over: Record<string, unknown> = {}) => ({
  url: "https://youtube.com/watch?v=a", title: "Reel", thumbnail: null,
  uploader: null, duration_seconds: null, fetched_at: 1, path: null,
  size_bytes: null, ...over,
});

const forgetCalls = () => h.calls.filter(([c]) => c === "forget_cached_web").length;

describe("CachedWebPane forget", () => {
  beforeEach(() => { h.calls = []; h.items = []; document.body.innerHTML = ""; });

  it("forgets a resolve-only row on one click", async () => {
    h.items = [item()];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    (await screen.findByLabelText("Forget Reel")).click();
    await waitFor(() => expect(forgetCalls()).toBe(1));
  });

  it("does NOT delete a downloaded copy on the first click", async () => {
    h.items = [item({ path: "/tmp/a.mp4", size_bytes: 2_400_000_000 })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    (await screen.findByLabelText(/^Delete the .* copy of Reel$/)).click();
    // The click arms; nothing has been asked of the backend yet.
    await waitFor(() => expect(screen.getByLabelText(/^Confirm deleting/)).toBeTruthy());
    expect(forgetCalls()).toBe(0);
  });

  it("names the size in the button, not in a tooltip", async () => {
    h.items = [item({ path: "/tmp/a.mp4", size_bytes: 2_400_000_000 })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    (await screen.findByLabelText(/^Delete the/)).click();
    const btn = await screen.findByLabelText(/^Confirm deleting/);
    // The visible text carries the number. A user who never hovers still
    // learns what this costs before the second click.
    expect(btn.textContent).toMatch(/2\.\d+ GB|2 GB/);
  });

  it("deletes on the second click", async () => {
    h.items = [item({ path: "/tmp/a.mp4", size_bytes: 2_400_000_000 })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    (await screen.findByLabelText(/^Delete the/)).click();
    (await screen.findByLabelText(/^Confirm deleting/)).click();
    await waitFor(() => expect(forgetCalls()).toBe(1));
  });

  it("disarms on Escape, so an armed row is not a mine", async () => {
    h.items = [item({ path: "/tmp/a.mp4", size_bytes: 2_400_000_000 })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    (await screen.findByLabelText(/^Delete the/)).click();
    await screen.findByLabelText(/^Confirm deleting/);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => expect(screen.getByLabelText(/^Delete the/)).toBeTruthy());
    expect(forgetCalls()).toBe(0);
  });
});

describe("CachedWebPane browser parity", () => {
  beforeEach(() => {
    h.calls = []; h.items = []; document.body.innerHTML = "";
    localStorage.clear();
  });

  const three = () => [
    item({ url: "https://youtube.com/watch?v=a", title: "Beta", fetched_at: 100 }),
    item({ url: "https://vimeo.com/123", title: "Alpha", fetched_at: 300, path: "/cache/a.mp4", size_bytes: 900 }),
    item({ url: "https://youtube.com/watch?v=c", title: "Gamma", fetched_at: 200 }),
  ];

  it("mounts the library's browser bar with the web nouns", async () => {
    h.items = three();
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findByText("Beta");
    expect(screen.getByText("From the web")).toBeTruthy();
    expect(screen.getByLabelText("Search cached clips")).toBeTruthy();
    // The date option is renamed for what the number actually is here.
    expect(screen.getByText("Date fetched")).toBeTruthy();
    expect(screen.queryByText("Date modified")).toBeNull();
  });

  it("defaults keep today's order: newest fetch first within a shelf", async () => {
    h.items = three();
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findByText("Beta");
    const titles = [...document.querySelectorAll(".cp-web-title")].map((n) => n.textContent);
    // YouTube shelf (2 items) first; within it Gamma (200) before Beta (100).
    expect(titles).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("switching to list view renders ONE table with sortable headers", async () => {
    h.items = three();
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findByText("Beta");
    screen.getByRole("button", { name: "List view" }).click();
    await waitFor(() => {
      expect(document.querySelectorAll(".cp-lib-list-head")).toHaveLength(1);
    });
    // Flat: no site shelf headings, Site is a column instead.
    expect(document.querySelectorAll(".cp-web-shelf-head")).toHaveLength(0);
    const header = screen.getByRole("button", { name: /Fetched/ });
    expect(header.getAttribute("aria-sort")).toBe("descending");
    // All three rows in one list, newest first.
    const names = [...document.querySelectorAll(".cp-lib-lrow .cp-lib-lrow-name")]
      .map((n) => n.textContent);
    expect(names).toEqual(["Alpha", "Gamma", "Beta"]);
  });

  it("clicking a column header flips direction and persists", async () => {
    h.items = three();
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findByText("Beta");
    screen.getByRole("button", { name: "List view" }).click();
    (await screen.findByRole("button", { name: /Fetched/ })).click();
    await waitFor(() => {
      const names = [...document.querySelectorAll(".cp-lib-lrow .cp-lib-lrow-name")]
        .map((n) => n.textContent);
      expect(names).toEqual(["Beta", "Gamma", "Alpha"]);
    });
    expect(JSON.parse(localStorage.getItem("saucebunny.webBrowser")!)).toMatchObject({
      view: "list", sort: "date", dir: "asc",
    });
  });

  it("search filters across shelves after the debounce", async () => {
    vi.useFakeTimers();
    try {
      h.items = three();
      render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
      // let the load promise resolve under fake timers
      await vi.waitFor(() => {
        if (!screen.queryByText("Beta")) throw new Error("not loaded");
      });
      const box = screen.getByLabelText("Search cached clips") as HTMLInputElement;
      // fireEvent-free change: React reads the input through onChange
      const { fireEvent } = await import("@testing-library/react");
      fireEvent.change(box, { target: { value: "alp" } });
      await vi.advanceTimersByTimeAsync(200);
      const titles = [...document.querySelectorAll(".cp-web-title")].map((n) => n.textContent);
      expect(titles).toEqual(["Alpha"]);
      expect(screen.getByText("Results")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("web collections (organize everything)", () => {
  beforeEach(() => {
    h.calls = []; h.items = []; document.body.innerHTML = "";
    localStorage.clear();
    __resetWebCollectionStore();
  });

  const fireEvent = async () => (await import("@testing-library/react")).fireEvent;

  it("filing a clip creates the fold and removes it from its site shelf", async () => {
    h.items = [
      item({ url: "https://youtube.com/watch?v=a", title: "Keeper" }),
      item({ url: "https://youtube.com/watch?v=b", title: "Other" }),
    ];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findByText("Keeper");

    // Open the card's + menu and create a collection through its inline form.
    const fe = await fireEvent();
    screen.getAllByRole("button", { name: "Add to a collection" })[0].click();
    const nameBox = await screen.findByLabelText("New collection name");
    fe.change(nameBox, { target: { value: "Selects" } });
    fe.submit(nameBox.closest("form")!);

    // The fold appears above the site shelves, holding the filed clip...
    await screen.findByText("Selects");
    const shelves = [...document.querySelectorAll(".cp-web-shelf")];
    expect(shelves[0].className).toContain("collection");
    expect(shelves[0].textContent).toContain("Keeper");
    // ...and the site shelf keeps only the unfiled one.
    const site = shelves.find((el) => !el.className.includes("collection"))!;
    expect(site.textContent).toContain("Other");
    expect(site.textContent).not.toContain("Keeper");
  });

  it("unchecking the collection puts the clip back on its site shelf", async () => {
    h.items = [item({ url: "https://youtube.com/watch?v=a", title: "Keeper" })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findByText("Keeper");
    const fe = await fireEvent();
    screen.getAllByRole("button", { name: "Add to a collection" })[0].click();
    const nameBox = await screen.findByLabelText("New collection name");
    fe.change(nameBox, { target: { value: "Selects" } });
    fe.submit(nameBox.closest("form")!);
    await screen.findByText("Selects");

    // Filing moved the card into the collection shelf, which unmounted the
    // open menu with it - re-open from the card's new home and uncheck.
    screen.getAllByRole("button", { name: "Add to a collection" })[0].click();
    const check = (await screen.findByRole("checkbox")) as HTMLInputElement;
    expect(check.checked).toBe(true);
    fe.click(check);
    await waitFor(() => {
      const shelves = [...document.querySelectorAll(".cp-web-shelf")];
      const site = shelves.find((el) => !el.className.includes("collection"))!;
      expect(site.textContent).toContain("Keeper");
    });
    // The emptied collection stays, with its hint - curation is not deleted
    // by unfiling its last clip.
    expect(screen.getByText(/Use the \+ on any card/)).toBeTruthy();
  });

  it("deleting a collection is armed, and keeps the clips", async () => {
    h.items = [item({ url: "https://youtube.com/watch?v=a", title: "Keeper" })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findByText("Keeper");
    const fe = await fireEvent();
    screen.getAllByRole("button", { name: "Add to a collection" })[0].click();
    const nameBox = await screen.findByLabelText("New collection name");
    fe.change(nameBox, { target: { value: "Selects" } });
    fe.submit(nameBox.closest("form")!);
    await screen.findByText("Selects");

    const del = screen.getByRole("button", { name: "Delete the collection Selects" });
    fe.click(del);
    // First click arms; the collection is still there.
    expect(screen.getByText("Selects")).toBeTruthy();
    fe.click(screen.getByRole("button", { name: "Confirm deleting the collection Selects" }));
    await waitFor(() => expect(screen.queryByText("Selects")).toBeNull());
    // The clip returns to its site shelf - nothing was lost but the label.
    expect(screen.getByText("Keeper")).toBeTruthy();
  });
});
