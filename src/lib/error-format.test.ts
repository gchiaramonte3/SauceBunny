import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatError, humanizeSpawnError, isAppError } from "./error-format";
import type { AppError } from "../types";

/**
 * The funnel every backend failure passes through on its way to a human.
 *
 * It had no test at all, which is how a wrong sentence lived here: this
 * function told users to "Choose your browser in Settings → Source" for a tab
 * that is called Web sources. Copy is the product at the moment something
 * breaks, and this is the one place all of it is written.
 *
 * The exhaustiveness check below is the important one. `formatError` switches
 * on `e.kind` with no default and no exhaustiveness guard, so when Rust gains
 * a variant the regenerated binding widens the union, the switch stops
 * covering it, control falls through to `String(e)` — and the user is shown
 * the literal text "[object Object]". TypeScript is perfectly happy: there IS
 * a return, it IS a string. The comment in error-format.ts already names this
 * hazard ("that's a signal to add coverage here"); nothing enforced it.
 *
 * So the variants are read from the GENERATED binding rather than typed out
 * here. Adding a variant in Rust fails this test until its copy is written.
 */

const BINDING = readFileSync(resolve(__dirname, "../bindings/AppError.ts"), "utf8");
const VARIANTS = [...BINDING.matchAll(/"kind":\s*"(\w+)"/g)].map((m) => m[1]);

/** A minimal value of each variant, with whatever payload it declares. */
function sample(kind: string): AppError {
  switch (kind) {
    case "SidecarMissing": return { kind, data: { name: "yt-dlp" } } as AppError;
    case "SidecarFailed": return { kind, data: { name: "ffmpeg", exit_code: 1, tail: "boom" } } as AppError;
    case "Cancelled":
    case "YouTubeAuthRequired": return { kind } as AppError;
    default: return { kind, data: "detail" } as unknown as AppError;
  }
}

describe("formatError", () => {
  it("read the generated variant list", () => {
    expect(VARIANTS.length, "no variants parsed from bindings/AppError.ts").toBeGreaterThan(6);
    expect(VARIANTS).toContain("Cancelled");
  });

  it("renders every variant the backend can send", () => {
    // The guard against "[object Object]" reaching a user.
    const bad: string[] = [];
    for (const kind of VARIANTS) {
      const out = formatError(sample(kind));
      if (!out || out === "[object Object]" || out === "undefined") bad.push(`${kind} → ${out}`);
    }
    expect(bad, "AppError variants with no user-facing copy").toEqual([]);
  });

  it("says something a person can act on, not a type name", () => {
    expect(formatError({ kind: "Cancelled" })).toBe("Cancelled");
    expect(formatError({ kind: "NotFound", data: "/tmp/x.mp4" })).toContain("/tmp/x.mp4");
    expect(formatError({ kind: "SidecarMissing", data: { name: "yt-dlp" } })).toContain("yt-dlp");
    expect(formatError({ kind: "SidecarFailed", data: { name: "ffmpeg", exit_code: 3, tail: "no such file" } }))
      .toMatch(/ffmpeg.*exit 3.*no such file/);
    // Copy, not a code: this one tells the user where to go.
    expect(formatError({ kind: "YouTubeAuthRequired" })).toMatch(/Settings → Web sources/);
  });

  it("omits the exit code when there wasn't one", () => {
    const out = formatError({ kind: "SidecarFailed", data: { name: "ffmpeg", exit_code: null, tail: "killed" } });
    expect(out).not.toContain("exit");
    expect(out).toContain("killed");
  });

  it("passes plain strings and Errors through", () => {
    // Legacy Result<T, String> commands, and anything thrown locally.
    expect(formatError("disk is full")).toBe("disk is full");
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("never returns an empty string for an unknown shape", () => {
    // A caller renders this directly; empty means an error banner with no text.
    expect(formatError(undefined)).not.toBe("");
    expect(formatError(null)).not.toBe("");
    expect(formatError(42)).toBe("42");
  });
});

describe("humanizeSpawnError", () => {
  it("explains the one failure users actually hit", () => {
    // iCloud eviction/restore strips the execute bit; the backend repairs it
    // at launch, so the honest advice is retry-then-relaunch.
    const raw = "failed to spawn whisper-cli: Permission denied (os error 13)";
    const out = humanizeSpawnError(raw);
    expect(out).toContain("whisper-cli");
    expect(out).toMatch(/try again/i);
    expect(out).not.toContain("os error 13");
  });

  it("leaves a permission error alone when no sidecar is named", () => {
    // Rewriting an unrelated EACCES into sidecar advice would be a lie.
    const raw = "open /Users/x/thing.mp4: Permission denied";
    expect(humanizeSpawnError(raw)).toBe(raw);
  });

  it("leaves other sidecar failures alone", () => {
    const raw = "ffmpeg exited with code 1";
    expect(humanizeSpawnError(raw)).toBe(raw);
  });

  it("reaches the humanizer through formatError's typed path too", () => {
    // Internal/Invalid carry raw text from Rust, so the same repair applies.
    const out = formatError({ kind: "Internal", data: "spawn yt-dlp: Permission denied (os error 13)" });
    expect(out).toMatch(/try again/i);
  });
});

describe("isAppError", () => {
  it("accepts the wire shape and rejects look-alikes", () => {
    expect(isAppError({ kind: "Cancelled" })).toBe(true);
    expect(isAppError({ kind: 7 })).toBe(false);
    expect(isAppError(new Error("kind"))).toBe(false);
    expect(isAppError(null)).toBe(false);
    expect(isAppError("Cancelled")).toBe(false);
  });
});
