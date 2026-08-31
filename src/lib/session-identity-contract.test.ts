import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The co-review host has ONE identity that outlives the process, and the code
 * it hands out names that identity and nothing else.
 *
 * Two properties, and neither can be checked from Rust's own tests.
 *
 * 1. The host endpoint binds a PERSISTED secret key. Without `.secret_key()`
 *    iroh generates a fresh one per bind - its docs say so outright - and the
 *    EndpointId a join code names changes on every launch, so yesterday's code
 *    is undialable for a reason nothing surfaces. A unit test cannot see this:
 *    binding an endpoint needs a real socket, and the failure is invisible
 *    within a single run.
 *
 * 2. The code carries the key alone, not `endpoint.addr()`, which packs the
 *    live relay URL and the observed IP set including LAN addresses. The Rust
 *    test `the_code_we_mint_carries_no_address` proves an id-only ticket has
 *    an empty address set, but its fixture is address-free by construction, so
 *    it would pass unchanged if session_start went back to `endpoint.addr()`.
 *    That is the vacuous-guard shape this repo keeps meeting, and it is why
 *    the real check is here, against the source.
 *
 * The GUEST deliberately does not persist a key. A reviewer gains nothing from
 * being durably addressable and loses by it: a stable key is a stable
 * pseudonym presented to every host they ever join, and iroh publishes address
 * records keyed by it.
 */

const ROOT = join(__dirname, "../..");

/** PRODUCTION Rust, with comments and `#[cfg(test)]` modules stripped.
 *
 *  Comments go so this file's own prose, and the explanatory notes beside the
 *  code, cannot satisfy a check. Test modules go because they legitimately do
 *  the things this contract forbids in production: a nightly test builds two
 *  more endpoints to prove an id-only code dials, and counting those broke the
 *  builder canary the moment it was added. In this file every `#[cfg(test)]`
 *  module runs to the end of the file, which the caller asserts. */
function rust(rel: string): string {
  const full = readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const firstTest = full.indexOf("#[cfg(test)]");
  return firstTest === -1 ? full : full.slice(0, firstTest);
}

const SESSION = rust("src-tauri/src/commands/session.rs");
const KEYFILE = rust("src-tauri/src/commands/session_key.rs");

/** The body of one `fn name(...)` through to the next top-level `pub fn`. */
function fnBody(src: string, name: string): string {
  const i = src.indexOf(`pub async fn ${name}(`);
  expect(i, `${name} not found`).toBeGreaterThan(-1);
  const next = src.indexOf("\npub ", i + 10);
  return src.slice(i, next === -1 ? src.length : next);
}

describe("co-review identity", () => {
  it("both endpoint builders are present to be checked", () => {
    // The canary. If either function is renamed, every assertion below would
    // pass over a string it never found.
    expect(SESSION.length).toBeGreaterThan(1000);
    expect(KEYFILE.length).toBeGreaterThan(500);
    expect(SESSION).toContain("pub async fn session_start(");
    expect(SESSION).toContain("pub async fn session_join(");
    // Exactly two in production: the host's and the guest's. A third would
    // mean an endpoint nothing here checks the identity policy of.
    expect((SESSION.match(/Endpoint::builder\(/g) ?? []).length).toBe(2);
    // And prove the test-module strip cut tests rather than production: the
    // slice must have removed something AND kept the functions under test.
    const raw = readFileSync(join(ROOT, "src-tauri/src/commands/session.rs"), "utf8");
    expect(raw.length, "the strip removed nothing, so tests are being scanned")
      .toBeGreaterThan(SESSION.length);
    expect(SESSION, "the strip cut into production code").toContain("EndpointTicket::new(");
  });

  it("the Keychain is read off the runtime, and not under the session lock", () => {
    // A Keychain read can raise a macOS prompt and block until answered. A
    // test run against a rebuilt binary sat on one for 26,112 seconds. Doing
    // that inline in an async command, while holding the lock every other
    // session command takes, parks a tokio worker AND queues the rest of the
    // app behind a dialog.
    expect(KEYFILE, "the loader is not moved off the async runtime").toContain("spawn_blocking");
    expect(KEYFILE, "the key is re-read per session rather than memoised").toContain("OnceCell");

    const body = fnBody(SESSION, "session_start");
    const load = body.indexOf("session_key::host_key()");
    const lock = body.indexOf("state.inner.lock()");
    expect(load, "session_start does not load the key through host_key()").toBeGreaterThan(-1);
    expect(lock, "the session lock moved; this check needs rewriting").toBeGreaterThan(-1);
    expect(
      load,
      "the Keychain is read while holding the session lock, so a prompt blocks every other command",
    ).toBeLessThan(lock);
  });

  it("the host binds a persisted key", () => {
    expect(
      fnBody(SESSION, "session_start"),
      "session_start binds without .secret_key(), so its identity changes every launch",
    ).toMatch(/\.secret_key\(/);
    // session.rs reaches the store through host_key(), which is the memoised,
    // off-runtime front door; the store read itself lives in session_key.rs.
    expect(SESSION, "the key is not loaded from the store").toContain("session_key::host_key()");
    expect(KEYFILE, "the store read is gone").toContain("load_or_create_host_key");
  });

  it("the guest does not", () => {
    expect(
      fnBody(SESSION, "session_join"),
      "the guest persists an identity; a reviewer should not be durably addressable",
    ).not.toMatch(/\.secret_key\(/);
  });

  it("the code names the key, not the addresses", () => {
    const body = fnBody(SESSION, "session_start");
    expect(body, "the invite is minted from endpoint.id()").toMatch(
      /EndpointTicket::new\(EndpointAddr::new\(endpoint\.id\(\)\)\)/,
    );
    expect(
      body,
      "the invite packs endpoint.addr(), which carries the relay URL and LAN addresses",
    ).not.toMatch(/EndpointTicket::new\(endpoint\.addr\(\)\)/);
  });

  it("nothing hands the key to the webview", () => {
    // The one difference from the TURN password next door, which IS readable
    // because the RTCPeerConnection is built in JS. This key is used at
    // Endpoint::builder and nowhere else, so a getter would be a pure loss.
    //
    // AN ALLOWLIST, NOT A DENYLIST, and that polarity is the whole point. The
    // first version of this matched `pub fn` only and forbade `Result<String`.
    // A reviewer broke it in one minute by adding
    // `pub async fn export_session_key() -> Result<String, AppError>` and
    // `pub fn dump_key_bytes() -> Result<Vec<u8>, AppError>`, both returning
    // the secret: the first slipped past on `async`, the second on the type.
    // The suite reported seven passes. Enumerating the ways a secret can leave
    // is a losing game; enumerating the two shapes that may leave is not.
    const commands = [
      ...KEYFILE.matchAll(/#\[tauri::command\]\s*pub (?:async )?fn (\w+)\s*\([^)]*\)\s*->\s*([^{]+)\{/g),
    ];
    expect(commands.length, "no commands found to check").toBeGreaterThan(1);

    /** Everything this module is allowed to return. Nothing here can carry
     *  32 bytes of key: a bool answers "is one stored", and unit answers
     *  "it is gone". */
    const ALLOWED = ["Result<bool, AppError>", "Result<(), AppError>"];
    for (const [, name, ret] of commands) {
      expect(
        ALLOWED,
        `${name} returns ${ret.trim()}, which is not one of the two shapes that may cross the IPC boundary`,
      ).toContain(ret.trim());
    }
  });

  it("it has its own Keychain service", () => {
    // Clearing an AI key must never reach the network identity, and vice
    // versa: different secrets, different lifetimes.
    const svc = KEYFILE.match(/KEYCHAIN_SERVICE: &str = "([^"]+)"/);
    const ai = rust("src-tauri/src/commands/cloud_ai.rs").match(/KEYCHAIN_SERVICE: &str = "([^"]+)"/);
    expect(svc?.[1], "no Keychain service constant").toBeTruthy();
    expect(ai?.[1], "cloud_ai's service constant moved").toBeTruthy();
    expect(svc![1]).not.toBe(ai![1]);
  });

  it("a Keychain that refuses does not stop you hosting", () => {
    // Sessions worked with no Keychain at all before this existed. A first-run
    // prompt the user dismisses must not become "you cannot start a session".
    // Infallible: it returns a key, not a Result. A `?` here would make a
    // dismissed Keychain prompt into "you cannot start a session".
    expect(KEYFILE, "the loader can fail, which would block hosting").toMatch(
      /pub fn load_or_create_host_key\(\) -> SecretKey/,
    );
    expect(KEYFILE, "a fallback path is missing").toContain("SecretKey::generate()");
  });
});
