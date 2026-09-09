// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ClipTagIndicator } from "./ClipTagIndicator";
import { LibraryCard } from "./LibraryCard";
import { LibraryListRow } from "./LibraryListRow";
import { WebListRows } from "./WebListRows";
import { TAG_COLORS } from "../lib/finder-tags";

vi.mock("../hooks/use-lazy-thumbnails", () => ({ useLazyThumbnails: () => [] }));
vi.mock("../hooks/use-hover-frames", () => ({ useHoverFrames: () => ({ frames: [], active: 0, start: vi.fn(), stop: vi.fn() }) }));
vi.mock("../hooks/use-library-scan", () => ({ requestHeroStill: vi.fn() }));
afterEach(cleanup);

describe("Finder clip indicators", () => {
  for (const color of TAG_COLORS) it(`uses the same Finder ${color.label} in both variants`, () => {
    const tags = [{ name: color.label, color: 1 }]; // Finder's name wins over its index.
    const { container } = render(<><ClipTagIndicator tags={tags} variant="dot" /><ClipTagIndicator tags={tags} variant="stripe" /></>);
    const markers = [...container.querySelectorAll<HTMLElement>(".cp-clip-tag")];
    const expected = document.createElement("span"); expected.style.backgroundColor = color.hex;
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.style.backgroundColor).toBe(expected.style.backgroundColor);
      expect(marker.getAttribute("aria-hidden")).toBe("true");
      expect(marker.hasAttribute("tabindex")).toBe(false);
    }
  });

  it("renders nothing for missing or colorless custom tags", () => {
    const { container } = render(<><ClipTagIndicator variant="dot" /><ClipTagIndicator variant="stripe" tags={[{ name: "Archive", color: 0 }]} /></>);
    expect(container.childElementCount).toBe(0);
  });

  it("puts the primary color below the art, exposes all names and preserves card actions", () => {
    const onSelect = vi.fn(), onOpen = vi.fn();
    const { container } = render(<LibraryCard title="Long clip.mov" detail="428 MB" art={{ kind: "remote", url: null }}
      requestThumb={async () => null} onOpen={onOpen} onSelect={onSelect} selected
      tags={[{ name: "Red", color: 6 }, { name: "Purple", color: 1 }, { name: "Archive", color: 0 }]} />);
    const card = container.querySelector<HTMLButtonElement>(".cp-lib-card")!;
    expect(card.querySelector(".cp-lib-card-art .cp-clip-tag")).toBeNull();
    expect(card.querySelectorAll(".cp-lib-card-caption .cp-clip-tag-dot")).toHaveLength(1);
    expect(card.getAttribute("aria-description")).toBe("Finder tags: Red, Purple, Archive");
    expect(card.title).toContain("Red, Purple, Archive");
    fireEvent.click(card); fireEvent.doubleClick(card); fireEvent.keyDown(card, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1); expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("keeps file-row cells and rename/open handlers while moving color to the edge", () => {
    const rename = vi.fn(), open = vi.fn(), select = vi.fn();
    const { container } = render(<LibraryListRow item={{ path: "/clip.mov", name: "clip.mov", kind: "video", size_bytes: 42, modified_ms: 0 }} selected
      onSelect={select} onOpen={open} onRename={rename} onChoosePoster={vi.fn()} onResetPoster={vi.fn()} requestThumb={async () => null}
      tags={[{ name: "Blue", color: 4 }]} />);
    const row = container.querySelector<HTMLButtonElement>(".cp-lib-lrow")!;
    expect(row.querySelector(":scope > .cp-clip-tag-stripe")).not.toBeNull();
    expect(row.querySelector(".cp-lib-lrow-name .cp-clip-tag")).toBeNull();
    expect([...row.children].filter((el) => !el.classList.contains("cp-clip-tag"))).toHaveLength(5);
    fireEvent.click(row.querySelector(".cp-lib-lrow-name")!);
    expect(rename).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "Enter" }); expect(open).toHaveBeenCalledTimes(1);
  });

  it("web rows use only the downloaded media path, never a URL as tag identity", () => {
    const items = [null, "/copy.mp4"].map((path, i) => ({ url: `https://example.test/${i}`, title: `Clip ${i}`, path, thumbnail: null, duration_seconds: 3, fetched_at: 0, size_bytes: null, uploader: null }));
    const { container } = render(<WebListRows items={items} sort="name" dir="asc" onSort={vi.fn()} onForget={vi.fn()} onOpenUrl={vi.fn()}
      tagsByPath={new Map([[items[0].url, [{ name: "Red", color: 6 }]], ["/copy.mp4", [{ name: "Green", color: 2 }]]])} />);
    const rows = container.querySelectorAll(".cp-lib-lrow");
    expect(rows[0].querySelector(".cp-clip-tag")).toBeNull();
    expect(rows[1].getAttribute("aria-description")).toBe("Finder tags: Green");
    expect(rows[1].querySelectorAll(".cp-clip-tag-stripe")).toHaveLength(1);
  });
});
