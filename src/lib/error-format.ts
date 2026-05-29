import type { AppError } from "../types";

/**
 * Bridge helper for the r50 typed-error migration.
 *
 * Tauri commands are migrating from `Result<T, String>` to
 * `Result<T, AppError>` incrementally — at any given moment, some
 * commands reject with a plain string and some with the discriminated
 * union `{ kind: "...", data: ... }`. Call sites that just want to
 * display the error to the user should go through `formatError()`
 * instead of `String(e)` so both shapes render readably.
 *
 * See CLAUDE.md refactor priority #4.
 */

export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof (e as { kind: unknown }).kind === "string"
  );
}

/**
 * Render any caught Tauri error as a user-facing string.
 *
 * Order of preference:
 *   1. Already a string — return as-is (legacy `Result<T, String>`).
 *   2. AppError discriminated union — format per variant.
 *   3. Native Error — `.message`.
 *   4. Last resort — `String(e)` (may be "[object Object]" for
 *      arbitrary shapes; that's a signal to add coverage here).
 */
export function formatError(e: unknown): string {
  if (typeof e === "string") return e;
  if (isAppError(e)) {
    switch (e.kind) {
      case "Invalid":
      case "Internal":
        return e.data;
      case "NotFound":
        return `Not found: ${e.data}`;
      case "Cancelled":
        return "Cancelled";
      case "SidecarMissing":
        return `Sidecar \`${e.data.name}\` is missing — the install is broken.`;
      case "SidecarFailed": {
        const code = e.data.exit_code != null ? ` (exit ${e.data.exit_code})` : "";
        return `Sidecar \`${e.data.name}\` failed${code}: ${e.data.tail}`;
      }
      case "YouTubeAuthRequired":
        return "YouTube is asking for sign-in. Choose your browser in Settings → Source so we can use its cookies.";
      case "Network":
        return `Network error: ${e.data}`;
      case "Io":
        return `I/O error: ${e.data}`;
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
