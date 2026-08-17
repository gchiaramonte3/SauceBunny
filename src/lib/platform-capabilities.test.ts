// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The capability gate, and the false positive it was built to prevent.
 *
 * This module exists because a CSP-blocked WASM decoder did not throw — it
 * PARKED, and a file played with perfect picture and no sound, with no error on
 * any layer. Its own header says so. The blob: Worker probe then reproduced
 * that exact failure shape: a CSP-blocked worker does NOT throw from the
 * constructor. Measured in Chromium under `default-src 'self'`, the console
 * logs "Creating a worker from 'blob:...' violates the following CSP", the
 * constructor returns a Worker anyway, and the rejection arrives later as an
 * `error` event carrying no message. A probe that constructs, terminates, and
 * returns synchronously cannot see any of that, so it answered `true` on
 * precisely the broken configuration.
 *
 * Registration needs a synchronous answer, so the optimistic probe stays and
 * `confirmBlobWorker` is the async half that can observe a rejection. What is
 * tested here is the CORRECTION: does a late failure actually flip the cached
 * capability, and — the more important direction — can it never flip a working
 * platform to broken?
 */

type WorkerHandlers = { onmessage?: (e: unknown) => void; onerror?: (e: unknown) => void };

/** Install a Worker whose behaviour after construction we control. */
function installWorker(mode: "ok" | "csp-error" | "silent" | "throws") {
  const made: WorkerHandlers[] = [];
  class StubWorker {
    onmessage?: (e: unknown) => void;
    onerror?: (e: unknown) => void;
    constructor() {
      if (mode === "throws") throw new Error("Worker constructor refused");
      made.push(this);
      // Fire asynchronously, the way a real worker does — the whole point is
      // that nothing is knowable at construction time.
      setTimeout(() => {
        if (mode === "ok") this.onmessage?.({ data: 1 });
        // A CSP rejection arrives with an EMPTY message; that is why the
        // module supplies its own wording.
        if (mode === "csp-error") this.onerror?.({ message: "" });
        // "silent" fires nothing at all.
      }, 0);
    }
    terminate() {}
  }
  (globalThis as unknown as { Worker: unknown }).Worker = StubWorker;
  URL.createObjectURL = () => "blob:stub";
  URL.revokeObjectURL = () => {};
  return made;
}

async function freshModule() {
  vi.resetModules();
  return import("./platform-capabilities");
}

afterEach(() => vi.useRealTimers());

describe("the synchronous probe", () => {
  it("is optimistic about a worker that will fail later, and says so in its name", async () => {
    // Not a defect to fix — a limit to be honest about. The sync answer cannot
    // observe an async rejection, and registration cannot wait.
    installWorker("csp-error");
    const m = await freshModule();
    expect(m.platformSupports().blobWorker).toBe(true);
  });

  it("does catch a constructor that throws outright", async () => {
    installWorker("throws");
    const m = await freshModule();
    const caps = m.platformSupports();
    expect(caps.blobWorker).toBe(false);
    expect(caps.detail).toContain("blob: Worker blocked");
  });

  it("caches, so repeated calls do not re-probe", async () => {
    installWorker("ok");
    const m = await freshModule();
    const a = m.platformSupports();
    const b = m.platformSupports();
    expect(a).toBe(b); // same object identity, not merely equal
  });

  it("reports wasm as available where WebAssembly really works", async () => {
    // The canary. Node has no CSP, so this must be true — if it were false the
    // probe would be broken and every other assertion here would be about a
    // module that always says no.
    installWorker("ok");
    const m = await freshModule();
    expect(m.platformSupports().wasm).toBe(true);
    expect(m.platformSupports().detail).toBe("");
  });
});

describe("the async correction", () => {
  it("flips a false positive to false once the rejection arrives", async () => {
    // The fix. The sync probe said yes; the worker then failed; the full
    // picture must say no rather than repeat the optimistic answer.
    installWorker("csp-error");
    const m = await freshModule();
    expect(m.platformSupports().blobWorker).toBe(true);
    const caps = await m.probePlatformCapabilities();
    expect(caps.blobWorker, "a late rejection did not correct the capability").toBe(false);
    expect(caps.detail).toContain("blocked before it could run");
  });

  it("corrects the CACHE, so later readers see the truth", async () => {
    // mediabunny-export.ts reads platformSupports() at export time, long after
    // startup. Correcting only the returned object would leave that path
    // parking on a capability the app already knows it does not have.
    installWorker("csp-error");
    const m = await freshModule();
    await m.probePlatformCapabilities();
    expect(m.platformSupports().blobWorker, "the cache still claims blob workers work").toBe(false);
  });

  it("leaves a working platform alone", async () => {
    installWorker("ok");
    const m = await freshModule();
    const caps = await m.probePlatformCapabilities();
    expect(caps.blobWorker).toBe(true);
    expect(caps.detail).toBe("");
  });

  it("treats silence as working rather than broken", async () => {
    // Only positive evidence of failure may flip the answer. A loaded machine
    // whose worker is slow to speak must NOT lose its decoder — that would
    // trade this bug for a worse one, and the timeout path is the only place
    // that could introduce a false negative.
    vi.useFakeTimers();
    installWorker("silent");
    const m = await freshModule();
    const p = m.probePlatformCapabilities();
    await vi.advanceTimersByTimeAsync(1500);
    const caps = await p;
    expect(caps.blobWorker, "silence was treated as failure").toBe(true);
  });

  it("never reports blobWorker true when the sync probe already said false", async () => {
    // The correction is one-directional by construction; this pins that.
    installWorker("throws");
    const m = await freshModule();
    const caps = await m.probePlatformCapabilities();
    expect(caps.blobWorker).toBe(false);
  });
});

describe("the summary line", () => {
  it("names all three capabilities, since it is the whole diagnostic", async () => {
    // Its own comment: "The whole silent-audio investigation would have been a
    // single glance at this."
    const m = await freshModule();
    const line = m.capabilitySummary({ wasm: true, blobWorker: false, nativeOpus: true, detail: "" });
    expect(line).toContain("wasm=true");
    expect(line).toContain("blobWorker=false");
    expect(line).toContain("nativeOpus=true");
  });

  it("appends the reason when there is one, and nothing when there is not", async () => {
    const m = await freshModule();
    const withDetail = m.capabilitySummary({ wasm: false, blobWorker: true, nativeOpus: false, detail: "WebAssembly blocked: nope" });
    expect(withDetail).toContain("WebAssembly blocked: nope");
    const clean = m.capabilitySummary({ wasm: true, blobWorker: true, nativeOpus: true, detail: "" });
    expect(clean.endsWith("nativeOpus=true"), `trailing punctuation on a clean summary: ${clean}`).toBe(true);
  });
});
