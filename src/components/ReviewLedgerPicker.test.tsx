// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewLedgerPicker } from "./ReviewLedgerPicker";
import { ALL_NOTES, type Ledger, type LedgerLens } from "../lib/review-ledger";

/**
 * The picker's behaviour, as opposed to the ledger's arithmetic: what it
 * renders, when it renders nothing at all, and what it hands back.
 */

let root: Root | null = null;
let host: HTMLDivElement;

const ledger = (over: Partial<Ledger> = {}): Ledger => ({
  sessions: [
    { id: "s3", title: "Session 3", startedAt: 3_000_000, endedAt: 3_100_000, participants: ["Ana", "Bo"], commentIds: new Set(["c3"]) },
    { id: "s1", title: "Session 1", startedAt: 1_000_000, endedAt: 1_100_000, participants: ["Ana"], commentIds: new Set(["c1", "c2"]) },
  ],
  soloIds: new Set(["solo1"]),
  ...over,
});

function render(l: Ledger, lens: LedgerLens, onPick = () => {}) {
  act(() => {
    root = createRoot(host);
    root.render(<ReviewLedgerPicker ledger={l} lens={lens} onPick={onPick} totalRoots={4} />);
  });
}

beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); });
afterEach(() => { act(() => { root?.unmount(); }); root = null; host.remove(); });

describe("ReviewLedgerPicker", () => {
  it("renders NOTHING when the source has no session history", () => {
    // A chevron opening a list of one is furniture. Solo notes alone are not
    // a history: there is nowhere to go back to.
    render({ sessions: [], soloIds: new Set(["a"]) }, ALL_NOTES);
    expect(host.textContent, "the picker appeared with no sessions to offer").toBe("");
  });

  it("names what you are reading, defaulting to All notes", () => {
    render(ledger(), ALL_NOTES);
    expect(host.querySelector(".cp-ledger-btn-label")?.textContent).toBe("All notes");
    // Not marked as scoped: nothing is being withheld.
    expect(host.querySelector(".cp-ledger-btn")?.className).not.toContain("scoped");
  });

  it("marks itself scoped once it IS hiding notes", () => {
    // The state a reader must never be in without knowing.
    render(ledger(), { kind: "session", id: "s1" });
    expect(host.querySelector(".cp-ledger-btn")?.className).toContain("scoped");
    expect(host.querySelector(".cp-ledger-btn-label")?.textContent).toBe("Session 1");
  });

  it("lists All, then the sessions newest first, then the solo bucket", () => {
    render(ledger(), ALL_NOTES);
    act(() => { host.querySelector<HTMLButtonElement>(".cp-ledger-btn")!.click(); });
    const titles = [...host.querySelectorAll(".cp-ledger-item-title")].map((e) => e.textContent);
    expect(titles).toEqual(["All notes", "Session 3", "Session 1", "Outside a session"]);
  });

  it("shows each session's own note count, which is why the list is worth opening", () => {
    render(ledger(), ALL_NOTES);
    act(() => { host.querySelector<HTMLButtonElement>(".cp-ledger-btn")!.click(); });
    const metas = [...host.querySelectorAll(".cp-ledger-item-meta")].map((e) => e.textContent);
    expect(metas[0]).toBe("4 notes");
    expect(metas[1], "the session's note count is missing").toContain("1 note");
    expect(metas[1], "who was in the room is missing").toContain("Ana, Bo");
    expect(metas[2]).toContain("2 notes");
  });

  it("omits the solo row when every note was made in a session", () => {
    render(ledger({ soloIds: new Set() }), ALL_NOTES);
    act(() => { host.querySelector<HTMLButtonElement>(".cp-ledger-btn")!.click(); });
    const titles = [...host.querySelectorAll(".cp-ledger-item-title")].map((e) => e.textContent);
    expect(titles, "an empty bucket was offered").not.toContain("Outside a session");
  });

  it("hands back the lens that was chosen, and closes", () => {
    const onPick = vi.fn();
    render(ledger(), ALL_NOTES, onPick);
    act(() => { host.querySelector<HTMLButtonElement>(".cp-ledger-btn")!.click(); });
    const rows = host.querySelectorAll<HTMLButtonElement>(".cp-ledger-item");
    act(() => { rows[2].click(); });   // Session 1
    expect(onPick).toHaveBeenCalledWith({ kind: "session", id: "s1" });
    expect(host.querySelector(".cp-ledger-menu"), "the menu stayed open").toBeNull();
  });

  it("is a menu, so the keyboard can reach it", () => {
    render(ledger(), ALL_NOTES);
    const btn = host.querySelector(".cp-ledger-btn")!;
    expect(btn.getAttribute("aria-haspopup")).toBe("menu");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    act(() => { (btn as HTMLButtonElement).click(); });
    expect(host.querySelector(".cp-ledger-btn")!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[role="menu"]')).toBeTruthy();
    expect(host.querySelectorAll('[role="menuitem"]').length).toBe(4);
  });
});
