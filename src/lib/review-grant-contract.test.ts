import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A link is issued to a named person, and the name is the HOST's.
 *
 * The rule this exists for is not "grants are stored correctly". It is that a
 * granted connection's display name comes from the label the host typed and
 * NOT from the peer's own `Hello`.
 *
 * That distinction is the whole security value. The relay already stamps
 * `from` so a peer cannot forge ANOTHER member's attribution - but it could
 * never stop a stranger holding a forwarded link from simply CALLING
 * themselves Dana, at which point every note they leave is written to the
 * review file signed Dana, permanently. `clean_name` defends exactly one
 * reserved word ("Host") and was never going to be enough.
 */

const ROOT = join(__dirname, "../..");
const rust = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8").replace(/^\s*\/\/.*$/gm, "");

const SESSION = rust("src-tauri/src/commands/session.rs");
const GRANT = rust("src-tauri/src/commands/review_grant.rs");

describe("review grants", () => {
  it("the pieces exist to be checked", () => {
    // The canary.
    expect(GRANT.length).toBeGreaterThan(1000);
    expect(SESSION).toContain("handle_peer_conn");
    expect(GRANT).toContain("pub fn admit(");
  });

  it("a granted peer is named by the host's label, not its own Hello", () => {
    // The one that matters. If the Granted arm ever takes raw_name, a
    // stranger with a forwarded link signs notes as whoever they like.
    // ONE LINE, not a byte window. A 160-char slice ran past this arm into
    // the Ungranted one, which correctly uses raw_name, so the check failed
    // against right code - the mirror of a scan that passes against wrong code.
    const arm = SESSION.split("\n").find((l) => l.includes("Admission::Granted {"));
    expect(arm, "the granted arm is gone; this check needs rewriting").toBeTruthy();
    expect(arm!, "the granted arm does not use the host's label").toContain("label");
    expect(arm!, "the granted arm takes the peer's claimed name").not.toContain("raw_name");
  });

  it("a revoked or unknown grant is refused, not downgraded", () => {
    // Falling back to an ungranted join would make revocation cosmetic:
    // withdraw a link, and its holder simply rejoins without it.
    expect(GRANT).toMatch(/if g\.revoked \{\s*return Admission::Refused/);
    expect(GRANT, "an unknown secret is not refused").toMatch(
      /else \{\s*return Admission::Refused\("that link is not valid"\)/,
    );
    expect(SESSION, "the host does not close on a refusal").toMatch(
      /Admission::Refused\(why\) => \{[\s\S]{0,200}conn\.close/,
    );
  });

  it("the secret is never stored in a form that could be re-issued", () => {
    // A store that can hand back a live link leaks every link if it is read.
    expect(GRANT, "the grant record holds something other than a hash").toContain("secret_hash");
    expect(GRANT, "a plaintext secret field was added to the record").not.toMatch(
      /pub struct ReviewGrant \{[^}]*\bpub secret: String/,
    );
    // And the summary handed to the webview carries neither.
    const summary = GRANT.slice(GRANT.indexOf("pub struct GrantSummary"), GRANT.indexOf("pub struct GrantSummary") + 260);
    expect(summary, "the webview is handed a secret").not.toMatch(/secret/);
  });

  it("grants live outside iCloud", () => {
    // ~/Documents is iCloud-synced for most people and this file holds
    // secret hashes. The review docs live there; this must not.
    expect(GRANT, "the grant file is not in app_data_dir").toContain("app_data_dir()");
    expect(GRANT, "the grant file was moved under Documents").not.toContain("Documents");
  });

  it("it hashes with BLAKE3, not a password KDF", () => {
    // The secret is 256 bits of getrandom, so there is nothing to stretch.
    // argon2 would walk straight back into r152's package purge.
    expect(GRANT).toContain("blake3::hash");
    expect(GRANT, "a password KDF crept in").not.toMatch(/argon2|bcrypt|scrypt|pbkdf2/i);
  });

  it("withdrawing a link disconnects whoever holds it, now", () => {
    // Marking alone made revocation take effect at the NEXT join: the person
    // you had just removed kept reading and commenting until they happened to
    // leave. And it is ONE command rather than two the caller must remember -
    // a rule like that is followed once and then forgotten.
    expect(GRANT, "revoke does not disconnect").toContain("disconnect_grant");
    expect(SESSION, "there is no way to close a connection").toContain("fn disconnect_peers");
    expect(SESSION, "the grant disconnect does not match on the grant").toMatch(
      /p\.grant\.as_deref\(\) == Some\(grant_id\)/,
    );
  });

  it("a kick closes the connection, not just the stream", () => {
    // Resetting the send stream stops the host writing to them and leaves
    // their read loop running: they stop receiving updates and keep believing
    // they are in the session. That is a half-removal.
    const fn = SESSION.slice(SESSION.indexOf("async fn disconnect_peers"), SESSION.indexOf("async fn disconnect_peers") + 900);
    expect(fn, "disconnect_peers is gone").toBeTruthy();
    expect(fn, "it closes a stream rather than the connection").toContain("c.close(");
    expect(fn, "the roster is not told who is left").toContain("broadcast_peer_list");
  });
});
