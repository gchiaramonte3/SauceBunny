import { describe, it, expect } from "vitest";
import {
  KEY_ACTIONS,
  bindingsFor,
  buildComboMap,
  assignBinding,
  resetBinding,
  eventToCombo,
  formatCombo,
  formatBindings,
  type KeybindingOverrides,
} from "./keybindings";

function ev(partial: Partial<{ code: string; key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) {
  return {
    code: "", key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    ...partial,
  };
}

describe("eventToCombo", () => {
  it("serializes a bare letter from e.code (shift/caps independent)", () => {
    expect(eventToCombo(ev({ code: "KeyJ", key: "j" }))).toBe("j");
    expect(eventToCombo(ev({ code: "KeyJ", key: "J", shiftKey: true }))).toBe("shift+j");
  });
  it("treats meta and ctrl as the same 'mod'", () => {
    expect(eventToCombo(ev({ code: "KeyK", key: "k", metaKey: true }))).toBe("mod+k");
    expect(eventToCombo(ev({ code: "KeyK", key: "k", ctrlKey: true }))).toBe("mod+k");
  });
  it("orders modifiers mod+alt+shift", () => {
    expect(eventToCombo(ev({ code: "KeyA", key: "a", metaKey: true, shiftKey: true }))).toBe("mod+shift+a");
  });
  it("maps punctuation + arrows from code, not the shifted character", () => {
    expect(eventToCombo(ev({ code: "Comma", key: "," }))).toBe(",");
    expect(eventToCombo(ev({ code: "Comma", key: "<", shiftKey: true }))).toBe("shift+,");
    expect(eventToCombo(ev({ code: "ArrowLeft", key: "ArrowLeft", shiftKey: true }))).toBe("shift+left");
    expect(eventToCombo(ev({ code: "Space", key: " " }))).toBe("space");
    expect(eventToCombo(ev({ code: "Backslash", key: "\\", metaKey: true }))).toBe("mod+\\");
  });
  it("returns null for modifier-only presses", () => {
    expect(eventToCombo(ev({ code: "ShiftLeft", key: "Shift", shiftKey: true }))).toBeNull();
    expect(eventToCombo(ev({ code: "MetaLeft", key: "Meta", metaKey: true }))).toBeNull();
  });
});

describe("formatCombo", () => {
  it("renders mac symbols", () => {
    expect(formatCombo("mod+k")).toBe("⌘K");
    expect(formatCombo("mod+shift+a")).toBe("⌘⇧A");
    expect(formatCombo("alt+e")).toBe("⌥E");
    expect(formatCombo("shift+left")).toBe("⇧←");
    expect(formatCombo("space")).toBe("Space");
    expect(formatCombo(",")).toBe(",");
  });
  it("formatBindings joins multiples and dashes when empty", () => {
    expect(formatBindings(["space", "k"])).toBe("Space / K");
    expect(formatBindings([])).toBe("—");
  });
});

describe("override resolution", () => {
  it("bindingsFor falls back to defaults when no override", () => {
    expect(bindingsFor("play.toggle", {})).toEqual(["space", "k"]);
    expect(bindingsFor("play.toggle", { "play.toggle": ["p"] })).toEqual(["p"]);
  });
  it("buildComboMap maps every default combo to its action", () => {
    const m = buildComboMap({});
    expect(m.get("space")).toBe("play.toggle");
    expect(m.get("k")).toBe("play.toggle");
    expect(m.get("i")).toBe("mark.in");
    expect(m.get("mod+k")).toBe("app.palette");
    expect(m.get("shift+left")).toBe("play.secondBack");
  });
  it("every action's defaults are unique (no collisions out of the box)", () => {
    const seen = new Map<string, string>();
    for (const a of KEY_ACTIONS) {
      for (const c of a.defaults) {
        expect(seen.has(c)).toBe(false);
        seen.set(c, a.id);
      }
    }
  });
});

describe("assignBinding", () => {
  it("sets a single override and steals from the previous owner", () => {
    const { next, stolenFrom } = assignBinding({}, "mark.in", "j"); // j was play.back5
    expect(next["mark.in"]).toEqual(["j"]);
    expect(stolenFrom).toBe("play.back5");
    // play.back5 keeps its non-stolen defaults (it only had "j" → now [])
    expect(bindingsFor("play.back5", next)).toEqual([]);
    // the combo now resolves to exactly one action
    expect(buildComboMap(next).get("j")).toBe("mark.in");
  });
  it("no steal when the combo is unused", () => {
    const { next, stolenFrom } = assignBinding({}, "mark.in", "p");
    expect(stolenFrom).toBeNull();
    expect(next["mark.in"]).toEqual(["p"]);
  });
  it("resetBinding restores defaults", () => {
    const o: KeybindingOverrides = { "mark.in": ["p"] };
    expect(resetBinding(o, "mark.in")["mark.in"]).toBeUndefined();
    expect(bindingsFor("mark.in", resetBinding(o, "mark.in"))).toEqual(["i"]);
  });
});
