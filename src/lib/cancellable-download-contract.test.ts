import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A long download holds its job id, so Cancel has something to cancel.
 *
 * `download_parakeet_model` registers its child in the JobRegistry and its own
 * comment has always said "cancellable via the JobRegistry". The renderer
 * minted a job id and then dropped it on the floor, so nothing could reach
 * that child: a half-gigabyte download had no Cancel, and the model row sat on
 * "Downloading…" until it finished or the app was quit.
 *
 * It was worse than a missing button, because the download reports NO
 * progress. FluidAudio's `AsrModels.download` is one awaited call with no
 * callback, so quiet and stuck look identical, and Rust was discarding the
 * sidecar's stdout as well - the two status lines it does emit reached
 * nobody. A user watching a spinner for ten minutes has no way to tell which
 * of those they are looking at.
 *
 * This pins the half that is checkable in source: the id is held, and the
 * cancel path exists.
 */
const SETTINGS = resolve(__dirname, "../components/SettingsModal.tsx");
const RUST = resolve(__dirname, "../../src-tauri/src/commands/transcript.rs");

function lines(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

describe("the model download can be stopped", () => {
  const ui = lines(readFileSync(SETTINGS, "utf8"));
  const rs = lines(readFileSync(RUST, "utf8"));

  it("reads both sides, so the rules below cannot pass vacuously", () => {
    expect(ui, "the download call is gone — re-derive this contract")
      .toContain("download_parakeet_model");
    expect(rs).toContain("pub async fn download_parakeet_model");
  });

  it("keeps the job id instead of dropping it", () => {
    // Minted and discarded is the whole bug: the handle never left the
    // function that made it.
    expect(
      ui,
      "the Parakeet download's job id is not held anywhere, so nothing can cancel it",
    ).toContain("parakeetJobRef");
  });

  it("offers a cancel that reaches the running job", () => {
    expect(ui, "no cancel path for the model download").toMatch(/cancel_job/);
  });

  it("does not report a cancelled download as a failure", () => {
    // Cancel kills the child, which arrives as a signal rather than a clean
    // exit. Reporting that as SidecarFailed would put an error in front of
    // somebody for doing exactly what the button offered.
    const fn = rs.slice(rs.indexOf("pub async fn download_parakeet_model"));
    const body = fn.slice(0, fn.indexOf("\npub ") > 0 ? fn.indexOf("\npub ") : undefined);
    expect(body.length, "could not isolate the download fn").toBeGreaterThan(400);
    expect(body, "a killed download still reports as a sidecar failure")
      .toContain("payload.signal");
  });
});
