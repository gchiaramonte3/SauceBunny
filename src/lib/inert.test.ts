import { describe, expect, it } from "vitest";
import { inertWhen } from "./inert";

describe("inertWhen", () => {
  it("marks a collapsed panel inert", () => {
    expect(inertWhen(true)).toEqual({ inert: "" });
  });

  it("OMITS the attribute when active, rather than setting it falsey", () => {
    // The whole reason this is a function. `inert` is presence-based like
    // `disabled`: inert="false" is still inert. Returning { inert: "false" }
    // for an open panel would freeze it permanently — unfocusable, unclickable,
    // invisible to a screen reader — while looking perfectly correct in the
    // JSX. An empty object is the only safe "not inert".
    const props = inertWhen(false);
    expect(props).toEqual({});
    expect("inert" in props).toBe(false);
  });

  it("never yields a falsey-looking inert value", () => {
    // Guards the failure mode directly: whatever this returns, if the key is
    // present at all the panel IS inert, so the key must never appear with a
    // value someone would read as "off".
    for (const inactive of [true, false]) {
      const props = inertWhen(inactive) as Record<string, unknown>;
      if ("inert" in props) {
        expect(props.inert).toBe("");
        expect(props.inert).not.toBe("false");
        expect(props.inert).not.toBe(false);
      }
    }
  });
});
