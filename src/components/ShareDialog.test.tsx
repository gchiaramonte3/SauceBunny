// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareSources } from "../bindings/ShareSources";
import { ShareDialog } from "./ShareDialog";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const sources: ShareSources = { capture_engine: true,
  displays: [{ id: 7, label: "Generated screen", width: 1000, height: 800, thumb: null }],
  windows: [{ id: 7, app: "Generated editor", title: "Timeline", width: 400, height: 300, thumb: null }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const share = () => screen.getByRole("button", { name: "Share" }) as HTMLButtonElement;
const cancel = () => screen.getByRole("button", { name: "Cancel" });
function ordinary(command: string) {
  if (command === "screen_capture_access") return Promise.resolve("granted");
  if (command === "list_share_sources") return Promise.resolve(sources);
  throw new Error(`Unexpected action ${command}`);
}
beforeEach(() => { mocks.invoke.mockReset(); mocks.invoke.mockImplementation(ordinary); localStorage.clear(); });
afterEach(cleanup);

describe("screen and application sharing chooser", () => {
  it("keeps region fields in the scrolling body and audio/actions in a separate footer", async () => {
    render(<ShareDialog onClose={vi.fn()} onPick={vi.fn()}/>);
    await screen.findByRole("button", { name: /Generated screen/ });
    fireEvent.click(screen.getByRole("tab", { name: "Portion of screen" }));
    fireEvent.click(screen.getByRole("button", { name: /Generated screen/ }));
    const body = screen.getByRole("spinbutton", { name: "Width" }).closest(".cp-share-dialog-body");
    const footer = share().closest(".cp-share-dialog-foot");
    expect(body).not.toBeNull(); expect(footer).not.toBeNull();
    expect(body?.contains(footer)).toBe(false);
    expect(footer?.contains(screen.getByRole("checkbox", { name: "Share system audio" }))).toBe(true);
    expect(footer?.contains(cancel())).toBe(true);
    expect(body?.contains(screen.getByRole("heading", { name: "Share your screen" }))).toBe(false);
  });
  it("does not request permission on opening and keeps Cancel reachable", async () => {
    mocks.invoke.mockResolvedValue("undetermined");
    const onClose = vi.fn(), onPick = vi.fn();
    render(<ShareDialog onClose={onClose} onPick={onPick}/>);
    await screen.findByRole("button", { name: "Allow screen access" });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("screen_capture_access", { request: false });
    expect(share().disabled).toBe(true);
    fireEvent.click(cancel()); expect(onClose).toHaveBeenCalledTimes(1); expect(onPick).not.toHaveBeenCalled();
  });
  it("requests access only from the explicit Allow action", async () => {
    mocks.invoke.mockImplementation((command, args) => command === "screen_capture_access"
      ? Promise.resolve(args.request ? "granted" : "undetermined") : ordinary(command));
    render(<ShareDialog onClose={vi.fn()} onPick={vi.fn()}/>);
    fireEvent.click(await screen.findByRole("button", { name: "Allow screen access" }));
    await screen.findByRole("button", { name: /Generated screen/ });
    expect(mocks.invoke).toHaveBeenCalledWith("screen_capture_access", { request: true });
    expect(share().disabled).toBe(true);
  });
  it("clears hidden tab selection and disambiguates a display/window with the same id", async () => {
    const onPick = vi.fn(), onClose = vi.fn();
    render(<ShareDialog onClose={onClose} onPick={onPick}/>);
    fireEvent.click(await screen.findByRole("button", { name: /Generated screen/ }));
    expect(share().disabled).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "Windows" }));
    expect(share().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Timeline/ }));
    fireEvent.click(share()); fireEvent.click(share());
    expect(onPick).toHaveBeenCalledExactlyOnceWith({ kind: "window", id: 7, crop: null, audio: false });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("revalidates current membership and surfaces list failures instead of an empty list", async () => {
    const onPick = vi.fn();
    render(<ShareDialog onClose={vi.fn()} onPick={onPick}/>);
    fireEvent.click(await screen.findByRole("button", { name: /Generated screen/ }));
    mocks.invoke.mockImplementation(command => command === "list_share_sources"
      ? Promise.resolve({ ...sources, displays: [] }) : ordinary(command));
    fireEvent.click(screen.getByRole("button", { name: "Refresh sources" }));
    await screen.findByText("No displays found.");
    expect(share().disabled).toBe(true);
    mocks.invoke.mockImplementation(command => command === "list_share_sources"
      ? Promise.reject(new Error("Generated permission failure")) : ordinary(command));
    fireEvent.focus(window);
    expect((await screen.findByRole("alert")).textContent).toContain("Generated permission failure");
    expect(screen.queryByText("No displays found.")).toBeNull();
    expect(share().disabled).toBe(true); expect(cancel()).toBeTruthy(); expect(onPick).not.toHaveBeenCalled();
  });
  it("ignores pending permission results after Cancel before any snapshots", async () => {
    const pending = deferred<string>(); mocks.invoke.mockReturnValue(pending.promise);
    const onClose = vi.fn(); render(<ShareDialog onClose={onClose} onPick={vi.fn()}/>);
    fireEvent.click(cancel());
    await act(async () => pending.resolve("granted"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("screen_capture_access", { request: false });
  });
  it("submits explicit audio and the rounded region, rejecting strips and overflow", async () => {
    const onPick = vi.fn(); render(<ShareDialog onClose={vi.fn()} onPick={onPick}/>);
    await screen.findByRole("button", { name: /Generated screen/ });
    fireEvent.click(screen.getByRole("tab", { name: "Portion of screen" }));
    fireEvent.click(screen.getByRole("button", { name: /Generated screen/ }));
    const field = (name: string, value: string) => fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value } });
    field("Left", "10"); field("Top", "20"); field("Width", "50"); field("Height", "40");
    expect(share().disabled).toBe(false);
    field("Height", "2.04"); // 16.32px rounds to the forbidden 16px.
    expect(share().disabled).toBe(true);
    field("Height", "90"); expect(share().disabled).toBe(true);
    field("Height", "40");
    fireEvent.click(screen.getByRole("checkbox", { name: "Share system audio" }));
    fireEvent.click(share());
    await waitFor(() => expect(onPick).toHaveBeenCalledExactlyOnceWith({ kind: "display", id: 7, crop: "100,160,500,320", audio: true }));
  });
});
