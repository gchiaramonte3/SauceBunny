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
 * The forget affordance, now in the card's ⋯ menu.
 *
 * It began as a bare icon on the card with the consequence in a `title`, and
 * grew an armed two-click confirm. Both were wrong in the same way: the card
 * already HAS the place for its verbs, and a button floating beside the ⋯
 * that opens that menu is the same action twice, in two idioms, fighting for
 * one corner. The verb lives in the menu now and asks with a dialog, which
 * is what every other destructive action in this app does.
 *
 * The distinction that survived the move is the one worth keeping: a
 * downloaded copy is minutes of fetching and names its size in the ask,
 * while a resolve-only entry costs ten seconds of extraction and goes
 * without ceremony. Making those rows confirm would train the confirm away
 * on the rows that matter.
 */
const item = (over: Record<string, unknown> = {}) => ({
  url: "https://youtube.com/watch?v=a", title: "Reel", thumbnail: null,
  uploader: null, duration_seconds: null, fetched_at: 1, path: null,
  size_bytes: null, ...over,
});

const forgetCalls = () => h.calls.filter(([c]) => c === "forget_cached_web").length;

/** Open the card's ⋯ menu and return the delete item. */
async function openDeleteItem() {
  screen.getAllByRole("button", { name: "More actions" })[0].click();
  return await screen.findByRole("menuitem", { name: /Delete the copy|Forget this source/ });
}

describe("CachedWebPane forget", () => {
  beforeEach(() => { h.calls = []; h.items = []; document.body.innerHTML = ""; });

  it("puts the verb in the card menu, not on the card", async () => {
    h.items = [item()];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Reel");
    // Nothing floating over the art any more.
    expect(document.querySelector(".cp-web-grid .cp-web-forget")).toBeNull();
    expect(await openDeleteItem()).toBeTruthy();
  });

  it("forgets a resolve-only row without asking", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    h.items = [item()];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Reel");
    (await openDeleteItem()).click();
    await waitFor(() => expect(forgetCalls()).toBe(1));
    expect(confirmSpy, "a resolve-only row asked, which trains the confirm away").not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("asks before deleting a downloaded copy, and names its size", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    h.items = [item({ path: "/cache/a.mp4", size_bytes: 1024 * 1024 * 12 })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Reel");
    (await openDeleteItem()).click();
    await waitFor(() => expect(forgetCalls()).toBe(1));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/12(\.0)? MB/);
    confirmSpy.mockRestore();
  });

  it("declining the ask deletes nothing", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(false);
    h.items = [item({ path: "/cache/a.mp4", size_bytes: 900 })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Reel");
    (await openDeleteItem()).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(forgetCalls()).toBe(0);
    confirmSpy.mockRestore();
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
    await screen.findAllByText("Beta");
    expect(screen.getByText("From the web")).toBeTruthy();
    expect(screen.getByLabelText("Search cached clips")).toBeTruthy();
    // The date option is renamed for what the number actually is here.
    expect(screen.getByText("Date fetched")).toBeTruthy();
    expect(screen.queryByText("Date modified")).toBeNull();
  });

  it("defaults keep today's order: newest fetch first within a shelf", async () => {
    h.items = three();
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Beta");
    const titles = [...document.querySelectorAll(".cp-lib-card-title")].map((n) => n.textContent);
    // YouTube shelf (2 items) first; within it Gamma (200) before Beta (100).
    expect(titles).toEqual(["Gamma", "Beta", "Alpha"]);
  });

  it("switching to list view renders ONE table with sortable headers", async () => {
    h.items = three();
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Beta");
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
    await screen.findAllByText("Beta");
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
        if (screen.queryAllByText("Beta").length === 0) throw new Error("not loaded");
      });
      const box = screen.getByLabelText("Search cached clips") as HTMLInputElement;
      // fireEvent-free change: React reads the input through onChange
      const { fireEvent } = await import("@testing-library/react");
      fireEvent.change(box, { target: { value: "alp" } });
      await vi.advanceTimersByTimeAsync(200);
      const titles = [...document.querySelectorAll(".cp-lib-card-title")].map((n) => n.textContent);
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
    await screen.findAllByText("Keeper");

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
    await screen.findAllByText("Keeper");
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
    await screen.findAllByText("Keeper");
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
    expect(screen.getAllByText("Keeper").length).toBeGreaterThan(0);
  });
});

describe("web cards ARE library cards", () => {
  beforeEach(() => {
    h.calls = []; h.items = []; document.body.innerHTML = "";
    localStorage.clear(); __resetWebCollectionStore();
  });

  it("renders the shared card, with the two web-only facts on the art", async () => {
    h.items = [item({
      url: "https://youtube.com/watch?v=a", title: "Reel",
      duration_seconds: 95, path: "/cache/a.mp4", size_bytes: 900,
    })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Reel");

    // The library's cell + card, not the old bespoke markup.
    expect(document.querySelector(".cp-lib-cell")).toBeTruthy();
    expect(document.querySelector(".cp-web-card")).toBeNull();
    // Runtime and the downloaded-copy mark ride as card props.
    expect(document.querySelector(".cp-lib-card-dur")?.textContent).toBe("1:35");
    expect(document.querySelector(".cp-lib-card-have")).toBeTruthy();
    // And the card brings the ⋯ menu a bespoke card never had.
    expect(screen.getByRole("button", { name: "More actions" })).toBeTruthy();
  });

  it("a resolve-only entry shows no downloaded mark", async () => {
    h.items = [item({ url: "https://youtube.com/watch?v=b", title: "Stream", path: null })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Stream");
    expect(document.querySelector(".cp-lib-card-have")).toBeNull();
  });

  it("opening goes through onOpenUrl, on the DOUBLE click", async () => {
    // The shelf gained multi-select, so a single click is a selection
    // gesture here exactly as it is in the folder pane, and opening moved to
    // the double click. A wall of cards that supports shift-click ranges
    // cannot also navigate away on the first click of one.
    const { fireEvent } = await import("@testing-library/react");
    const opened: string[] = [];
    h.items = [item({ url: "https://youtube.com/watch?v=c", title: "Clip" })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={(u) => opened.push(u)} />);
    await screen.findAllByText("Clip");
    const card = document.querySelector(".cp-lib-card") as HTMLButtonElement;

    fireEvent.click(card);
    expect(opened, "a single click navigated away mid-selection").toEqual([]);
    expect(card.classList.contains("selected")).toBe(true);

    fireEvent.doubleClick(card);
    expect(opened).toEqual(["https://youtube.com/watch?v=c"]);
  });
});

describe("selecting more than one clip", () => {
  // Its own reset. Without one this block inherited nothing, so the DOM and
  // the fixture list leaked in from whichever test ran before it and the
  // shelf rendered five cards for a three-item fixture.
  beforeEach(() => {
    h.calls = []; h.items = []; document.body.innerHTML = "";
    localStorage.clear();
    __resetWebCollectionStore();
  });

  const clips = () => [
    item({ url: "https://youtube.com/watch?v=1", title: "One", site: "youtube.com" }),
    item({ url: "https://youtube.com/watch?v=2", title: "Two", site: "youtube.com" }),
    item({ url: "https://youtube.com/watch?v=3", title: "Three", site: "youtube.com" }),
  ];

  it("gives every card its URL as identity, which selection selects by", async () => {
    h.items = [item({ url: "https://youtube.com/watch?v=c", title: "Clip" })];
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("Clip");
    expect(document.querySelector(".cp-lib-card")!.getAttribute("data-path"))
      .toBe("https://youtube.com/watch?v=c");
  });

  it("shift-click takes the range between, in DISPLAY order", async () => {
    // Deliberately driven off the rendered order rather than the order the
    // fixtures were declared in: the shelf sorts, and a range means the run
    // the user can SEE between the two clicks. Asserting against fixture
    // order passed only by luck and hid which rule was being tested.
    const { fireEvent } = await import("@testing-library/react");
    h.items = clips();
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("One");

    const cards = [...document.querySelectorAll(".cp-lib-card")] as HTMLElement[];
    expect(cards).toHaveLength(3);
    fireEvent.click(cards[0]);
    fireEvent.click(cards[2], { shiftKey: true });
    expect(document.querySelectorAll(".cp-lib-card.selected")).toHaveLength(3);

    // ...and a shorter range is exactly the run between, not everything.
    fireEvent.click(cards[0]);
    fireEvent.click(cards[1], { shiftKey: true });
    const selected = [...document.querySelectorAll(".cp-lib-card.selected")];
    expect(selected).toHaveLength(2);
    expect(selected[0]).toBe(cards[0]);
    expect(selected[1]).toBe(cards[1]);
  });

  it("forgetting a selection asks once and forgets all of them", async () => {
    const { fireEvent, waitFor } = await import("@testing-library/react");
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    h.items = clips();
    render(<CachedWebPane treeOpen onShowTree={() => {}} onOpenUrl={() => {}} />);
    await screen.findAllByText("One");

    const cards = [...document.querySelectorAll(".cp-lib-card")] as HTMLElement[];
    fireEvent.click(cards[0]);
    fireEvent.click(cards[2], { shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));

    await waitFor(() => {
      expect(h.calls.filter(([c]) => c === "forget_cached_web")).toHaveLength(3);
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});
