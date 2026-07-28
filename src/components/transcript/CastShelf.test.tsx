// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const invoke = vi.fn(async (cmd: string) => {
  if (cmd === "default_transcript_library_path") return "/Docs/Sauce Bunny/Transcripts";
  if (cmd === "read_text_file_capped") throw new Error("ENOENT");
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...(a as [string])) }));

const { CastShelf } = await import("./CastShelf");
const { __resetCastStore, getCasts, hydrateCastStore, saveCast } = await import("../../lib/cast-store");
const { newCast, newMember } = await import("../../lib/cast");
type RosterItem = import("./SpeakerRosterModal").RosterItem;

const ROSTER: RosterItem[] = [
  { tag: "Speaker", colorTag: null, name: "Unassigned", turnCount: 2, talkSeconds: 10 },
  { tag: "S0", colorTag: "S0", name: "Ada", turnCount: 4, talkSeconds: 40 },
  { tag: "S1", colorTag: "S1", name: "Basil", turnCount: 9, talkSeconds: 400 },
];

function show(over: Partial<React.ComponentProps<typeof CastShelf>> = {}) {
  const props = {
    roster: ROSTER,
    colorOf: (r: RosterItem) => (r.tag === "S0" ? "#FD8A8C" : "#0AF2CD"),
    onApply: vi.fn(),
    onBack: vi.fn(),
  };
  render(<CastShelf {...props} {...over} />);
  return props;
}

const nameField = () => screen.getByLabelText("Name for a new cast") as HTMLInputElement;
const saveBtn = () => screen.getByRole("button", { name: /^Save / }) as HTMLButtonElement;

beforeEach(async () => { __resetCastStore(); await hydrateCastStore(); });
afterEach(cleanup);

describe("CastShelf", () => {
  it("captures the speakers you already named, with their colours", () => {
    // The bootstrap path. Making the user rebuild the roster in a separate
    // manager would defeat the whole feature.
    show();
    fireEvent.change(nameField(), { target: { value: "The Show" } });
    fireEvent.click(saveBtn());

    expect(getCasts()).toHaveLength(1);
    expect(getCasts()[0].name).toBe("The Show");
    expect(getCasts()[0].members.map((m) => [m.name, m.color]))
      .toEqual([["Ada", "#FD8A8C"], ["Basil", "#0AF2CD"]]);
  });

  it("counts only the real speakers, not the untagged bucket", () => {
    show();
    expect(saveBtn().textContent).toContain("2");
  });

  it("will not save without a name", () => {
    show();
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: "   " } });
    expect(saveBtn().disabled).toBe(true);
    expect(getCasts()).toEqual([]);
  });

  it("clears the field after saving, so Enter twice is not two casts", () => {
    show();
    fireEvent.change(nameField(), { target: { value: "The Show" } });
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(nameField().value).toBe("");
    fireEvent.keyDown(nameField(), { key: "Enter" });
    expect(getCasts()).toHaveLength(1);
  });

  it("takes two presses to delete, and Keep really keeps", () => {
    // A cast is a season of naming and the store has no undo, so a bare
    // delete button one pixel from Apply is not a thing to ship.
    saveCast(newCast("The Show", [newMember("Ada", "#FD8A8C")]));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Delete The Show" }));
    expect(getCasts()).toHaveLength(1); // nothing gone yet

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(getCasts()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete The Show" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(getCasts()).toEqual([]);
  });

  it("hands the chosen cast to the assign step rather than applying it blind", () => {
    const c = newCast("The Show", [newMember("Ada", "#FD8A8C")]);
    saveCast(c);
    const props = show();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(props.onApply).toHaveBeenCalledTimes(1);
    expect(props.onApply.mock.calls[0][0].id).toBe(c.id);
  });

  it("cannot apply an empty cast", () => {
    saveCast(newCast("Empty", []));
    show();
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says what to do when the shelf is bare", () => {
    show();
    expect(screen.getByText(/No saved casts yet/)).toBeTruthy();
  });
});
