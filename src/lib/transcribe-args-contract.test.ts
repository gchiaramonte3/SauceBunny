import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Every transcription invoke carries every per-run setting.
 *
 * Written after shipping exactly the failure this repo keeps shipping: a
 * change applied to SOME call sites and not the rest. Settings ▸ Transcription
 * ▸ Speed was threaded all the way through Rust and passed from two of the
 * FIVE places that start a transcription. The two it missed included
 * `transcribe_prepared_wav`, which is the DEFAULT path for a local file — so
 * the setting appeared to do nothing on the commonest case, did work on a
 * long file that fell back to ffmpeg, and was silently ignored by batch.
 *
 * It could not be caught downstream: a missing field deserialises to `None`,
 * and `None` means "accurate", so omitting it is indistinguishable from
 * choosing it.
 *
 * The rule: if a setting belongs in one transcription call, it belongs in all
 * of them. Add a field here when you add one to the Rust args.
 */

const SRC = path.resolve(__dirname, "..");

/** Commands that start a whisper/parakeet run. */
const COMMANDS = ["generate_transcript", "transcribe_local_file", "transcribe_prepared_wav"];

/** Fields every one of those calls must pass. */
const REQUIRED = ["model_id", "job_id", "detect_speakers", "expected_speakers", "language", "speed"];

function walk(dir: string, hit: (p: string) => void): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, hit);
    else if ((p.endsWith(".ts") || p.endsWith(".tsx")) && !p.includes(".test.")) hit(p);
  }
}

/** Each invoke of a transcription command, with its `args` object literal. */
function callSites(): { file: string; command: string; body: string }[] {
  const out: { file: string; command: string; body: string }[] = [];
  walk(SRC, (file) => {
    const text = fs.readFileSync(file, "utf8");
    for (const cmd of COMMANDS) {
      const re = new RegExp(`invoke<[^>]*>\\("${cmd}",`, "g");
      for (let m = re.exec(text); m; m = re.exec(text)) {
        // Take the balanced brace block that follows — the invoke payload.
        const from = text.indexOf("{", m.index + m[0].length - 1);
        if (from < 0) continue;
        let depth = 0, end = from;
        for (let i = from; i < text.length; i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
        }
        out.push({ file: path.relative(SRC, file), command: cmd, body: text.slice(from, end + 1) });
      }
    }
  });
  return out;
}

describe("transcription call sites", () => {
  const sites = callSites();

  it("finds every place a transcription is started", () => {
    // Canary. A broken scanner would make every assertion below vacuous, and
    // this test exists BECAUSE a per-site omission went unnoticed.
    expect(sites.length).toBeGreaterThanOrEqual(5);
    for (const cmd of COMMANDS) {
      expect(sites.some((s) => s.command === cmd), `no call site found for ${cmd}`).toBe(true);
    }
  });

  it.each(REQUIRED)("every call site passes %s", (field) => {
    const missing = sites
      .filter((s) => !new RegExp(`(^|[\\s{,])${field}\\s*:`).test(s.body))
      .map((s) => `${s.file} -> ${s.command}`);
    expect(
      missing,
      `these transcription calls omit "${field}". A missing field deserialises to None, ` +
      `so the setting silently does nothing rather than failing`,
    ).toEqual([]);
  });
});
