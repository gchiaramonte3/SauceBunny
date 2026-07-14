import type { AppStatus } from "../types";

/**
 * The four visual phases of a stateful action button. The PARENT owns which
 * phase is current (StatefulButton is presentational): `loading` while the
 * real async job runs, then a short `success`/`error` flash before the parent
 * returns it to `idle`.
 */
export type StatefulPhase = "idle" | "loading" | "success" | "error";

/**
 * Effective phase for the toolbar Fetch button.
 *
 * The URL-fetch path (App.handleFetch) does an optimistic mount straight to
 * `status: "loaded"` and never sets `"fetching"`, so it drives an explicit
 * `fetchPhase` state instead: loading during the metadata probe, then a
 * success flash when it hydrates / an error flash when it fails.
 *
 * Local-file imports (App.loadLocalPath) DO flip `status` to `"fetching"`,
 * which we fold in as a plain loading state so the button still spins during
 * an import — but imports get no success/error flash (out of scope this pass).
 */
export function fetchButtonPhase(fetchPhase: StatefulPhase, status: AppStatus): StatefulPhase {
  if (fetchPhase === "success" || fetchPhase === "error") return fetchPhase;
  if (fetchPhase === "loading" || status === "fetching") return "loading";
  return "idle";
}
