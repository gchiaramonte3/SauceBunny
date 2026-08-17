// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";

describe("raw probes", () => {
  it("collect", () => {
    const out: Record<string, unknown> = {};
    out.typeofWorker = typeof (globalThis as any).Worker;
    out.typeofCreateObjectURL = typeof URL.createObjectURL;
    out.typeofRevoke = typeof URL.revokeObjectURL;
    let url: string | null = null;
    try {
      url = URL.createObjectURL(new Blob(["self.close()"], { type: "text/javascript" }));
      out.url = url;
      const w = new (globalThis as any).Worker(url);
      w.terminate();
      out.worker = "OK";
    } catch (e) {
      out.worker = "THREW";
      out.workerErr = String(e);
      out.workerIsError = e instanceof Error;
      out.workerMessage = (e as any)?.message;
      out.workerCtor = (e as any)?.constructor?.name;
    } finally {
      try { if (url) URL.revokeObjectURL(url); out.revoke = "ok"; }
      catch (e) { out.revoke = "THREW " + String(e); }
    }
    // DOMException instanceof Error?
    try {
      const d = new DOMException("boom", "SecurityError");
      out.domExceptionIsError = d instanceof Error;
      out.domExceptionMessage = d.message;
    } catch (e) { out.domExceptionProbe = String(e); }
    writeFileSync("/tmp/pc-out.json", JSON.stringify(out, null, 2));
    expect(true).toBe(true);
  });
});
