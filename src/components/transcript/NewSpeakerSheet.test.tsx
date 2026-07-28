// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NewSpeakerSheet, type SpeakerSuggestion } from "./NewSpeakerSheet";
import { SPEAKER_PALETTE } from "./helpers";

afterEach(cleanup);

/** Deliberately NOT in talk-time order, so a passing sort test means something. */
const CAST: SpeakerSuggestion[] = [
  { tag: "S2", name: "Speaker 2", color: "#FE8F5D", talkSeconds: 30 },
  { tag: "Speaker", name: "Unknown speaker", color: "#AAAD98", talkSeconds: 4000, untagged: true },
  { tag: "S1", name: "Harry Jowsey", color: "#75B0FF", talkSeconds: 900 },
  { tag: "S3", name: "Speaker 3", color: "#EB9A04", talkSeconds: 120 },
  ...Array.from({ length: 20 }, (_, i) => ({
    tag: `X${i}`, name: `Speaker ${i + 10}`, color: "#0AF2CD", talkSeconds: 5,
  })),
];

function show(over: Partial<React.ComponentProps<typeof NewSpeakerSheet>> = {}) {
  const props = {
    suggestions: CAST,
    initialColor: SPEAKER_PALETTE[3],
    onName: vi.fn(),
    onPickExisting: vi.fn(),
    onCancel: vi.fn(),
  };
  render(<NewSpeakerSheet {...props} {...over} />);
  return props;
}

const chipNames = () =>
  Array.from(document.querySelectorAll(".cp-newspk-sname")).map((e) => e.textContent);
const nameField = () => screen.getByPlaceholderText("Name") as HTMLInputElement;
const pip = () => document.querySelector(".cp-newspk-pip") as HTMLButtonElement;

describe("ordering", () => {
  it("puts the loudest speaker first, not the first-heard one", () => {
    show();
    expect(chipNames()[0]).toBe("Harry Jowsey");
  });

  it("sinks the untagged bucket below every real person", () => {
    // It has more seconds than anyone here, and it is still not a person.
    show();
    const names = chipNames();
    expect(names[names.length - 1]).toBe("Unknown speaker");
    expect(names.indexOf("Speaker 2")).toBeLessThan(names.indexOf("Unknown speaker"));
  });

  it("orders the real speakers by talk time descending", () => {
    show();
    const names = chipNames().filter((n) => n !== "Unknown speaker");
    expect(names.slice(0, 3)).toEqual(["Harry Jowsey", "Speaker 3", "Speaker 2"]);
  });
});

describe("the name field doubles as a filter", () => {
  it("promotes what you type to the front", () => {
    show();
    expect(chipNames()[0]).toBe("Harry Jowsey");
    fireEvent.change(nameField(), { target: { value: "speaker 3" } });
    expect(chipNames()[0]).toBe("Speaker 3");
  });

  it("promotes rather than filtering, so a brand new name never empties the list", () => {
    // THE reason this is promotion and not a filter. The field's primary job
    // is naming somebody NEW, so filtering would blank the list on the most
    // common action in the sheet and read as an error state.
    show();
    const before = chipNames().length;
    fireEvent.change(nameField(), { target: { value: "Marcus Aurelius" } });
    expect(chipNames()).toHaveLength(before);
    expect(document.querySelectorAll(".cp-newspk-suggest.hit")).toHaveLength(0);
  });

  it("marks the promoted chips so the reordering is explicable", () => {
    show();
    fireEvent.change(nameField(), { target: { value: "harry" } });
    const hits = Array.from(document.querySelectorAll(".cp-newspk-suggest.hit"));
    expect(hits).toHaveLength(1);
    expect(hits[0].textContent).toContain("Harry Jowsey");
  });
});

describe("the list is bounded", () => {
  it("shows every speaker, however many there are", () => {
    // Scrolling, not truncating: a chip that is not rendered is a speaker you
    // cannot reassign to, and silently dropping targets is worse than a scroll.
    show();
    expect(chipNames()).toHaveLength(CAST.length);
  });

  it("says how many there are", () => {
    show();
    expect(document.querySelector(".cp-newspk-count")?.textContent).toBe(String(CAST.length));
  });

  it("shows talk time on each chip, so the order has a visible reason", () => {
    show();
    const talks = Array.from(document.querySelectorAll(".cp-newspk-talk")).map((e) => e.textContent);
    expect(talks[0]).toBe("15m");      // Harry, 900s
    expect(talks).toContain("2m");     // Speaker 3, 120s
    expect(talks).toContain("30s");    // Speaker 2
  });
});

describe("the colour cycle", () => {
  it("only ever produces colours from the speaker palette", () => {
    // The list here used to be a hardcoded copy of the OLD six-colour palette.
    // Six of the twelve real speaker colours were unreachable from this sheet.
    show();
    const seen = new Set<string>();
    for (let i = 0; i < SPEAKER_PALETTE.length + 2; i += 1) {
      fireEvent.click(pip());
      seen.add(pip().style.background);
    }
    for (const c of seen) {
      const hex = rgbToHex(c);
      expect(SPEAKER_PALETTE.map((p) => p.toLowerCase())).toContain(hex);
    }
  });

  it("never lands on the accent green", () => {
    // The specific bug. `indexOf` returned -1 for any current colour that was
    // not in the stale list, and (-1 + 1 + 6) % 6 is 0 — so the FIRST click
    // always produced entry zero, which was #6CFF8D: the app's accent, and the
    // one hue the palette deliberately excludes because a speaker wearing it
    // is indistinguishable from a selected control.
    show();
    for (let i = 0; i < 15; i += 1) {
      fireEvent.click(pip());
      expect(rgbToHex(pip().style.background)).not.toBe("#6cff8d");
    }
  });

  it("reaches every palette entry rather than a subset", () => {
    show();
    const seen = new Set<string>();
    for (let i = 0; i < SPEAKER_PALETTE.length * 2; i += 1) {
      fireEvent.click(pip());
      seen.add(rgbToHex(pip().style.background));
    }
    expect(seen.size).toBe(SPEAKER_PALETTE.length);
  });
});

describe("committing", () => {
  it("hands back the typed name and the chosen colour", () => {
    const props = show();
    fireEvent.change(nameField(), { target: { value: "  Marcus  " } });
    fireEvent.submit(nameField().closest("form")!);
    expect(props.onName).toHaveBeenCalledWith("Marcus", SPEAKER_PALETTE[3]);
  });

  it("gives the lines to an existing speaker by tag", () => {
    const props = show();
    fireEvent.click(screen.getByTitle("Give these lines to Harry Jowsey"));
    expect(props.onPickExisting).toHaveBeenCalledWith("S1");
  });

  it("can hand the lines back to the untagged bucket", () => {
    // How you undo a bad split.
    const props = show();
    fireEvent.click(screen.getByTitle("Give these lines to Unknown speaker"));
    expect(props.onPickExisting).toHaveBeenCalledWith("Speaker");
  });

  it("will not name a speaker nothing", () => {
    show();
    const submit = screen.getByRole("button", { name: "Name them" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(nameField(), { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
  });
});

/** jsdom reports style.background as `rgb(r, g, b)`. */
function rgbToHex(v: string): string {
  const m = v.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return v.toLowerCase();
  return "#" + [1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, "0")).join("");
}
