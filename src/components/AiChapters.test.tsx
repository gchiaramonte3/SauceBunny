// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AiChapters } from "./AiChapters";
import { saveChapters } from "../lib/chapters";

/**
 * Chapters fold away once they have been read.
 *
 * A detected list is a dozen-plus rows inside a drawer that also has to hold
 * the summary and the chat, so after the first read it is mostly in the way —
 * but it is also the seek index, so removing it is not the answer. It folds to
 * its header, which keeps the count and both actions reachable.
 */

vi.mock("../lib/ai-chat", () => ({ streamChat: vi.fn(async () => "") }));

const SOURCE = "src-key";
const CHAPTERS = [
  { time: 0, title: "Introduction" },
  { time: 260, title: "Guest Welcome" },
  { time: 330, title: "Golden Ticket Winner" },
];

function mount() {
  render(
    <AiChapters
      sourceKey={SOURCE}
      durationSec={3600}
      lines={["0:00 hello"]}
      ensureServer={async () => null}
      chatBusy={false}
    />,
  );
}

beforeEach(() => { localStorage.clear(); saveChapters(SOURCE, CHAPTERS); });
afterEach(cleanup);

const rows = () => document.querySelectorAll(".cp-ai-chapter-row").length;

describe("AI chapters", () => {
  it("lists the chapters, expanded, by default", () => {
    mount();
    expect(rows()).toBe(3);
  });

  it("folds to the header when the title is clicked", () => {
    mount();
    const toggle = screen.getByRole("button", { name: /Chapters/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(rows(), "the list is still taking up the room").toBe(0);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the count visible while folded, so the header still says what it holds", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Chapters/ }));
    expect(screen.getByRole("button", { name: /Chapters/ }).textContent).toContain("3");
  });

  it("keeps Copy and Regenerate reachable while folded", () => {
    // Folding is not disabling. Both actions act on the list, not on the view
    // of it, so hiding them would turn a fold into a dead end.
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Chapters/ }));
    expect(screen.getByRole("button", { name: /Copy for YouTube/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Regenerate/ })).toBeTruthy();
  });

  it("remembers the fold across a remount", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: /Chapters/ }));
    cleanup();
    mount();
    expect(rows(), "came back expanded").toBe(0);
  });

  it("clears every chapter, but only on a second click", () => {
    mount();
    const clear = () => screen.getByRole("button", { name: /clear/i });
    fireEvent.click(clear());
    expect(rows(), "one click wiped the list with no confirmation").toBe(3);
    expect(clear().textContent).toMatch(/again/);
    fireEvent.click(clear());
    expect(rows()).toBe(0);
  });

  it("forgets the pending confirm when focus leaves", () => {
    // So "I did not mean that" is clicking anywhere else, not a second commit.
    mount();
    const clear = () => screen.getByRole("button", { name: /clear/i });
    fireEvent.click(clear());
    fireEvent.blur(clear());
    expect(clear().textContent).toBe("Clear");
    fireEvent.click(clear());
    expect(rows(), "a stale confirm cleared on the next click").toBe(3);
  });

  it("clears the SAVED copy too, not just the view", () => {
    // The list also feeds the Timeline's markers. Clearing only local state
    // would leave markers on the scrubber for chapters that no longer exist.
    mount();
    const clear = () => screen.getByRole("button", { name: /clear/i });
    fireEvent.click(clear());
    fireEvent.click(clear());
    cleanup();
    mount();
    expect(rows(), "the chapters came back from storage").toBe(0);
  });

  it("offers no Clear when there is nothing to clear", () => {
    localStorage.clear();
    saveChapters(SOURCE, []);
    mount();
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });

  it("offers a Stop while a detection is running", async () => {
    // A run against a feature-length transcript is minutes of prompt ingestion
    // before the first token. The abort controller existed and was only fired
    // by unmount or a source change, so from the UI there was no way out.
    const { streamChat } = await import("../lib/ai-chat");
    let aborted = false;
    vi.mocked(streamChat).mockImplementation(
      (_i: unknown, _p: unknown, _o: unknown, signal?: AbortSignal) =>
        new Promise((_res, rej) => {
          signal?.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); });
        }) as never,
    );
    render(
      <AiChapters
        sourceKey={SOURCE}
        durationSec={3600}
        lines={["0:00 hello"]}
        ensureServer={async () => ({ ctx: 8192 } as never)}
        chatBusy={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Regenerate/ }));
    const stop = await screen.findByRole("button", { name: /Stop/ });
    fireEvent.click(stop);
    expect(aborted, "Stop did not reach the in-flight request").toBe(true);
  });

  it("offers no toggle when there is nothing to fold", () => {
    // A disclosure that reveals nothing is a control that does not work.
    localStorage.clear();
    saveChapters(SOURCE, []);
    mount();
    expect(screen.queryByRole("button", { name: /^Chapters/ })).toBeNull();
  });
});
