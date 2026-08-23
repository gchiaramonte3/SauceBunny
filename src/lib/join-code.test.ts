import { describe, expect, it } from "vitest";
import { shortJoinCode } from "./join-code";

const FULL = "SAUC-AC2HW-EHJKM-JUI74-IA4RI-TLVN5-TJ5RT-WENWO-CWB7O-A7L3S-AJQYM-WUUAA";

describe("shortJoinCode", () => {
  it("cuts on a group boundary, never mid-group", () => {
    // The defect: a character cut gave `…-JUI74-IA4…`, and that stray "IA4"
    // reads as a typo rather than as a code with more to it.
    const short = shortJoinCode(FULL);
    expect(short).toBe("SAUC-AC2HW-EHJKM-JUI74-IA4RI…");
    for (const g of short.replace("…", "").split("-").slice(1)) {
      expect(g).toHaveLength(5);
    }
  });

  it("keeps the handle, which is what says whose code this is", () => {
    expect(shortJoinCode(FULL).startsWith("SAUC-")).toBe(true);
  });

  it("returns a short code untouched, with no ellipsis", () => {
    // Nothing was hidden, so promising more is a lie the user can check.
    expect(shortJoinCode("SAUC-AC2HW-EHJKM")).toBe("SAUC-AC2HW-EHJKM");
    expect(shortJoinCode("SAUC-AC2HW-EHJKM-JUI74-IA4RI")).toBe("SAUC-AC2HW-EHJKM-JUI74-IA4RI");
  });

  it("honours a caller that wants fewer groups", () => {
    expect(shortJoinCode(FULL, 2)).toBe("SAUC-AC2HW-EHJKM…");
  });

  it("does not crash on an empty or dashless code", () => {
    // session.code is null until the host actually starts, and a legacy raw
    // ticket has no dashes at all.
    expect(shortJoinCode("")).toBe("");
    expect(shortJoinCode("endpointac2hwehjkm")).toBe("endpointac2hwehjkm");
  });
});
