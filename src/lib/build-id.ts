/**
 * Expected backend build ID. MUST match the `BACKEND_BUILD_ID` constant in
 * src-tauri/src/commands.rs. Bump both sides together whenever you add or
 * change a Rust command that the frontend depends on.
 *
 * On app startup the frontend asks the backend for its build ID and shows
 * a banner if they don't match — which is the unambiguous signal that
 * `npm run tauri dev` needs to be restarted so cargo rebuilds the binary.
 */
export const EXPECTED_BACKEND_BUILD_ID = "2026-05-30-r73-ytdlp-updater";

export type BuildIdCheck =
  | { kind: "ok"; id: string }
  | { kind: "mismatch"; expected: string; got: string }
  | { kind: "missing" } // command not registered — very stale binary
  | { kind: "error"; error: string };
