import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The Content-Security-Policy is a RUNTIME CONTRACT with the code, and it is
 * enforced only in the packaged app.
 *
 * The bug this test exists to prevent (r150): the CSP omitted
 * 'wasm-unsafe-eval', so WKWebView refused WebAssembly instantiation in the
 * .dmg. The WASM Opus decoder's bootstrap promise has no rejection path, so it
 * did not throw, it PARKED; mediabunny queued every decode behind that pending
 * init; the audio loop awaited a generator that never yielded. Result: local
 * files played with a perfect picture and no sound, with no error on any
 * layer, and no test could see it because `tauri dev` serves over plain http
 * with NO CSP at all. It took three user reports and an A/B in a real
 * WKWebView to find one missing token.
 *
 * So: for as long as the app registers a WASM-backed or Worker-backed
 * extension, the shipped policy must permit those things. This test reads the
 * two files and asserts they agree.
 */

const ROOT = resolve(__dirname, "../..");

function shippedCsp(): string {
  const conf = JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8")) as {
    app?: { security?: { csp?: string } };
  };
  const csp = conf.app?.security?.csp;
  expect(csp, "tauri.conf.json must declare app.security.csp").toBeTruthy();
  return csp as string;
}

function directive(csp: string, name: string): string {
  const found = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
  return found ?? "";
}

describe("CSP contract: the shipped policy must permit what startup registers", () => {
  const entry = readFileSync(resolve(ROOT, "src/main.tsx"), "utf8");

  it("permits WebAssembly instantiation while any WASM-backed decoder is registered", () => {
    // These registrations are WASM-backed. If you remove them all, this
    // assertion may be relaxed - deliberately, not by accident.
    const registersWasm = /registerLocalDecoders|registerMp3Encoder|registerProresDecoder/.test(entry);
    expect(registersWasm, "main.tsx should still register WASM-backed extensions").toBe(true);

    const script = directive(shippedCsp(), "script-src");
    expect(
      script.includes("'wasm-unsafe-eval'") || script.includes("'unsafe-eval'"),
      `script-src must allow WebAssembly instantiation, got: "${script}". `
      + "Without it WKWebView refuses to instantiate WASM in the PACKAGED app only, "
      + "and a decoder whose init never rejects hangs silently instead of failing.",
    ).toBe(true);
  });

  it("permits blob: Workers, which mediabunny's decoders spawn", () => {
    const csp = shippedCsp();
    // worker-src wins if present; otherwise Workers fall back to script-src.
    const worker = directive(csp, "worker-src") || directive(csp, "child-src") || directive(csp, "script-src");
    expect(
      worker.includes("blob:"),
      `Workers must be allowed from blob: URLs, got: "${worker}". `
      + "@mediabunny/prores and @mediabunny/mp3-encoder both spawn blob: Workers; "
      + "denied, they hang rather than error (getCanvas measured pending past 40s).",
    ).toBe(true);
  });

  it("does not quietly widen to full unsafe-eval", () => {
    // 'wasm-unsafe-eval' grants WebAssembly only. If someone reaches for the
    // bigger hammer to fix a WASM problem, that should be a deliberate act.
    const script = directive(shippedCsp(), "script-src");
    expect(
      script.includes("'unsafe-eval'"),
      "script-src should use 'wasm-unsafe-eval', not full 'unsafe-eval' (which also enables JS eval).",
    ).toBe(false);
  });

  it("registers WASM-backed extensions behind a capability check, not unconditionally", () => {
    // The CSP fix alone is not enough: mediabunny PREFERS a matching custom
    // decoder over the platform's own, so registering one that cannot run
    // replaces a working native decoder with a broken one. Registration must
    // be gated on a measured probe.
    expect(
      /platformSupports\(\)/.test(entry),
      "main.tsx must gate WASM registrations on platformSupports() so a blocked "
      + "runtime degrades to the native decoder instead of hanging.",
    ).toBe(true);
  });
});

describe("MP3 encoder loads lazily, and still behind its capability gate", () => {
  const entry = readFileSync(resolve(ROOT, "src/main.tsx"), "utf8");
  const exporter = readFileSync(resolve(ROOT, "src/lib/mediabunny-export.ts"), "utf8");

  it("is not pulled into the startup entry chunk", () => {
    // It inlines a 223 KB WASM module as base64 inside a worker source —
    // measured at ~15% of the whole JS bundle — for a format most sessions
    // never export. A static import anywhere main.tsx reaches puts it back.
    expect(entry).not.toMatch(/mp3-encoder/);
  });

  it("keeps the r150 capability gate on the lazy path", () => {
    // THE failure this guards is silent. Registering a WASM-backed extension
    // the platform cannot run does not throw — mediabunny queues work behind
    // an init promise that never settles, and MP3 export hangs forever with
    // no error anywhere. Moving the import must not leave the gate behind.
    const lazy = exporter.slice(exporter.indexOf("function ensureMp3Encoder"));
    expect(lazy).toMatch(/platformSupports\(\)/);
    expect(lazy).toMatch(/platform\.wasm/);
    expect(lazy).toMatch(/platform\.blobWorker/);
    expect(lazy).toMatch(/await import\("@mediabunny\/mp3-encoder"\)/);
  });

  it("registers the encoder BEFORE the Mp3 output format is constructed", () => {
    // Registration is a global side effect on mediabunny's encoder registry,
    // and Conversion resolves encoders when it initialises. Awaiting it after
    // the Output exists is a race that would only ever fail on a cold first
    // export — the exact case nobody tests by hand.
    const awaitAt = exporter.indexOf('await ensureMp3Encoder()');
    const buildAt = exporter.indexOf("new Mp3OutputFormat()");
    expect(awaitAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeLessThan(buildAt);
  });
});
