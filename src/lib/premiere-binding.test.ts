import { describe, expect, it } from "vitest";
import { isPremiereBinding, samePremiereBinding } from "./premiere-binding";
import { isPremiereContext } from "./premiere-notes";
import { parseReply } from "../../premiere-companion/src/protocol";
import type { PremiereBinding } from "../bindings/PremiereBinding";

const binding: PremiereBinding = { bindingId: "bound", projectId: "project", sequenceId: "sequence",
  projectName: "Project", sequenceName: "Sequence", timebaseTicks: "10584000000", displayFormat: "102", zeroPointTicks: "0" };
const appAccepts = (binding: unknown) => isPremiereContext({ t: "premiere-context", protocol: 1, sessionId: "room",
  reviewKey: "ndi:pass", sourceId: "ndi:pass", programId: "a".repeat(32), presenterEpoch: 0, revision: 1, binding });
const companionAccepts = (binding: unknown) => {
  try {
    parseReply(JSON.stringify({ v: 1, id: "1", type: "snapshot", notes: [], page: { offset: 0, total: 0, hasMore: false },
      status: { phase: "connected", binding, syncEnabled: true, automaticPlacement: false, pendingCount: 0,
        otherBindingPendingCount: 0, ledgerRevision: 0, error: null } }));
    return true;
  } catch { return false; }
};
describe("shared app and companion binding contract", () => {
  it("accepts normal bindings and rejects malformed identities", () => {
    const validate = isPremiereBinding;
    expect(validate(binding)).toBe(true);
    expect(validate({ ...binding, zeroPointTicks: "-914457600000000" })).toBe(true);
    for (const bad of [null, [], {}, { ...binding, projectId: "" }, { ...binding, sequenceId: 42 },
      { ...binding, timebaseTicks: "0" }, { ...binding, timebaseTicks: "-1" }, { ...binding, timebaseTicks: "1e3" },
      { ...binding, zeroPointTicks: "1.5" }]) expect(validate(bad)).toBe(false);
  });
  it("uses the same six identity fields and ignores display-name changes", () => {
    expect(samePremiereBinding(null, binding)).toBe(false);
    expect(samePremiereBinding(binding, null)).toBe(false);
    expect(samePremiereBinding(binding, { ...binding, projectName: "Renamed", sequenceName: "New title" })).toBe(true);
    for (const field of ["bindingId", "projectId", "sequenceId", "timebaseTicks", "displayFormat", "zeroPointTicks"] as const) {
      expect(samePremiereBinding(binding, { ...binding, [field]: "changed" })).toBe(false);
    }
  });
  it("uses the intersection of the old rules at both wire boundaries, never wider permissions", () => {
    expect([appAccepts(binding), companionAccepts(binding)]).toEqual([true, true]);
    const zeroPadded = { ...binding, timebaseTicks: "010584000000" };
    expect([appAccepts(zeroPadded), companionAccepts(zeroPadded)]).toEqual([false, false]);
    for (const oversized of [{ ...binding, sequenceName: "x".repeat(513) }, { ...binding, projectId: "x".repeat(513) },
      { ...binding, displayFormat: "x".repeat(129) }, { ...binding, timebaseTicks: "9".repeat(25) },
      { ...binding, zeroPointTicks: "9".repeat(25) }]) {
      expect([appAccepts(oversized), companionAccepts(oversized)]).toEqual([false, false]);
    }
  });
});
