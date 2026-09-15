// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaptureAudioOption, CaptureRegionEditor, CaptureSourceGrid, CaptureSourceTabs, captureRegionValid, type CaptureRegion } from "./CaptureSourcePicker";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const thumbnail = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

describe("shared source choices", () => {
  it("identifies duplicate titles, selects exact IDs, and contains original thumbnails", () => {
    const onSelect = vi.fn();
    render(<CaptureSourceGrid sources={[{ id: "501", label: "Composer", description: "Window 501", thumbnail },
      { id: "502", label: "Composer", description: "Window 502" }]} selectedId="502" onSelect={onSelect}/>);
    const selected = screen.getByRole("button", { name: "Composer · Window 502" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.getAttribute("data-capture-source-id")).toBe("502");
    fireEvent.click(screen.getByRole("button", { name: "Composer · Window 501" }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("501");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(thumbnail);
  });

  it("does not report empty results while busy and disables inactive choices", () => {
    const onSelect = vi.fn();
    const view = render(<CaptureSourceGrid sources={[]} selectedId={null} onSelect={onSelect} busy emptyLabel="No visible windows."/>);
    expect(screen.queryByText("No visible windows.")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Finding sources…");
    view.rerender(<CaptureSourceGrid sources={[{ id: "1", label: "Screen" }]} selectedId={null} onSelect={onSelect} disabled/>);
    fireEvent.click(screen.getByRole("button", { name: "Screen" }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("uses roving tabs, skips disabled tabs and wraps arrows", () => {
    function Tabs() {
      const [selected, setSelected] = useState("screens");
      return <CaptureSourceTabs tabs={[{ id: "screens", label: "Screens" }, { id: "windows", label: "Windows", disabled: true },
        { id: "portion", label: "Portion" }]} selected={selected} onSelect={setSelected} label="Source type"/>;
    }
    render(<Tabs/>);
    const screens = screen.getByRole("tab", { name: "Screens" });
    const portion = screen.getByRole("tab", { name: "Portion" });
    expect(screens.tabIndex).toBe(0); expect(portion.tabIndex).toBe(-1);
    fireEvent.keyDown(screens, { key: "ArrowRight" });
    expect(document.activeElement).toBe(portion); expect(portion.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(portion, { key: "ArrowRight" }); expect(document.activeElement).toBe(screens);
    fireEvent.keyDown(screens, { key: "End" }); expect(document.activeElement).toBe(portion);
    fireEvent.keyDown(portion, { key: "Home" }); expect(document.activeElement).toBe(screens);
  });

  it("keeps audio explicit and honors the disabled state", () => {
    const onChange = vi.fn();
    const view = render(<CaptureAudioOption checked={false} onChange={onChange} label="Share system audio" description="Only with Share."/>);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Share system audio" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    view.rerender(<CaptureAudioOption checked={false} onChange={onChange} label="Share system audio" disabled/>);
    fireEvent.click(screen.getByRole("checkbox")); expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe("controlled crop editor", () => {
  it("rejects missing, nonfinite, out-of-bounds, and 16-pixel strips", () => {
    const region = { x: .1, y: .1, width: .5, height: .5 };
    expect(captureRegionValid(region, 1000, 500)).toBe(true);
    for (const crop of [null, { ...region, x: NaN }, { ...region, height: Infinity }, { ...region, x: -.1 },
      { ...region, width: .95 }, { ...region, width: .016 }, { ...region, height: .032 }]) {
      expect(captureRegionValid(crop, 1000, 500)).toBe(false);
    }
    expect(captureRegionValid(region, 0, 500)).toBe(false);
    expect(captureRegionValid(region, 1000, NaN)).toBe(false);
  });

  it("edits percentages without substituting a whole-source crop for invalid or empty fields", () => {
    const onChange = vi.fn();
    render(<CaptureRegionEditor thumbnail={thumbnail} label="Screen" width={1000} height={500}
      crop={{ x: .1, y: .2, width: .5, height: .6 }} onChange={onChange}/>);
    expect((screen.getByRole("spinbutton", { name: "Left" }) as HTMLInputElement).value).toBe("10");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "95" } });
    expect(onChange).toHaveBeenLastCalledWith({ x: .1, y: .2, width: .95, height: .6 });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Top" }), { target: { value: "" } });
    expect(Number.isNaN(onChange.mock.calls.at(-1)?.[0].y)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("moves and resizes one source pixel with keyboard, but never handles an input's arrows", () => {
    const onChange = vi.fn();
    render(<CaptureRegionEditor thumbnail={thumbnail} label="Screen" width={1000} height={500}
      crop={{ x: .1, y: .2, width: .5, height: .6 }} onChange={onChange}/>);
    const surface = screen.getByRole("group", { name: "Screen crop" });
    fireEvent.keyDown(surface, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith({ x: .101, y: .2, width: .5, height: .6 });
    fireEvent.keyDown(surface, { key: "ArrowDown", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ x: .1, y: .2, width: .5, height: .602 });
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Left" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("draws, moves and resizes the same normalized rectangle on the thumbnail", () => {
    class TestPointerEvent extends MouseEvent { pointerId = 1; }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    const onChange = vi.fn();
    function Editor() {
      const [crop, setCrop] = useState<CaptureRegion | null>(null);
      return <CaptureRegionEditor thumbnail={thumbnail} label="Screen" width={1000} height={500}
        crop={crop} onChange={value => { onChange(value); setCrop(value); }}/>;
    }
    render(<Editor/>);
    const surface = screen.getByRole("group", { name: "Screen crop" });
    surface.setPointerCapture = vi.fn(); surface.releasePointerCapture = vi.fn();
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 500, height: 250 } as DOMRect);
    fireEvent.pointerDown(surface, { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerUp(surface, { clientX: 250, clientY: 200 });
    expect(onChange).toHaveBeenLastCalledWith({ x: .1, y: .2, width: .4, height: .6000000000000001 });
    const rectangle = surface.querySelector<HTMLElement>("[data-crop-operation='move']")!;
    fireEvent.pointerDown(rectangle, { clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerUp(surface, { clientX: 150, clientY: 100 });
    expect(onChange.mock.calls.at(-1)?.[0].x).toBeCloseTo(.2);
    const corner = surface.querySelector<HTMLElement>("[data-crop-operation='bottom-right']")!;
    fireEvent.pointerDown(corner, { clientX: 300, clientY: 200, button: 0 });
    fireEvent.pointerUp(surface, { clientX: 400, clientY: 225 });
    expect(onChange.mock.calls.at(-1)?.[0].width).toBeCloseTo(.6);
    expect(onChange.mock.calls.at(-1)?.[0].height).toBeCloseTo(.7);
  });

  it("draws inside an initial whole-source crop and restores it if the pointer gesture is cancelled", () => {
    class TestPointerEvent extends MouseEvent { pointerId = 1; }
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    const whole = { x: 0, y: 0, width: 1, height: 1 }, onChange = vi.fn();
    function Editor() {
      const [crop, setCrop] = useState<CaptureRegion | null>(whole);
      return <CaptureRegionEditor thumbnail={thumbnail} label="Screen" width={1000} height={500}
        crop={crop} onChange={value => { onChange(value); setCrop(value); }}/>;
    }
    render(<Editor/>);
    const surface = screen.getByRole("group", { name: "Screen crop" });
    surface.setPointerCapture = vi.fn(); surface.releasePointerCapture = vi.fn();
    vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 500, height: 250 } as DOMRect);
    fireEvent.pointerDown(surface.querySelector("[data-crop-operation='move']")!, { clientX: 50, clientY: 50, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith({ x: .1, y: .2, width: 0, height: 0 });
    fireEvent.pointerMove(surface, { clientX: 250, clientY: 200 });
    expect(onChange.mock.calls.at(-1)?.[0].width).toBeCloseTo(.4);
    fireEvent.pointerCancel(surface);
    expect(onChange).toHaveBeenLastCalledWith(whole);
    fireEvent.pointerUp(surface, { clientX: 450, clientY: 200 });
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("cannot resize through the minimum and disables field changes with its caller", () => {
    const onChange = vi.fn(), crop = { x: 0, y: 0, width: .017, height: .034 };
    const view = render(<CaptureRegionEditor thumbnail={thumbnail} label="Screen" width={1000} height={500} crop={crop} onChange={onChange}/>);
    fireEvent.keyDown(screen.getByRole("group", { name: "Screen crop" }), { key: "ArrowLeft", shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    view.rerender(<CaptureRegionEditor thumbnail={thumbnail} label="Screen" width={1000} height={500} crop={crop} onChange={onChange} disabled/>);
    fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "80" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
