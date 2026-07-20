/**
 * In-app update CHECK (r128).
 *
 * Deliberately check-only: it tells you a newer version exists and takes you
 * to the download. It does NOT install. Self-installing updates need the app
 * to be notarized, which needs an Apple Developer ID this project does not
 * have yet - shipping a self-replacing un-notarized app is how you turn a
 * working install into a Gatekeeper problem. See
 * _design/versioning-and-updates.md.
 *
 * Privacy: the check is a plain GET of a public release listing. No account,
 * no identifier, no telemetry. The only thing the request reveals is that
 * some machine asked what the latest version is.
 */

/** Bare X.Y.Z only - the version scheme guarantees it (scripts/set-version.sh
 *  refuses anything else, and check:release fails the build on drift). */
export type Semver = { major: number; minor: number; patch: number };

/** Parse "0.2.0" or "v0.2.0". Returns null for anything that isn't bare
 *  X.Y.Z, which is the honest answer for a tag we don't understand.
 *
 *  Leading zeros are REJECTED: semver forbids them, and it is exactly the
 *  date-style tag ("2026.07.04") that would otherwise parse as 2026.7.4 and
 *  read as wildly newer than 0.2.0 - prompting an update to a version that
 *  cannot exist, since Tauri refuses to build a non-semver version. */
export function parseSemver(raw: string): Semver | null {
  const m = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(a: Semver, b: Semver): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Is `latest` newer than `current`? False when either is unparseable, so an
 * odd tag can never nag the user about an update that may not exist.
 */
export function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (!l || !c) return false;
  return compareSemver(l, c) > 0;
}

export type UpdateStatus =
  /** Checked, nothing newer. */
  | { kind: "current"; version: string }
  /** Checked, there is a newer release. */
  | { kind: "available"; version: string; url: string; notes: string }
  /** Could not check (offline, rate limited, no releases published yet).
   *  Never surfaced as an error the user must act on. */
  | { kind: "unknown"; reason: string };

/** Last check result, so the About row can show something on open without
 *  hitting the network every time the modal renders. */
const LAST_CHECK_KEY = "saucebunny.lastUpdateCheck";

export function loadLastCheck(): { at: number; status: UpdateStatus } | null {
  try {
    const raw = localStorage.getItem(LAST_CHECK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveLastCheck(status: UpdateStatus): void {
  try {
    localStorage.setItem(LAST_CHECK_KEY, JSON.stringify({ at: Date.now(), status }));
  } catch { /* quota - the check just won't be remembered */ }
}

/**
 * Ask the backend what the newest published release is and compare it with
 * the running version. The network call lives in Rust so it is not subject to
 * the webview CSP and so the endpoint is not editable from page context.
 */
export async function checkForUpdate(currentVersion: string): Promise<UpdateStatus> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const latest = await invoke<{ version: string; url: string; notes: string }>("latest_release");
    const status: UpdateStatus = isNewer(latest.version, currentVersion)
      ? { kind: "available", version: latest.version, url: latest.url, notes: latest.notes }
      : { kind: "current", version: currentVersion };
    saveLastCheck(status);
    return status;
  } catch (e) {
    // Offline, rate limited, or nothing published yet. All the same to a user:
    // we simply don't know, and that is not their problem to solve.
    const status: UpdateStatus = {
      kind: "unknown",
      reason: e instanceof Error ? e.message : String(e),
    };
    return status;
  }
}
