// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  linkFingerprint, receivedReviewKey, rememberReceivedAs, resolveByFingerprint, reviewFingerprint,
} from "./review";

/**
 * Where does a guest's review doc actually land, and is it the same place
 * their SOLO review of the same file lands?
 *
 * Suspected, then proved here rather than argued from reading. It gates the
 * offline-notes work: an outbox that faithfully delivers into a document
 * nobody opens is worse than no outbox, because the notes exist and cannot be
 * found.
 *
 * The two paths:
 *   IN SESSION  the doc is saved under `d.sourceKey`, which arrived on the
 *               wire as the HOST's `reviewKey`, and the host sends a
 *               FINGERPRINT rather than a path because wire-path-contract
 *               forbids putting its filesystem path on the wire.
 *   SOLO        `reviewSourceKey` is `resolveByFingerprint(fp) ?? localFilePath`
 *               -- that is, a PATH.
 *
 * A fingerprint and a path are never equal, so the question is whether the
 * index makes them resolve to one another.
 */

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

/** What the host sends: a fingerprint of ITS copy. */
const hostFp = () => reviewFingerprint("Rough Cut v3.mov", 212.5, 1920, 1080, 4_200_000);

/** What the guest computes after the transfer: the received file is written
 *  as `<hash8>-<name>`, so its title differs from the host's. */
const guestFp = () => reviewFingerprint("a1b2c3d4-Rough Cut v3.mov", 212.5, 1920, 1080, 4_200_000);

const RECEIVED = "/cache/media/transfers/a1b2c3d4-Rough Cut v3.mov";

describe("a guest's doc key after a transfer", () => {
  it("the host's fingerprint and the guest's are different", () => {
    // The premise. The received filename carries a hash prefix, and the
    // fingerprint is computed from the title.
    expect(hostFp()).not.toBe(guestFp());
  });

  it("fetchOfferedFile links the HOST's fingerprint to the received path", () => {
    // This is what use-co-review.ts does today: linkFingerprint(pending.fingerprint, path).
    linkFingerprint(hostFp(), RECEIVED);
    expect(resolveByFingerprint(hostFp())).toBe(RECEIVED);
  });

  it("but the guest looks the file up under its OWN fingerprint, and misses", () => {
    linkFingerprint(hostFp(), RECEIVED);
    // App.tsx: resolveByFingerprint(reviewFingerprint(<guest's own metadata>))
    expect(
      resolveByFingerprint(guestFp()),
      "if this resolves, the divergence does not exist and the outbox can be built directly",
    ).toBeNull();
  });

  it("WITHOUT the received map, the two keys diverge", () => {
    // The bug as it shipped. Kept so the fix below is measured against it
    // rather than asserted.
    linkFingerprint(hostFp(), RECEIVED);
    const inSession = hostFp();                                 // d.sourceKey from the wire
    const solo = resolveByFingerprint(guestFp()) ?? RECEIVED;   // App.tsx's old reviewSourceKey
    expect(
      solo,
      "the guest's notes are filed under one key in session and read back under another",
    ).not.toBe(inSession);
  });

  it("WITH it, reopening the file lands on the session's review", () => {
    linkFingerprint(hostFp(), RECEIVED);
    // What fetchOfferedFile now records.
    rememberReceivedAs(RECEIVED, hostFp());
    // What App.tsx now resolves.
    const solo = receivedReviewKey(RECEIVED)
      ?? resolveByFingerprint(guestFp())
      ?? RECEIVED;
    expect(solo, "the received file still opens a different review").toBe(hostFp());
  });

  it("it says nothing about a file that never came through a session", () => {
    // The canary. If receivedReviewKey answered for everything, it would
    // hijack every local file's key and the assertion above would prove
    // nothing.
    rememberReceivedAs(RECEIVED, hostFp());
    expect(receivedReviewKey("/Users/me/Movies/unrelated.mov")).toBeNull();
  });

  it("matches across macOS's two spellings of the received name", () => {
    // Path stores here are NFC-keyed: the disk stores names decomposed and a
    // text field returns them composed, so a raw-string map would miss.
    const composed = "/cache/transfers/caf\u00e9.mov";
    const decomposed = "/cache/transfers/cafe\u0301.mov";
    expect(composed).not.toBe(decomposed);
    rememberReceivedAs(composed, hostFp());
    expect(receivedReviewKey(decomposed)).toBe(hostFp());
  });
});

/**
 * The store above is only half the fix. These check the WIRING, because the
 * store can be perfect while nothing calls it: removing the call from App.tsx
 * left every assertion above passing.
 */
describe("the received map is actually consulted", () => {
  const ROOT = join(__dirname, "../..");
  const src = (rel: string) =>
    readFileSync(join(ROOT, rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

  it("the transfer records which review the file belongs to", () => {
    const hook = src("src/hooks/use-co-review.ts");
    expect(hook, "nothing records the received file's review").toContain("rememberReceivedAs(");
    // Against the reviewKey, not the fingerprint: reviewKey IS the doc key the
    // session is writing under, and the fingerprint is only a lookup for it.
    expect(hook).toMatch(/rememberReceivedAs\(path,\s*pending\.reviewKey\)/);
  });

  it("opening a file consults it BEFORE the fingerprint index", () => {
    const app = src("src/App.tsx");
    const received = app.indexOf("receivedReviewKey(localFilePath)");
    expect(received, "App does not consult the received map at all").toBeGreaterThan(-1);
    const fp = app.indexOf("resolveByFingerprint(reviewFingerprint(", received - 400);
    expect(fp, "the fingerprint lookup moved; this check needs rewriting").toBeGreaterThan(-1);
    expect(
      received,
      "the fingerprint index is consulted first, so a received file resolves to its own path",
    ).toBeLessThan(fp);
  });
});
