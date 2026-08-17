import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * A time-domain analyser buffer is sized `fftSize`, never `frequencyBinCount`.
 *
 * `getByteTimeDomainData(array)` fills `fftSize` samples and DROPS the excess
 * when the array is shorter. `frequencyBinCount` is `fftSize / 2` — the right
 * size for `getByteFrequencyData`, and exactly half of what the time-domain
 * call needs. The two names sit next to each other on the same object, so the
 * wrong one is an easy reach and produces no error at all: the call succeeds,
 * the array fills, and you silently see the first half of every window.
 *
 * Both analyser sites in this app had it. `level-meter.ts` drives the mic
 * meter in Settings and the green room; `PeoplePanel.tsx` drives the speaking
 * ring in a live session. Each scanned 128 of every 256 samples for its peak,
 * so a transient in the back half of a window never reached the scan and both
 * under-read — quietly, in the direction that says "you are not clipping".
 *
 * Neither call site is unit-testable: both need a real AudioContext, a live
 * MediaStream and a frame loop, so a test would assert that mocks were called.
 * This checks the pairing in the source instead, which is where the mistake
 * lives and where a new analyser would repeat it.
 */

const ROOT = resolve(__dirname, "../..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(relative(ROOT, full));
  }
  return out;
}

/** Files that read time-domain data from an AnalyserNode. */
const timeDomainSites = sourceFiles(resolve(ROOT, "src")).filter((f) =>
  readFileSync(resolve(ROOT, f), "utf8").includes("getByteTimeDomainData("),
);

describe("analyser time-domain buffers", () => {
  it("exist to be checked", () => {
    // Canary. Two sites today; a rename of the API would empty this list and
    // make the assertion below pass while guarding nothing.
    expect(timeDomainSites.length, "no getByteTimeDomainData call sites found").toBeGreaterThan(1);
  });

  it("are sized with fftSize, not frequencyBinCount", () => {
    const bad: string[] = [];
    for (const f of timeDomainSites) {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      for (const line of src.split("\n")) {
        // Only the array construction matters; prose mentioning the wrong name
        // (including this file's own explanation, and the comments left at both
        // sites) must not trip it.
        const trimmed = line.trimStart();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        if (/new\s+Uint8Array\s*\(\s*\w+\.frequencyBinCount\s*\)/.test(line)) {
          bad.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(bad, "time-domain buffer sized at half the window").toEqual([]);
  });

  it("do size one with fftSize somewhere, so the check is not vacuous", () => {
    // The positive half: it is not enough that the wrong pattern is absent —
    // the right one has to be present, or a site that stopped allocating a
    // buffer entirely would look clean.
    const sized = timeDomainSites.filter((f) =>
      /new\s+Uint8Array\s*\(\s*\w+\.fftSize\s*\)/.test(readFileSync(resolve(ROOT, f), "utf8")),
    );
    expect(sized, "no site allocates a full-window buffer").toEqual(timeDomainSites);
  });
});
