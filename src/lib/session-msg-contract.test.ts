import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The co-review wire protocol: every `SessionMsg` kind is handled by someone.
 *
 * Fifteen variants cross between peers, and they are split deliberately —
 * `hello` / `welcome` / `peerList` / `bye` are connection lifecycle and belong
 * to Rust's session layer; the other eleven are application messages the
 * frontend applies. Neither side handles the other's, and that is correct, not
 * an omission. It is also invisible: reading either file alone shows a switch
 * that covers only part of the union.
 *
 * The risk is a sixteenth. Adding a variant is a change in `session.rs` plus a
 * regenerated binding, and nothing makes the handler mandatory — the TS switch
 * has no `default`, so an unhandled kind is silently dropped. That silence is
 * RIGHT across versions (an older peer must ignore what a newer peer invents
 * rather than crash) and wrong within one: the sender and receiver ship in the
 * same binary, so a kind nobody handles is simply a feature that does nothing.
 *
 * This test cannot tell those apart by intent, so it asks the narrower
 * question: does some file in this repo handle it at all?
 */

const ROOT = resolve(__dirname, "../..");
const binding = readFileSync(join(ROOT, "src/bindings/SessionMsg.ts"), "utf8");
const rust = readFileSync(join(ROOT, "src-tauri/src/commands/session.rs"), "utf8");
const coReview = readFileSync(join(ROOT, "src/hooks/use-co-review.ts"), "utf8");

const VARIANTS = [...binding.matchAll(/"kind":\s*"(\w+)"/g)].map((m) => m[1]);

/** Lifecycle kinds Rust owns; the frontend never sees them as app messages. */
const RUST_OWNED = new Set(["hello", "welcome", "peerList", "bye"]);

describe("the SessionMsg wire protocol", () => {
  it("read the generated variants", () => {
    expect(VARIANTS.length, "no SessionMsg variants parsed").toBeGreaterThan(10);
    expect(VARIANTS).toContain("reviewOp");
  });

  it("has a handler for every kind, on one side or the other", () => {
    const orphans = VARIANTS.filter((v) => {
      const inRust = new RegExp(`"${v}"|SessionMsg::${v[0].toUpperCase()}${v.slice(1)}`).test(rust);
      const inTs = new RegExp(`case\\s+"${v}"`).test(coReview);
      return !inRust && !inTs;
    });
    expect(orphans, "SessionMsg kinds nothing handles — sent and silently dropped").toEqual([]);
  });

  it("keeps the split where it belongs", () => {
    // Lifecycle in Rust, application messages in the frontend. If a lifecycle
    // kind ever grows a frontend case, the ownership question is worth asking
    // out loud rather than drifting into both.
    for (const v of RUST_OWNED) {
      expect(new RegExp(`case\\s+"${v}"`).test(coReview), `${v} is Rust's, but use-co-review handles it`).toBe(false);
    }
    const appMessages = VARIANTS.filter((v) => !RUST_OWNED.has(v));
    expect(appMessages.length).toBeGreaterThan(8);
    for (const v of appMessages) {
      expect(new RegExp(`case\\s+"${v}"`).test(coReview), `${v} has no case in use-co-review`).toBe(true);
    }
  });

  it("drops an unknown kind instead of throwing", () => {
    // Forward compatibility with a newer peer. The switch deliberately has no
    // `default:` that reports — pinned here so nobody "fixes" it into a throw.
    expect(coReview).not.toMatch(/switch \(m\.kind\)[\s\S]{0,4000}?default:\s*throw/);
  });
});

describe("the export queue is not session state", () => {
  it("no SessionMsg variant carries clip marks or the queue", () => {
    // A queued clip is this machine's export plan: private working state that
    // means nothing to the person on the other end. What a screening shares
    // is the comments and their spans, presence, transport and reactions.
    //
    // This is the half that is easy to lose later. Hiding the bands is a
    // render decision one component makes and any future call site could
    // undo; the wire is where the promise actually lives, so the wire is
    // where it is pinned.
    const forbidden = /\b(inFrames|outFrames|queuedRange|clipQueue|QueuedClip)\b/;
    expect(forbidden.test(binding), "SessionMsg binding names clip marks").toBe(false);

    // The Rust union, read between `enum SessionMsg` and its closing brace, so
    // an unrelated mention elsewhere in session.rs cannot fail this.
    const start = rust.indexOf("enum SessionMsg");
    expect(start, "SessionMsg enum not found in session.rs").toBeGreaterThan(-1);
    const union = rust.slice(start, rust.indexOf("\n}", start));
    expect(forbidden.test(union), "the SessionMsg enum names clip marks").toBe(false);
  });
});
