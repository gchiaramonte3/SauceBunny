import { describe, expect, it } from "vitest";
import { plural } from "./plural";

describe("plural", () => {
  it("agrees with the count, including none", () => {
    expect(plural(1, "person", "people")).toBe("1 person");
    expect(plural(0, "person", "people")).toBe("0 people");
    expect(plural(2, "track", "tracks")).toBe("2 tracks");
    expect(plural(20922, "word", "words")).toBe("20,922 words");
  });
});
