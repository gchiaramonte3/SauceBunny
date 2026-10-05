import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The capture helper (Swift) and its supervisor (Rust) agree on the protocol.
 *
 * They are two languages with no compiler between them. A status code the
 * helper sends that Rust has no words for shows the person "The capture could
 * not start" whatever went wrong; a status field Rust reads that Swift renamed
 * fails every capture with "invalid status" (Rust rejects unknown or missing
 * fields on purpose); an op only one side knows is silently ignored, because
 * the helper drops any line it cannot parse. Each of these passes every unit
 * test on its own side.
 */

const ROOT = resolve(__dirname, "../..");
const swiftDir = resolve(ROOT, "swift-sidecar/Sources/saucebunny-program-capture");
const swift = readdirSync(swiftDir).filter(name => name.endsWith(".swift")).map(name => readFileSync(join(swiftDir, name), "utf8")).join("\n");
const control = readFileSync(resolve(ROOT, "swift-sidecar/Sources/ProgramCaptureCore/Control.swift"), "utf8");
const rust = readFileSync(resolve(ROOT, "src-tauri/src/commands/obs/picked.rs"), "utf8");

/** Every `"start_…"` or `"source_stopped"` code the helper can put in a status. */
const helperCodes = () => [...new Set([...swift.matchAll(/"((?:start|source)_[a-z_]+)"/g)].map(match => match[1]))];

describe("capture helper protocol", () => {
  it("finds the codes, ops and fields it compares", () => {
    expect(helperCodes().length, "no status codes found in the helper: the pattern broke").toBeGreaterThan(4);
    expect(rust).toMatch(/fn status_error/);
  });

  it("gives every status code the helper sends its own words in the app", () => {
    const body = rust.slice(rust.indexOf("fn status_error"), rust.indexOf("struct Active"));
    const missing = helperCodes().filter(code => !body.includes(`"${code}"`));
    expect(missing, "Add these to status_error in obs/picked.rs, or the person sees a generic failure").toEqual([]);
  });

  it("sends only ops the helper parses, and the helper parses only ops it is sent", () => {
    const sent = new Set([...rust.matchAll(/"op":\s*"([a-z]+)"/g)].map(match => match[1]));
    const parsed = new Set([...control.matchAll(/case "([a-z]+)":/g)].map(match => match[1]));
    expect(sent.size).toBeGreaterThan(3);
    expect([...sent].sort()).toEqual([...parsed].sort());
  });

  it("reads exactly the status fields the helper writes", () => {
    const struct = rust.match(/struct Status \{([^}]*)\}/)?.[1] ?? "";
    const read = [...struct.matchAll(/(\w+):/g)].map(match => match[1]).sort();
    const written = [...swift.matchAll(/\["width": [^\]]*\]/g)].flatMap(match => [...match[0].matchAll(/"(\w+)":/g)].map(key => key[1]));
    expect(read.length, "Rust's Status struct was not found").toBeGreaterThan(3);
    expect([...new Set(written)].sort(), "The helper's status keys and Rust's Status struct disagree").toEqual(read);
  });
});
