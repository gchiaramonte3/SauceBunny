import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Green means one of two things, and nothing else.
 *
 * This rule exists because green had been removed by hand three times and
 * came back every time. The reason it came back was structural, not
 * carelessness: `--accent` was aliased to `--ella-green` in base.css, and
 * `var(--accent)` / `var(--accent-rgb)` are read 137 times across seventeen
 * stylesheets. Every "active", "selected", "current", "running" and "count"
 * surface in the app inherited the brand green from one line nobody was
 * looking at, so greying a button here and a chip there could never converge.
 *
 * The accent is now a neutral, and the surviving green is pinned below:
 *
 *   · a POSITIVE OUTCOME - approved, passed, exported, copied, ready, ok,
 *     a finished item, a file this window will accept;
 *   · a LIVE broadcast - the session dot, the mic meter's good zone;
 *   · the BRAND MARK itself - the loader and the welcome glow, which are not
 *     system chrome and were never the complaint.
 *
 * Two categories were ADDED on 2026-08-29, at the user's direction, and the
 * rule above was narrowed to make room for them rather than quietly bent:
 *
 *   · WORK ACTUALLY RUNNING - the generate button's sweep while a job is in
 *     flight. This is the same category as the session dot: a live thing
 *     reporting itself. It had been violet, which is the brand's ACTION
 *     colour, so a busy button that could not be pressed still looked like
 *     the thing to press.
 *   · A TIMECODE - in the transcript and in the AI panel's citations. A
 *     timecode is the one thing in a wall of text that points AT the media
 *     and can be jumped to, so it is a live-media reference rather than
 *     decoration.
 *
 * Selection, identity and counts remain none of those. They read as
 * brighter, which is what focus already does (focus-contract), so the system
 * still says emphasis with one language instead of two.
 *
 * SHRINK-ONLY. Deleting a row is always fine. Adding one means arguing that a
 * new surface reports an outcome or a live feed, and if it does, say so here.
 *
 * Two more were added on 2026-08-30, at the user's direction, for the same
 * reason as the first pair - the de-greening had gone further than intended:
 *
 *   · THE GENERATIVE MARK - the sparkle on the left of the Generate button.
 *     The brand-mark category above already covers the loader and the welcome
 *     glow; this is the same thing on the one control that makes something.
 *   · WAYFINDING ON THE RAIL - the "you are here" edge beside the active nav
 *     item. Added 2026-08-30, at the user's direction, and it is the one
 *     entry here that does NOT fit the rule as stated: it is selection, which
 *     everything above deliberately excludes. It is listed anyway rather than
 *     smuggled in, because the de-greening left the rail carrying the green
 *     bunny mark with no green anywhere below it, and --accent being a
 *     neutral meant the edge rendered #F5F5F5. One mark on one piece of brand
 *     furniture, not a licence for selected rows generally.
 *
 *   · AN UNREAD NOTIFICATION - the bell's dot. Its own comment argued green
 *     was wrong because "there is something here is a count, not a verdict".
 *     That is consistent and it ignores what actually notifies in this app: a
 *     transcript, an export, a download finishing. It reports a completion far
 *     more often than a count, which is the outcome category.
 */

const ROOT = resolve(__dirname, "../..");
const STYLES = join(ROOT, "src", "styles");

/** The tokens that ARE green. `--accent` is deliberately not one of them. */
const GREEN = /var\(--(ella-green|success|stroke-green|color-accent-green)\b/;

/**
 * Every place green is still allowed, and why.
 *
 * Keyed by the file and the exact declaration text, because a selector alone
 * would let a second, unrelated green slip into the same rule.
 */
const ALLOWED: Record<string, string[]> = {
  // ── positive outcome ───────────────────────────────────────────────
  "buttons.css": ["cp-sbtn-result", "cp-gen-result", "cp-gen-btn", "cp-gen-svg"],
  // The completion toast and the notification row the bell dot points to:
  // they were the neutral white while the dot was green, so a finished job
  // was two colours on one screen.
  "monitor.css": ["cp-getting-started-check", "cp-notif-dot", "cp-canvas-toast.success", "cp-notif-item.success"],
  // cp-review-tc is the jump-to-media timecode, the same object as
  // cp-tx-jump and cp-md-ts below; it was the one blue among three.
  // cp-review-enhance: the AI tidy-up sweep. WORK ACTUALLY RUNNING, the same
  // category as the Generate button's sweep - not decoration.
  "review.css": ["cp-review-export-msg", "cp-status-chip", "cp-review-tc", "cp-review-enhance"],
  "settings.css": ["cp-spike-row", "cp-aiapi-set", "cp-settings-ready", "cp-aiapi-msg"],
  "shell.css": ["cp-drop-card"],
  "transport.css": ["cp-track-queued"],
  // Outcomes in the logs header and log lines, and the queue's DONE state,
  // which was byte-identical to RUNNING while both read --accent.
  "logs.css": ["status-pill.success", "tag.ok"],
  "queue-drawer.css": ["cp-queue-item.done", "cp-queue-status.done", "cp-queue-summary .ok"],
  // ── work actually running, and timecodes (2026-08-29) ──────────────
  "ai.css": ["cp-md-ts"],
  "transcript.css": ["cp-tx-jump"],
  // ── the generative mark, and a completion waiting to be read
  //    (2026-08-30, at the user's direction) ───────────────────────────
  //  · cp-gen-svg — the sparkle on the LEFT of the Generate button. Same
  //    category as the loader: a brand mark, not chrome. It was --fg-2, so
  //    the one control in the sidebar that means "this produces something"
  //    looked like furniture.
  //  · cp-notif-dot — the unread marker. Its old comment argued green was
  //    wrong because "there is something here is a count, not a verdict",
  //    which is consistent but ignores WHAT notifies here: a transcript, an
  //    export, a download finishing. The dot reports a completion far more
  //    often than not, which is the outcome category this file already keeps.
  // ── live broadcast ─────────────────────────────────────────────────
  "room.css": ["cp-room-live"],
  "nav.css": ["cp-nav-badge", "cp-nav-item"],
  // ── outcome + live, in one file ────────────────────────────────────
  "coreview.css": ["cp-colobby-live", "cp-colobby-code-hint", "cp-gr-meter-bar"],
  // ── the brand mark, which is not system chrome ─────────────────────
  "loader.css": ["cp-bl-stop-b"],
  "welcome.css": ["cp-welcome"],
};

/** Stylesheets, with comments stripped: this file's own prose names the tokens. */
function sheets(): Array<[name: string, lines: string[]]> {
  return readdirSync(STYLES)
    .filter((f) => f.endsWith(".css"))
    .map((f) => {
      const text = readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      return [f, text.split("\n")] as [string, string[]];
    });
}

/**
 * The WHOLE selector of the rule containing line `i`, comma-continuations
 * included.
 *
 * Reading only the line with the `{` on it is not enough, and this test caught
 * itself doing it: `.cp-aiapi-set,` and `.cp-settings-ready {` are one rule
 * written across two lines, and taking the second line alone made the first
 * selector invisible. The allowlist then reported a live entry as dead. A
 * green declaration is governed by every selector that leads to it.
 */
function selectorAt(lines: string[], i: number): string {
  let brace = -1;
  for (let j = i; j >= 0 && j > i - 40; j--) {
    if (lines[j].includes("{")) { brace = j; break; }
  }
  if (brace < 0) return "";
  const parts = [lines[brace].split("{")[0]];
  // Walk back over the sibling selectors: lines that are neither a
  // declaration nor the end of the previous rule.
  for (let j = brace - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (!t || t.includes("}") || t.includes(";")) break;
    parts.unshift(t);
  }
  return parts.join(" ").trim();
}

function greenUses(): Array<{ file: string; line: number; sel: string }> {
  const out: Array<{ file: string; line: number; sel: string }> = [];
  for (const [file, lines] of sheets()) {
    lines.forEach((l, i) => {
      if (GREEN.test(l)) out.push({ file, line: i + 1, sel: selectorAt(lines, i) });
    });
  }
  return out;
}

describe("green is reserved", () => {
  const uses = greenUses();

  it("finds the green it is policing, so the rules below cannot pass vacuously", () => {
    // The canary this repo has been bitten by four separate ways: a scan that
    // quietly stops matching reports a clean bill of health forever. If the
    // token names change, this fails rather than going silently green.
    expect(uses.length, "no green token usage found at all — the scan broke").toBeGreaterThan(8);
    expect(new Set(uses.map((u) => u.file)).size).toBeGreaterThan(4);
  });

  it("is never reached through --accent, which is the neutral the app leans on", () => {
    // The single line that made every previous removal temporary.
    const base = readFileSync(join(STYLES, "base.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const decl = /--accent:\s*([^;]+);/.exec(base)?.[1]?.trim();
    expect(decl, "base.css no longer declares --accent").toBeTruthy();
    expect(decl, `--accent is green again (${decl}) — 137 surfaces inherit this`).not.toMatch(GREEN);
    const rgb = /--accent-rgb:\s*([^;]+);/.exec(base)?.[1]?.trim();
    expect(rgb, "--accent-rgb must track --accent, or tints and solids disagree").toBe("245, 245, 245");
  });

  it("appears only where an outcome, a live feed or the brand mark is being shown", () => {
    const stray = uses.filter((u) => {
      const ok = ALLOWED[u.file] ?? [];
      return !ok.some((frag) => u.sel.includes(frag));
    });
    expect(
      stray.map((s) => `${s.file}:${s.line}  ${s.sel}`),
      "green on a surface that reports selection, activation, progress, identity or a count.\n" +
        "Those read as BRIGHTER, not greener: use var(--accent) or an --fg-* step.\n" +
        "If it genuinely reports an outcome or a live feed, add it to ALLOWED with a reason:",
    ).toEqual([]);
  });

  it("an outcome surface is never painted in the neutral", () => {
    // The other direction. Everything above polices where green IS; nothing
    // noticed where the rule said green and the sheet said --accent. When
    // base.css repointed --accent to the neutral white, nine outcome rules
    // came with it: the completion toast matched the info toast at a
    // different alpha, and the queue's DONE chip was byte-identical to
    // RUNNING. A success that looks like an info is a wrong state, not a
    // style choice, so a `.success`/`.done`/`.ok` selector may not read
    // --accent at all.
    const OUTCOME = /\.(success|done|ok|pass|ready)(?![\w-])/;
    const NEUTRAL = /var\(--accent(-rgb)?\)/;
    const outcomes: string[] = [];
    const wrong: string[] = [];
    for (const [file, lines] of sheets()) {
      lines.forEach((l, i) => {
        // A paint declaration, on its own line or inside a one-line rule.
        if (!/(^|[{;]\s*)(color|background|border-color|background-color):/.test(l)) return;
        const sel = selectorAt(lines, i);
        if (!OUTCOME.test(sel)) return;
        outcomes.push(`${file}:${i + 1}`);
        if (NEUTRAL.test(l)) wrong.push(`${file}:${i + 1}  ${sel}`);
      });
    }
    expect(outcomes.length, "found no outcome selectors at all - the scan broke").toBeGreaterThan(6);
    expect(wrong, "an outcome painted in --accent, which is the neutral: use var(--success) and add the selector to ALLOWED").toEqual([]);
  });

  it("keeps every allowlist entry earning its place", () => {
    // The ratchet's other half. An entry matching nothing is a rule nobody
    // needs any more, and leaving it there quietly re-opens the door.
    const dead: string[] = [];
    for (const [file, frags] of Object.entries(ALLOWED)) {
      for (const frag of frags) {
        if (!uses.some((u) => u.file === file && u.sel.includes(frag))) dead.push(`${file}  ${frag}`);
      }
    }
    expect(dead, "allowlisted green that no longer exists — delete the entry:").toEqual([]);
  });
});
