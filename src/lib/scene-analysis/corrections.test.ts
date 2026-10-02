import { describe, expect, it } from "vitest";
import { correctedRow, editedCorrection, emptyCorrection, rowAnchor } from "./corrections";
import { secondsToFrames } from "../timecode";

const row = Object.freeze({ id: 1, start_us: 0, end_us: 2_000_000, picture: "Model description", dialogue: "Model words", summary: "Model summary" });
describe("analysis corrections", () => {
  it("preserves intentional empty text without changing model evidence", () => {
    const edit = editedCorrection(row, emptyCorrection(), "picture", "", 24, 10e6);
    expect(correctedRow(row, edit).picture).toBe("");
    expect(row.picture).toBe("Model description");
    expect(correctedRow(row, editedCorrection(row, edit, "picture", null, 24, 10e6)).picture).toBe(row.picture);
  });
  it("allows Unicode labels, dialogue and summaries independently", () => {
    let edit = emptyCorrection();
    for (const field of ["label", "picture", "dialogue", "summary"] as const) edit = editedCorrection(row, edit, field, `東京 é ${field}`, 24, 10e6);
    expect(correctedRow(row, edit)).toMatchObject({ label: "東京 é label", dialogue: "東京 é dialogue", summary: "東京 é summary" });
    expect(rowAnchor(row)).toBe("0:2000000");
  });
  it.each([24, 24000 / 1001, 25, 30000 / 1001, 60000 / 1001])("uses frames at %s fps and links duration to end", fps => {
    const start = editedCorrection(row, emptyCorrection(), "start_us", "1", fps, 10e6);
    expect(secondsToFrames(start.start_us! / 1e6, fps)).toBe(1);
    const duration = editedCorrection(row, start, "duration", "00:00:01:00", fps, 10e6);
    expect(secondsToFrames(duration.end_us! / 1e6, fps)).toBe(1 + Math.round(fps));
    expect(start.end_us).toBeNull();
  });
  it.each(["00:00:00:24", "00:60:00:00", "1.5", "hello", "", "00:00:11:00"])("rejects invalid/out-of-source timecode %s", value => {
    expect(() => editedCorrection(row, emptyCorrection(), "end_us", value, 24, 10e6)).toThrow();
  });
  it("rejects inverted/zero-length ranges and does not clamp bad input", () => {
    expect(() => editedCorrection(row, emptyCorrection(), "start_us", "00:00:03:00", 24, 10e6)).toThrow(/End/);
    expect(() => editedCorrection(row, emptyCorrection(), "duration", "0", 24, 10e6)).toThrow(/one frame/);
    expect(() => editedCorrection(row, emptyCorrection(), "label", " ", 24, 10e6)).toThrow();
  });
  it("reset duration restores both original boundaries", () => {
    const edit = { ...emptyCorrection(), start_us: 1e6, end_us: 4e6, picture: "User description" };
    expect(editedCorrection(row, edit, "duration", null, 24, 10e6)).toEqual({ ...edit, start_us: null, end_us: null });
  });
});
