import { describe, expect, it } from "vitest";
import type { ObsSelection } from "../bindings/ObsSelection";
import { captureSourceIdentity, copyCaptureSelection, isDisplayCapture, sameProgramSource, validCaptureSelection } from "./ndi-program-source";

const selection: ObsSelection = { application: "com.generated.editor", process: 42, window: 99,
  crop: { x: 0, y: 0, width: 1, height: 1 } };
const source = (value: ObsSelection) => ({ kind: "capture" as const, selection: value });
describe("capture audio policy", () => {
  it("preserves legacy audio while requiring a fresh capture for an explicit policy change", () => {
    expect(sameProgramSource(source(selection), source({ ...selection, audio: true }))).toBe(true);
    expect(sameProgramSource(source(selection), source({ ...selection, audio: false }))).toBe(false);
    expect(sameProgramSource(source({ ...selection, audio: false }), source({ ...selection, audio: false }))).toBe(true);
  });
  it("keeps the same review pass and an independent draft when changing audio", () => {
    const next = copyCaptureSelection({ ...selection, audio: false });
    expect(next.audio).toBe(false); expect(next.crop).not.toBe(selection.crop);
    expect(captureSourceIdentity(next)).toBe(captureSourceIdentity(selection));
    expect(validCaptureSelection(next)).toBe(true);
    expect(validCaptureSelection({ ...selection, audio: "false" } as unknown as ObsSelection)).toBe(false);
  });
});

const display = (): Extract<ObsSelection, { kind: "display" }> => ({
  kind: "display", displayUuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", displayId: 7,
  geometry: { x: -1920, y: 0, width: 1920, height: 1080, pixelWidth: 3840, pixelHeight: 2160 },
  crop: { x: .25, y: .25, width: .5, height: .5 }, audio: false,
});

describe("exact display capture identity", () => {
  it.each([
    { x: .03546611, y: .23030471, width: .20652741, height: .37924018 },
    { x: 0, y: .20452178, width: .2402288, height: .32388176 },
  ])("accepts the reported fractional Region selection without mutating its stored identity %#", crop => {
    const requested = { ...display(), displayId: 5,
      geometry: { x: 0, y: 0, width: 3008, height: 1269, pixelWidth: 6016, pixelHeight: 2538 }, crop };
    const before = JSON.stringify(requested);
    expect(validCaptureSelection(requested)).toBe(true);
    expect(sameProgramSource(source(requested), source(copyCaptureSelection(requested)))).toBe(true);
    expect(JSON.stringify(requested)).toBe(before);
  });
  it.each([
    [{ x: .03546611, y: .23030471000299998, width: .20652741000299998, height: .37924018000099996 },
      { x: .03546611, y: .230304710003, width: .206527410003, height: .379240180001 }],
    [{ x: 0, y: .20452178000299998, width: .24022880000299998, height: .32388176 },
      { x: 0, y: .204521780003, width: .240228800003, height: .32388176 }],
  ])("recognizes the same accepted backing-pixel crop after native JSON rounding %#", (crop, returnedCrop) => {
    // Full-precision pointer coordinates display the reported eight-decimal
    // normalized crops. These return values reproduce serde_json's f64 parse.
    const requested = { ...display(), displayId: 5,
      geometry: { x: 0, y: 0, width: 3008, height: 1269, pixelWidth: 6016, pixelHeight: 2538 }, crop };
    const returned = { ...requested, crop: returnedCrop };
    expect(captureSourceIdentity(requested)).not.toBe(captureSourceIdentity(returned));
    expect(sameProgramSource(source(requested), source(returned))).toBe(true);
  });
  it.each(["x", "y", "width", "height"] as const)("rejects even floating-point drift across an accepted pixel boundary: %s", key => {
    const requested = { ...display(), displayId: 5,
      geometry: { x: 0, y: 0, width: 3008, height: 1269, pixelWidth: 6016, pixelHeight: 2538 },
      crop: { x: 0, y: 0, width: .5, height: .5 } };
    const returned = { ...requested, crop: { ...requested.crop } };
    returned.crop[key] += key === "x" || key === "y" ? Number.EPSILON : -Number.EPSILON;
    expect(sameProgramSource(source(requested), source(returned))).toBe(false);
  });
  it("does not merge fractional window crops or malformed capture responses", () => {
    const requested = { ...selection, crop: { x: .1, y: .23030471000299998, width: .5, height: .5 } };
    const returned = { ...requested, crop: { ...requested.crop, y: .230304710003 } };
    expect(sameProgramSource(source(requested), source(returned))).toBe(false);
    const malformed = { ...display(), crop: { x: NaN, y: 0, width: .5, height: .5 } };
    expect(sameProgramSource(source(malformed), source(malformed))).toBe(false);
  });
  it("keeps the existing window review key stable and distinguishes display sources", () => {
    expect(captureSourceIdentity(selection)).toBe('["com.generated.editor",42,99,0,0,1,1]');
    expect(validCaptureSelection(display())).toBe(true);
    expect(isDisplayCapture(display())).toBe(true);
    expect(isDisplayCapture(selection)).toBe(false);
    expect(sameProgramSource(source(display()), source(selection))).toBe(false);
    expect(sameProgramSource(source(display()), source(display()))).toBe(true);
  });
  it("copies consent geometry and crop independently before asynchronous work", () => {
    const original = display(), copied = copyCaptureSelection(original);
    expect(isDisplayCapture(copied)).toBe(true);
    if (!isDisplayCapture(copied)) throw new Error("Expected a display draft");
    original.geometry.x = 999; original.crop.x = 0;
    expect(copied.geometry.x).toBe(-1920); expect(copied.crop.x).toBe(.25);
  });
  it.each(["x", "y", "width", "height", "pixelWidth", "pixelHeight"] as const)("invalidates changed display geometry: %s", key => {
    const next = display(); next.geometry[key] += 1;
    expect(sameProgramSource(source(display()), source(next))).toBe(false);
  });
  it.each(["x", "y", "width", "height"] as const)("invalidates changed region: %s", key => {
    const next = display(); next.crop[key] += .01;
    expect(sameProgramSource(source(display()), source(next))).toBe(false);
  });
  it("does not substitute a display with the same numeric ID or reuse a changed audio source", () => {
    const next = display(); next.displayUuid = "BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
    expect(sameProgramSource(source(display()), source(next))).toBe(false);
    next.displayUuid = display().displayUuid; next.displayId++;
    expect(sameProgramSource(source(display()), source(next))).toBe(false);
    const audio = { ...display(), audio: true };
    expect(sameProgramSource(source(display()), source(audio))).toBe(false);
    expect(captureSourceIdentity(display())).toBe(captureSourceIdentity(audio));
  });
  it.each([
    { displayUuid: "main" }, { displayId: 0 }, { displayId: 1.5 }, { displayId: 0x100000000 },
    { audio: undefined }, { audio: "false" }, { geometry: undefined },
    { kind: "window" }, { application: "com.other.app", process: 42, window: 99 },
  ])("refuses invalid or ambiguous display identity %#", patch => {
    expect(validCaptureSelection({ ...display(), ...patch } as unknown as ObsSelection)).toBe(false);
  });
  it.each([
    { x: NaN }, { y: Infinity }, { width: 0 }, { height: -1 }, { pixelWidth: 1.5 }, { pixelHeight: 0 },
  ])("refuses malformed display geometry %#", patch => {
    const next = display(); Object.assign(next.geometry, patch);
    expect(validCaptureSelection(next)).toBe(false);
  });
  it("cannot reinterpret a malformed display as a window", () => {
    expect(validCaptureSelection({ ...selection, kind: "display" } as unknown as ObsSelection)).toBe(false);
    expect(validCaptureSelection({ ...selection, displayId: 7 } as unknown as ObsSelection)).toBe(false);
  });
});
