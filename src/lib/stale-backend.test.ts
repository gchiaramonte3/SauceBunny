import { describe, expect, it } from "vitest";
import { isMissingCommandError, staleBinaryMessage } from "./stale-backend";

/**
 * The detector matches a message AFTER formatError has been through it, and
 * formatError's string path runs humanizeSpawnError, which replaces messages
 * wholesale when it recognises them. It does not recognise this one, so the
 * text survives - but that is incidental rather than designed, and a new
 * humanizer rule that happened to match would turn this detector off silently.
 * The failure would be invisible: no crash, no test going red, just a developer
 * reading a raw error during the one workflow this exists to smooth.
 *
 * These tests pin the seam between the two, not the regex on its own.
 */
describe("isMissingCommandError", () => {
  it("recognises the message a stale dev server actually produces", () => {
    expect(isMissingCommandError("Command prepare_local_for_playback not found")).toBe(true);
    expect(isMissingCommandError("command extract_frame not found")).toBe(true);
  });

  it("finds it wherever the message is wrapped", () => {
    // Which error path produced it is not something a call site knows.
    expect(isMissingCommandError("invoke error: Command foo not found (rejected)")).toBe(true);
  });

  it("gives the same answer for a String error and an AppError carrying it", () => {
    // The claim the original comment made and nothing checked: after the r51
    // sweep some commands reject with a typed AppError and some still reject
    // with a bare string, and a call site cannot tell which. Both must resolve
    // to the same answer or the hint appears for some commands and not others.
    const text = "Command get_backend_build_id not found";
    expect(isMissingCommandError(text)).toBe(true);
    expect(isMissingCommandError({ kind: "Invalid", data: text })).toBe(true);
    expect(isMissingCommandError({ kind: "Internal", data: text })).toBe(true);
  });

  it("survives the humanizer, which rewrites messages it recognises", () => {
    // humanizeSpawnError replaces the WHOLE message when it sees a permission
    // failure. If a future rule ever matched this text too, the detector would
    // stop firing and this is the test that says so.
    expect(isMissingCommandError("Command whatever not found")).toBe(true);
    // And the shape it DOES rewrite must not be mistaken for a stale binary.
    expect(isMissingCommandError("ffmpeg: Permission denied (os error 13)")).toBe(false);
  });

  it("does not mistake an ordinary failure for a stale backend", () => {
    // A false positive is worse than a miss here: it tells someone to restart
    // their dev server while the real problem goes unmentioned.
    expect(isMissingCommandError("Not found: /Users/x/clip.mov")).toBe(false);
    expect(isMissingCommandError("Network error: timed out")).toBe(false);
    expect(isMissingCommandError({ kind: "Cancelled" })).toBe(false);
    expect(isMissingCommandError({ kind: "NotFound", data: "a file" })).toBe(false);
    expect(isMissingCommandError("could not find the command line tool")).toBe(false);
  });

  it("does not throw on whatever it is handed", () => {
    // It runs inside catch blocks, so a throw here would replace a legible
    // error with an illegible one.
    for (const junk of [null, undefined, 0, [], {}, new Error("boom"), () => {}]) {
      expect(() => isMissingCommandError(junk)).not.toThrow();
    }
    expect(isMissingCommandError(new Error("Command foo not found"))).toBe(true);
  });
});

describe("staleBinaryMessage", () => {
  it("names the command and the exact thing to go and do", () => {
    const msg = staleBinaryMessage("extract_frame");
    expect(msg).toContain("extract_frame");
    expect(msg).toContain("npm run tauri dev");
  });

  it("uses no em dash, per the house voice rule", () => {
    expect(staleBinaryMessage("x")).not.toContain("—");
  });
});
