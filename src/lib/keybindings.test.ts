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
  isPlaybackScoped,
  VIEWS_WITH_A_PLAYER,
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

describe("the view gate on transport and marking", () => {
  it("covers every key that drives the Clip player", () => {
    // The bug: the Clip view stays mounted behind Home and the Library, so
    // these all kept firing from a screen where the player is invisible.
    // Space started playback nobody could see and i/o/g/q/w moved the export
    // marks on a different file than the one under the cursor.
    for (const id of [
      "play.toggle", "play.back5", "play.fwd5", "play.frameBack", "play.frameFwd",
      "play.secondBack", "play.secondFwd", "play.toStart", "play.toEnd",
      "play.rateDown", "play.rateUp", "play.rateReset",
      "mark.in", "mark.out", "mark.clear", "mark.gotoIn", "mark.gotoOut",
      "review.rangeIn", "review.rangeOut",
    ] as const) {
      expect(isPlaybackScoped(id)).toBe(true);
    }
  });

  it("leaves navigation and app-level actions alone", () => {
    // Gating these would break the app: you must be able to switch views,
    // open settings and undo from anywhere.
    for (const id of [
      "view.home", "view.library", "view.clip", "app.palette", "app.settings",
      "app.shortcuts", "edit.undo", "edit.redo", "src.fetch", "queue.add",
    ] as const) {
      expect(isPlaybackScoped(id)).toBe(false);
    }
  });

  it("allows exactly the views that show a player", () => {
    expect(VIEWS_WITH_A_PLAYER.has("clip")).toBe(true);
    expect(VIEWS_WITH_A_PLAYER.has("coreview")).toBe(true);
    // The reader owns a second player and the dispatcher routes to it.
    expect(VIEWS_WITH_A_PLAYER.has("reader")).toBe(true);
    // The two that caused the bug.
    expect(VIEWS_WITH_A_PLAYER.has("home")).toBe(false);
    expect(VIEWS_WITH_A_PLAYER.has("library")).toBe(false);
  });

  it("classifies every registry action, so a new one cannot slip the gate", () => {
    // If someone adds a Transport action tomorrow it is gated automatically,
    // because the classification reads the group rather than a hand-kept list.
    for (const a of KEY_ACTIONS) {
      const scoped = isPlaybackScoped(a.id);
      expect(scoped).toBe(a.group === "Transport" || a.group === "Marking");
    }
  });
});
