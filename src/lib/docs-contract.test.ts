import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * The local gate and the CI gate are the same set.
 *
 * README, CONTRIBUTING and CLAUDE.md all now tell a contributor that
 * `npm run verify` is "every check CI runs". That sentence is only worth
 * printing if something enforces it, because the failure is silent and
 * expensive: the contributor passes locally, opens a PR, and CI rejects it
 * for a check their own docs never mentioned.
 *
 * It has drifted twice already. `cargo clippy -D warnings` ran in CI and not
 * locally for 98 commits, and `npm run check:licenses` was missing from the
 * local script until an open-source documentation audit went looking for it.
 * Both were found by reading, not by failing, which is the argument for this
 * test.
 *
 * The mapping is written out rather than derived. CI expresses a step as a
 * shell line in YAML and the script expresses it as a `run` label, and no
 * regex relates `npx vitest run` to `npm test --silent` without being told.
 * Writing the pairs down is also what makes an unmapped CI step visible as a
 * failure here instead of as a surprise in someone's PR.
 */
describe("npm run verify covers every gate CI runs", () => {
  const ci = read(".github/workflows/ci.yml");
  const verify = read("scripts/verify-all.sh");

  /** CI step (a substring of its `run:` line) -> how verify-all spells it. */
  const GATES: Array<[ciStep: string, localCommand: string]> = [
    ["npx tsc --noEmit", "npx tsc --noEmit"],
    ["npx vitest run", "npm test"],
    ["npm run lint", "npm run lint"],
    ["cargo check", "cargo check"],
    ["cargo test --lib", "cargo test --lib"],
    // The local spelling must carry --all-targets too. Mapping CI's flagged
    // command to a bare "cargo clippy" let the local gate run a SUBSET: no
    // test targets, so a lint inside a #[test] passed here and failed there.
    ["cargo clippy --all-targets -- -D warnings", "cargo clippy --all-targets"],
    ["swift build", "swift build"],
    ["npm run check:licenses", "npm run check:licenses"],
    ["npx playwright test", "npx playwright test"],
  ];

  it("reads both files", () => {
    expect(ci.length).toBeGreaterThan(500);
    expect(verify).toContain("verify");
  });

  it.each(GATES)("CI's %s is also run locally", (ciStep, localCommand) => {
    expect(ci, `CI no longer runs "${ciStep}" — update GATES, do not delete the row`).toContain(ciStep);
    expect(
      verify,
      `CI runs "${ciStep}" and scripts/verify-all.sh does not. A local gate that ` +
        `is a subset of CI reports "all gates passed" for work CI will reject.`,
    ).toContain(localCommand);
  });

  it("has no CI run-step that the mapping forgot", () => {
    // The direction that actually catches drift: a NEW job added to CI and not
    // to the script. Test-only and setup steps are excluded by name.
    const SETUP = /npm ci|actions\/|playwright install|rustc --version|Stub|mkdir|chmod|printf|echo|cp |bash scripts\/verify-bundle|npm run tauri build/;
    const steps = [...ci.matchAll(/^\s*(?:- )?run: (.+)$/gm)]
      .map((m) => m[1].trim())
      .filter((s) => !SETUP.test(s) && !s.startsWith("|"));
    const unmapped = steps.filter((s) => !GATES.some(([ciStep]) => s.includes(ciStep)));
    expect(unmapped, "CI runs these and the GATES mapping does not mention them").toEqual([]);
  });
});

/**
 * The bundled ffmpeg's licence is stated the same way everywhere.
 *
 * This has been wrong twice in two different files. CLAUDE.md called it LGPL
 * while forbidding GPL, in an app that ships a `--enable-gpl` build and a §6
 * written offer; THIRD-PARTY-LICENSES.md called it "GPLv3" when the build
 * carries no `--enable-version3` and is therefore GPLv2-or-later.
 *
 * Neither error was reachable from a single file — each was internally
 * consistent — and the licence of a redistributed binary is the one fact in
 * this repo where being confidently wrong has consequences outside it.
 */
describe("the bundled ffmpeg licence is described consistently", () => {
  const claude = read("CLAUDE.md");
  const thirdParty = read("THIRD-PARTY-LICENSES.md");
  const readme = read("README.md");

  /**
   * Asserted POSITIVELY, and that choice is the finding.
   *
   * The first version of this test scanned the prose for the wrong claim and
   * produced two false positives immediately: the sentences CORRECTING the
   * error necessarily contain it ("it said LGPL, and that was wrong"), and
   * one line legitimately describes a hypothetical alternative ("to avoid the
   * GPL obligation, switch to an explicitly LGPL build"). Both are good
   * writing that a negative scan calls a defect.
   *
   * That is the seventh time in this repo a scanner has read a description of
   * a thing as the thing (docs/DECISIONS.md lists the other six), and the
   * seventh time the answer is the same: do not hunt for the wrong statement,
   * require the right one. A doc that carries the sentences below cannot also
   * be claiming ffmpeg is LGPL without contradicting itself in a way a reader
   * would catch.
   */
  it("names ffmpeg as GPL in the rule that decides what may be depended on", () => {
    const rule = claude.slice(claude.indexOf("- **Dependencies:**"));
    const para = rule.slice(0, rule.indexOf("\n- **"));
    expect(para, "CLAUDE.md's dependency rule must say ffmpeg is GPL").toMatch(
      /\*\*GPL\*\* \(the bundled ffmpeg/,
    );
  });

  it("states the build is GPL v2 or later, with the evidence", () => {
    // "or later" is what permits redistributing under v3, which is what this
    // app does and why the v3 text ships. The configure flags are cited so the
    // claim is checkable against the binary rather than remembered.
    expect(thirdParty).toContain("GPL v2 or later");
    expect(thirdParty).toContain("--enable-gpl");
    expect(thirdParty).toContain("--enable-version3");
  });

  it("agrees with the README, which is where most people will read it first", () => {
    expect(readme).toMatch(/ffmpeg is a \*\*GPL\*\* build/);
  });

  it("keeps the compliance obligations that shipping GPL brings", () => {
    expect(thirdParty).toContain("GPLv3.txt");
    expect(thirdParty).toMatch(/written offer/i);
    // The bundle has to actually carry the text the doc promises.
    const conf = read("src-tauri/tauri.conf.json");
    expect(conf, "the licence text the doc promises is not in bundle.resources").toContain("GPLv3.txt");
  });
});
