// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { YouTubeSettings } from "./YouTubeSettings";
import type { Defaults } from "./SettingsModal";
import type { YtdlpStatus } from "../bindings/YtdlpStatus";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const updated: YtdlpStatus = { version: "2026.08.19", updated: true };
const bundled: YtdlpStatus = { version: "2026.07.04", updated: false };
const defaults = { ytCookiesBrowser: "none", previewMaxHeight: 480 } as Defaults;
const mount = () => render(<YouTubeSettings defaults={defaults} setDefaults={vi.fn()}
  sectionOpen={() => true} toggleSection={vi.fn()} />);
const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
const idle = () => waitFor(() => expect(button("Update yt-dlp").disabled).toBe(false));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("saucebunny.ytdlpVersion", JSON.stringify(updated));
  invoke.mockReset().mockImplementation((cmd: string) => {
    if (cmd === "ytdlp_version" || cmd === "update_ytdlp") return Promise.resolve(updated);
    if (cmd === "reset_ytdlp") return Promise.resolve(bundled);
    throw new Error(`Unexpected command: ${cmd}`);
  });
});
afterEach(cleanup);

it("disables changes until the live version check completes", async () => {
  const probe = deferred<YtdlpStatus>();
  invoke.mockReturnValueOnce(probe.promise);
  mount();
  expect(button("Update yt-dlp").disabled).toBe(true);
  expect(button("Reset to bundled").disabled).toBe(true);
  await act(async () => probe.resolve(updated));
  await idle();
});

it("blocks Reset and duplicate clicks throughout an update", async () => {
  mount(); await idle();
  const update = deferred<YtdlpStatus>();
  invoke.mockReturnValueOnce(update.promise);
  const trigger = button("Update yt-dlp");
  act(() => { fireEvent.click(trigger); fireEvent.click(trigger); });
  expect(button("Reset to bundled").disabled).toBe(true);
  fireEvent.click(button("Reset to bundled"));
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "update_ytdlp")).toHaveLength(1);
  expect(invoke.mock.calls.some(([cmd]) => cmd === "reset_ytdlp")).toBe(false);
  await act(async () => update.resolve(updated));
  await idle();
});

it("blocks Update while Reset runs and uses Reset's verified result", async () => {
  mount(); await idle();
  const reset = deferred<YtdlpStatus>();
  invoke.mockReturnValueOnce(reset.promise);
  fireEvent.click(button("Reset to bundled"));
  expect(button("Update yt-dlp").disabled).toBe(true);
  fireEvent.click(button("Update yt-dlp"));
  expect(invoke.mock.calls.some(([cmd]) => cmd === "update_ytdlp")).toBe(false);
  await act(async () => reset.resolve(bundled));
  expect(await screen.findByText("Reverted to the bundled yt-dlp.")).toBeTruthy();
  expect(screen.getByText(bundled.version)).toBeTruthy();
  // Reset returns its probe under the backend operation lock. There must not
  // be another unprotected read whose error gets overwritten with success.
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "ytdlp_version")).toHaveLength(1);
});

it.each(["Cannot remove the updated copy", "Bundled yt-dlp failed verification"])(
  "reports Reset failure without success: %s", async (message) => {
    mount(); await idle();
    invoke.mockRejectedValueOnce({ kind: "Io", data: message });
    fireEvent.click(button("Reset to bundled"));
    expect(await screen.findByText(new RegExp(message))).toBeTruthy();
    expect(screen.queryByText("Reverted to the bundled yt-dlp.")).toBeNull();
    await idle();
    expect(button("Reset to bundled").disabled).toBe(false);
  },
);

it("does not present a cached version as verified after the live probe fails", async () => {
  invoke.mockRejectedValueOnce({ kind: "Internal", data: "Invalid yt-dlp version output" });
  mount(); await idle();
  expect(screen.getByText(/Invalid yt-dlp version output/)).toBeTruthy();
  expect(screen.queryByText(updated.version)).toBeNull();
  expect(localStorage.getItem("saucebunny.ytdlpVersion")).toBeNull();
  // A broken override must still be recoverable from this screen.
  expect(button("Reset to bundled").disabled).toBe(false);
});

it("offers nightly after a same-version stable update and clears it on Reset", async () => {
  mount(); await idle();
  fireEvent.click(button("Update yt-dlp"));
  expect(await screen.findByRole("button", { name: "Try the nightly build" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("update_ytdlp", { channel: "stable" });
  fireEvent.click(button("Reset to bundled"));
  expect(await screen.findByText("Reverted to the bundled yt-dlp.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Try the nightly build" })).toBeNull();
});

it("does not let an old mount's late probe overwrite the current version cache", async () => {
  const old = deferred<YtdlpStatus>();
  invoke.mockReturnValueOnce(old.promise);
  const first = mount(); first.unmount();
  invoke.mockResolvedValueOnce(updated);
  mount(); await idle();
  await act(async () => old.resolve(bundled));
  expect(JSON.parse(localStorage.getItem("saucebunny.ytdlpVersion")!)).toEqual(updated);
});
