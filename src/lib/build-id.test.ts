import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXPECTED_BACKEND_BUILD_ID } from "./build-id";

/**
 * The build-ID handshake is two hand-maintained constants (see CLAUDE.md).
 * The failure it guards against — silent frontend/backend skew — is exactly
 * what a forgotten bump reintroduces, so this test makes a forgotten bump a
 * red CI run instead: it parses the Rust constant straight out of system.rs
 * and asserts it matches the TS side. (A build.rs that injects a shared hash
 * was considered and rejected: syncing generated values across cargo AND vite
 * adds two build-system seams to protect one string.)
 */
describe("build-id handshake", () => {
  it("TS EXPECTED_BACKEND_BUILD_ID matches Rust BACKEND_BUILD_ID", () => {
    const rs = readFileSync(
      resolve(__dirname, "../../src-tauri/src/commands/system.rs"),
      "utf8",
    );
    const m = rs.match(/BACKEND_BUILD_ID:\s*&str\s*=\s*"([^"]+)"/);
    expect(m, "BACKEND_BUILD_ID constant not found in system.rs").toBeTruthy();
    expect(m![1]).toBe(EXPECTED_BACKEND_BUILD_ID);
  });
});
