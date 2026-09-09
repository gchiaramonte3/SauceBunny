import { describe, expect, it, vi, afterEach } from "vitest";
import { formatPremierePairingCode, parsePremierePairingCode } from "./premiere-pairing-code";

const now = 1_788_000_000_000;
const pairing = { url: "ws://127.0.0.1:39000/premiere", token: "a".repeat(64), expiresAt: now + 300_000 };
afterEach(() => vi.useRealTimers());
describe("single-paste Premiere pairing", () => {
  it("round trips the address, secret and expiry without turning the secret into a URL", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const code = formatPremierePairingCode(pairing);
    expect(code).not.toContain("ws://");
    expect(parsePremierePairingCode(` \n${code}\n `)).toEqual(pairing);
  });
  it.each(["", "https://example.com", "ws://127.0.0.1:39000/premiere", "a".repeat(64),
    `SBP1:65536:${now + 300000}:${pairing.token}`, `SBP1:0:${now + 300000}:${pairing.token}`,
    `SBP1:39000:${now + 300000}:short`, `SBP2:39000:${now + 300000}:${pairing.token}`,
    `SBP1:39000:9999999999999999:${pairing.token}`, `SBP1:39000:${now + 300000}:${pairing.token}:extra`,
  ])("rejects malformed input without echoing the credential (%#)", value => {
    expect(() => parsePremierePairingCode(value, now)).toThrow("Copy the complete pairing code");
  });
  it("rejects expired credentials at the boundary", () => {
    expect(() => parsePremierePairingCode(`SBP1:39000:${now}:${pairing.token}`, now)).toThrow("expired");
  });
  it("refuses non-loopback addresses from the copy side", () => {
    expect(() => formatPremierePairingCode({ ...pairing, url: "ws://example.com:39000/premiere" })).toThrow("local pairing address");
  });
});
