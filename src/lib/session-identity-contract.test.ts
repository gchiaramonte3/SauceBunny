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

/** Rust source with comments stripped, so this file's own prose and the
 *  explanatory comments beside the code cannot satisfy a check. */
function rust(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
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
    expect((SESSION.match(/Endpoint::builder\(/g) ?? []).length).toBe(2);
  });

  it("the host binds a persisted key", () => {
    expect(
      fnBody(SESSION, "session_start"),
      "session_start binds without .secret_key(), so its identity changes every launch",
    ).toMatch(/\.secret_key\(/);
    expect(SESSION, "the key is not loaded from the store").toContain("load_or_create_host_key");
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
    const commands = [...KEYFILE.matchAll(/#\[tauri::command\]\s*pub fn (\w+)[^{]*\{/g)];
    expect(commands.length, "no commands found to check").toBeGreaterThan(0);
    for (const m of commands) {
      expect(
        m[0],
        `${m[1]} returns a String; the endpoint secret must not cross the IPC boundary`,
      ).not.toMatch(/Result<\s*String/);
    }
    expect(KEYFILE, "a getter was added").not.toMatch(/fn get_review_identity|fn get_host_key/);
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
