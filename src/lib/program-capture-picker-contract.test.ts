import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The Preview capture helper chooses only through macOS's sharing picker.
 *
 * That is the whole point of it (docs/PROGRAM-CAPTURE.md): a pick from
 * SCContentSharingPicker needs no Screen Recording permission and never
 * raises macOS 15/26's monthly "is requesting to bypass the system private
 * window picker" alert. One call to the APIs below brings both back for every
 * person who downloads the app, and nothing would fail: capture keeps working,
 * it just asks for more than it needs and nags monthly. OBS lives with that
 * alert because it enumerates content itself; this guard keeps us from
 * drifting into the same shape one convenient call at a time.
 */

const ROOT = resolve(__dirname, "../..");
const HELPER = resolve(ROOT, "swift-sidecar/Sources/saucebunny-program-capture");
const FORBIDDEN = [
  "SCShareableContent", "SCScreenshotManager", "CGPreflightScreenCaptureAccess", "CGRequestScreenCaptureAccess",
  "CGWindowListCreateImage", "CGDisplayCreateImage", "CGDisplayStream", "CGWindowListCopyWindowInfo",
];

/** Source with comments removed, so a sentence explaining the rule cannot trip it. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the capture helper chooses through macOS's picker only", () => {
  const files = readdirSync(HELPER).filter(name => name.endsWith(".swift")).map(name => join(HELPER, name));

  it("scans the helper and finds the picker in it", () => {
    expect(files.length, "no helper sources found").toBeGreaterThan(3);
    expect(files.some(file => /SCContentSharingPicker\.shared/.test(code(readFileSync(file, "utf8")))),
      "the helper no longer uses SCContentSharingPicker: the scan is looking at the wrong files").toBe(true);
  });

  it("never enumerates or snapshots the screen itself", () => {
    const offenders = files.flatMap(file => FORBIDDEN.filter(api => new RegExp(`\\b${api}\\b`).test(code(readFileSync(file, "utf8"))))
      .map(api => `${file.slice(ROOT.length + 1)}: ${api}`));
    expect(offenders, "These calls need Screen Recording permission and bring back macOS's monthly "
      + "'bypass the system private window picker' alert. Get the content from the picker's filter instead.").toEqual([]);
  });
});
