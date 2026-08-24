// @vitest-environment jsdom
//
// The frame viewer. Opening a grabbed still used to reveal it in Finder,
// which sent the user to another app to answer the one question a still is
// grabbed to answer. These pin the viewer that replaced that, and in
// particular the two things that are easy to get subtly wrong: that a frame
// is addressed by PATH rather than by index, and that stepping wraps.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FramePreview } from "./FramePreview";
import type { FrameItem } from "../lib/frames";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve() }));
vi.mock("../lib/asset-url", () => ({ assetUrl: (p: string) => `asset://${p}` }));

const f = (over: Partial<FrameItem>): FrameItem => ({
  path: "/Frames/a.jpg", name: "a.jpg", source: "Bear",
  folder: "", timecode: null, created_at: 0, size_bytes: 0, ...over,
});

const three = [
  f({ path: "/Frames/1.jpg", name: "one.jpg" }),
  f({ path: "/Frames/2.jpg", name: "two.jpg" }),
  f({ path: "/Frames/3.jpg", name: "three.jpg" }),
];

beforeEach(() => { document.body.innerHTML = ""; });

function mount(over: Partial<Parameters<typeof FramePreview>[0]> = {}) {
  const props = {
    items: three,
    path: "/Frames/2.jpg",
    onPath: vi.fn(),
    onClose: vi.fn(),
    onReveal: vi.fn(),
    ...over,
  };
  render(<FramePreview {...props} />);
  return props;
}

describe("the frame viewer", () => {
  it("shows the frame full size, with its facts", () => {
    mount({
      items: [f({ path: "/Frames/2.jpg", name: "two.jpg", source: "Solo", timecode: "00012304", size_bytes: 4096 })],
      path: "/Frames/2.jpg",
    });
    const img = document.querySelector(".cp-framepv-img") as HTMLImageElement;
    expect(img.src).toContain("/Frames/2.jpg");
    expect(screen.getByText("two.jpg")).toBeTruthy();
    // Source, timecode with its colons back, and size on one line.
    expect(screen.getByText(/Solo · 00:01:23:04 · 4/)).toBeTruthy();
  });

  it("is a real modal: labelled, and it traps focus", () => {
    mount();
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toContain("two.jpg");
    // aria-modal claims everything outside is inert, so focus has to land
    // inside - the container carries tabIndex={-1} for exactly that.
    expect(dialog.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(dialog);
  });

  it("steps with the arrow keys, in the order it was handed", () => {
    const p = mount();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(p.onPath).toHaveBeenCalledWith("/Frames/3.jpg");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(p.onPath).toHaveBeenCalledWith("/Frames/1.jpg");
  });

  it("wraps at both ends, so a shelf is a ring", () => {
    const last = mount({ path: "/Frames/3.jpg" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(last.onPath).toHaveBeenCalledWith("/Frames/1.jpg");

    document.body.innerHTML = "";
    const first = mount({ path: "/Frames/1.jpg" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(first.onPath).toHaveBeenCalledWith("/Frames/3.jpg");
  });

  it("Home and End jump to the ends of the shelf", () => {
    const p = mount();
    fireEvent.keyDown(window, { key: "Home" });
    expect(p.onPath).toHaveBeenCalledWith("/Frames/1.jpg");
    fireEvent.keyDown(window, { key: "End" });
    expect(p.onPath).toHaveBeenCalledWith("/Frames/3.jpg");
  });

  it("Esc closes, and so does the scrim behind it", () => {
    const p = mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(p.onClose).toHaveBeenCalled();

    document.body.innerHTML = "";
    const q = mount();
    const scrim = document.querySelector(".cp-framepv-scrim")!;
    fireEvent.pointerDown(scrim);
    expect(q.onClose).toHaveBeenCalled();
  });

  it("a click ON the picture does not close it", () => {
    const p = mount();
    fireEvent.pointerDown(document.querySelector(".cp-framepv-img")!);
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it("closes when the frame it is showing disappears from the shelf", () => {
    // A delete from the card menu, or a move in Finder picked up by the
    // focus re-read. Holding an empty lightbox over the shelf is worse than
    // dropping back to it.
    const p = mount({ items: three, path: "/Frames/9.jpg" });
    expect(p.onClose).toHaveBeenCalled();
    expect(document.querySelector(".cp-framepv-img")).toBeNull();
  });

  it("says why a frame is blank instead of showing a broken-image glyph", () => {
    // A denied asset read is a 403 with an EMPTY body, so the browser's own
    // failure carries no reason at all.
    mount();
    fireEvent.error(document.querySelector(".cp-framepv-img")!);
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(document.querySelector(".cp-framepv-img")).toBeNull();
  });

  it("a single frame gets no steppers and no counter", () => {
    mount({ items: [three[1]], path: "/Frames/2.jpg" });
    expect(screen.queryByLabelText("Next frame")).toBeNull();
    expect(screen.queryByText(/1 of 1/)).toBeNull();
  });

  it("counts position in the shelf, and reveals the frame on show", () => {
    const p = mount();
    expect(screen.getByText("2 of 3")).toBeTruthy();
    screen.getByRole("button", { name: /Reveal/ }).click();
    expect(p.onReveal).toHaveBeenCalledWith("/Frames/2.jpg");
  });
});
