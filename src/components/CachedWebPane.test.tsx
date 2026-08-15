// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { CachedWebPane } from "./CachedWebPane";

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
    render(<CachedWebPane onOpenUrl={() => {}} />);
    (await screen.findByLabelText("Forget Reel")).click();
    await waitFor(() => expect(forgetCalls()).toBe(1));
  });

  it("does NOT delete a downloaded copy on the first click", async () => {
    h.items = [item({ path: "/tmp/a.mp4", size_bytes: 2_400_000_000 })];
    render(<CachedWebPane onOpenUrl={() => {}} />);
    (await screen.findByLabelText(/^Delete the .* copy of Reel$/)).click();
    // The click arms; nothing has been asked of the backend yet.
    await waitFor(() => expect(screen.getByLabelText(/^Confirm deleting/)).toBeTruthy());
    expect(forgetCalls()).toBe(0);
  });

  it("names the size in the button, not in a tooltip", async () => {
    h.items = [item({ path: "/tmp/a.mp4", size_bytes: 2_400_000_000 })];
    render(<CachedWebPane onOpenUrl={() => {}} />);
    (await screen.findByLabelText(/^Delete the/)).click();
    const btn = await screen.findByLabelText(/^Confirm deleting/);
    // The visible text carries the number. A user who never hovers still
    // learns what this costs before the second click.
    expect(btn.textContent).toMatch(/2\.\d+ GB|2 GB/);
  });

  it("deletes on the second click", async () => {
    h.items = [item({ path: "/tmp/a.mp4", size_bytes: 2_400_000_000 })];
    render(<CachedWebPane onOpenUrl={() => {}} />);
    (await screen.findByLabelText(/^Delete the/)).click();
    (await screen.findByLabelText(/^Confirm deleting/)).click();
    await waitFor(() => expect(forgetCalls()).toBe(1));
  });

  it("disarms on Escape, so an armed row is not a mine", async () => {
    h.items = [item({ path: "/tmp/a.mp4", size_bytes: 2_400_000_000 })];
    render(<CachedWebPane onOpenUrl={() => {}} />);
    (await screen.findByLabelText(/^Delete the/)).click();
    await screen.findByLabelText(/^Confirm deleting/);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => expect(screen.getByLabelText(/^Delete the/)).toBeTruthy());
    expect(forgetCalls()).toBe(0);
  });
});
