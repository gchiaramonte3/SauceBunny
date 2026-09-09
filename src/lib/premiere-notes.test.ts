import { describe, expect, it } from "vitest";
import { capturePremiereAnchor, isPremiereAnchor, isPremiereBinding, isPremiereContext, premiereRequests, samePremiereBinding } from "./premiere-notes";
import { buildComment, emptyDoc, sanitizeDocForWire } from "./review";
import { isReviewOp } from "./review-delivery";
import type { PremiereBinding } from "../bindings/PremiereBinding";

const binding: PremiereBinding = { bindingId: "binding-A", projectId: "project-A", sequenceId: "sequence-A",
  projectName: "Project", sequenceName: "Sequence", timebaseTicks: "10594584000", displayFormat: "102", zeroPointTicks: "914457600000000" };
describe("Premiere note boundary", () => {
  it("copies the note-start binding and displayed frame without inventing sequence time", () => {
    const original = { ...binding };
    const frame = { streamId: "stream-1", frameId: "decoder1:240", mediaSeconds: 8, displayedAt: 100 };
    const anchor = capturePremiereAnchor(original, "ndi:pass", frame, 120);
    original.sequenceId = "sequence-B"; frame.mediaSeconds = 40;
    expect(anchor.binding.sequenceId).toBe("sequence-A");
    expect(anchor.mediaSeconds).toBe(8);
    expect(anchor).toMatchObject({ capturedAt: 120, verification: "unverified", frameId: "decoder1:240" });
    expect(anchor.sequenceTicks).toBeUndefined();
    expect(anchor.binding.zeroPointTicks).toBe("914457600000000");
  });
  it("holds a note without a frame instead of borrowing an underlying file clock", () => {
    const anchor = capturePremiereAnchor(binding, "ndi:pass", null);
    expect(anchor.verification).toBe("unverified");
    expect(anchor.mediaSeconds).toBeUndefined();
    expect(anchor.reason).toContain("No confirmed displayed");
  });
  it("binds by immutable identity and clock, never display name alone", () => {
    expect(samePremiereBinding(binding, { ...binding, sequenceName: "Renamed" })).toBe(true);
    for (const key of ["bindingId", "projectId", "sequenceId", "timebaseTicks", "zeroPointTicks", "displayFormat"] as const)
      expect(samePremiereBinding(binding, { ...binding, [key]: "different" })).toBe(false);
  });
  it("validates tick strings without number conversion or trusting malformed metadata", () => {
    expect(isPremiereBinding(binding)).toBe(true);
    for (const bad of [0, "0", "NaN", "1e8", "-10", "9".repeat(25)])
      expect(isPremiereBinding({ ...binding, timebaseTicks: bad })).toBe(false);
    const anchor = capturePremiereAnchor(binding, "ndi:pass", null);
    expect(isPremiereAnchor({ ...anchor, mediaSeconds: Infinity })).toBe(false);
    expect(isPremiereAnchor({ ...anchor, verification: "estimated" })).toBe(false);
    expect(isPremiereContext({ t: "premiere-context", protocol: 1, sessionId: "room", reviewKey: "ndi:pass", sourceId: "ndi:pass", binding })).toBe(true);
  });
  it("does not turn general notes, manual timecodes, file notes or replies into markers", () => {
    const doc = emptyDoc("ndi:pass");
    const general = buildComment({ versionId: "v", timeStart: 0, body: "General note", author: "Guest" });
    general.timing = { kind: "general", sourceId: "ndi:pass", pass: "Pass 1" };
    const marker = { ...general, id: "marker", premiere: capturePremiereAnchor(binding, "ndi:pass", null) };
    doc.comments = [general, { ...general, timing: { ...general.timing, kind: "manual", timecode: "01:00:00:12" } },
      { ...marker, id: "reply", parentId: "marker" }, { ...marker, id: "file", timing: undefined }, marker];
    expect(premiereRequests(doc).map(request => request.commentId)).toEqual(["marker"]);
    expect(isReviewOp({ t: "add", comment: marker })).toBe(true);
    expect(isReviewOp({ t: "add", comment: { ...marker, premiere: { ...marker.premiere, sourceId: "other" } } })).toBe(false);
  });
  it("keeps local anchors intact while withholding sequence details from room snapshots", () => {
    const doc = emptyDoc("ndi:pass");
    const anchor = capturePremiereAnchor(binding, "ndi:pass", null);
    const comment = buildComment({ versionId: "v", timeStart: 0, body: "Saved note", author: "Editor" });
    doc.comments = [{ ...comment, premiere: anchor }];
    const wire = sanitizeDocForWire(doc, "ndi:pass");
    expect(wire.comments[0].premiere).toBeUndefined();
    expect(wire.comments[0].body).toBe("Saved note");
    expect(doc.comments[0].premiere).toBe(anchor);
    expect(JSON.stringify(wire)).not.toContain(binding.projectId);
    expect(JSON.stringify(wire)).not.toContain(binding.sequenceId);
  });
});
