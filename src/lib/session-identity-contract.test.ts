import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/**
 * A session id is never a join ticket.
 *
 * The screening doc is persisted to ~/Documents/Sauce Bunny/Screenings/ and its
 * id is written into the file AND used as a key in index.json. `SessionState.code`
 * is the iroh join ticket - "the join ticket to share", a live capability to
 * enter the room - and it was being used as that id, putting a capability into a
 * user-visible, frequently cloud-synced folder.
 *
 * secret-persistence-contract guards Defaults; the screening doc is not part of
 * Defaults, which is why this got through. This closes that specific hole.
 */
describe("session identity", () => {
  const src = readFileSync(resolve(__dirname, "../hooks/use-co-review.ts"), "utf8");
  const call = src.slice(src.indexOf("newScreening("), src.indexOf("newScreening(") + 400);

  it("finds the newScreening call site", () => {
    expect(call.length, "scan found nothing; every assertion below would be vacuous").toBeGreaterThan(50);
  });

  it("does not mint the screening id from the join ticket", () => {
    expect(call).not.toMatch(/\bcode\b/);
  });

  it("mints a random id instead", () => {
    expect(call).toMatch(/randomUUID\(\)/);
  });
});
