import { describe, expect, it } from "vitest";
import { parseReply, validateEndpoint } from "./protocol";
import { manifest } from "../uxp.config";

describe("companion permission boundary", () => {
  it("allows only the exact loopback endpoint with a valid port", () => {
    expect(validateEndpoint("ws://127.0.0.1:51700/premiere")).toContain("51700");
    for (const value of ["ws://localhost:51700/premiere", "ws://evil.test:51700/premiere", "ws://127.0.0.1:65536/premiere", "ws://127.0.0.1:0/premiere",
      "ws://127.0.0.1:51700/premiere?token=secret", "ws://user@127.0.0.1:51700/premiere", "https://127.0.0.1:51700/premiere", "ws://127.0.0.1:51700/other"]) {
      expect(() => validateEndpoint(value)).toThrow();
    }
  });
  it("ships no broad permissions, webview, native addon or remote endpoint", () => {
    expect(manifest.host).toEqual([{ app: "premierepro", minVersion: "26.3.2" }]);
    expect(manifest.requiredPermissions).toEqual({ network: { domains: ["ws://localhost"] } });
    expect(manifest.addon).toBeUndefined();
  });
  it("refuses protocol drift and a server claiming automatic placement", () => {
    const status = { phase: "connected", binding: null, syncEnabled: false, automaticPlacement: false,
      pendingCount: 0, otherBindingPendingCount: 0, ledgerRevision: 0, error: null };
    expect(parseReply(JSON.stringify({ v: 1, id: "1", type: "snapshot", status, notes: [], page: { offset: 0, total: 0, hasMore: false } })).type).toBe("snapshot");
    expect(() => parseReply(JSON.stringify({ v: 2, id: "1", type: "snapshot", status, notes: [] }))).toThrow();
    expect(() => parseReply(JSON.stringify({ v: 1, id: "1", type: "snapshot", status: { ...status, automaticPlacement: true }, notes: [] }))).toThrow();
  });
});
