/**
 * A job id for a cancelable backend job — minted here, synchronously.
 *
 * THE SYNCHRONOUSNESS IS THE POINT, not an optimisation.
 *
 * This used to be `await invoke<string>("new_job_id")`, a Tauri round trip to
 * a Rust command whose entire body was `Uuid::new_v4().to_string()`. It
 * returned the same kind of value this does, just later — and "later" was a
 * window in which the user could hit Stop while the app held no handle to
 * cancel with. What happened then was specific and bad: Stop reset the UI to
 * idle and aborted the PREVIOUS run's controller (or nothing at all), the id
 * came back, this run installed a fresh un-aborted controller, and the job ran
 * to completion and loaded its result over a screen that said it had been
 * cancelled.
 *
 * That was found and patched six times, at six call sites, each time by adding
 * an `if (aborted) return` after the await. Eleven other call sites never got
 * the patch. Removing the await removes the window at all seventeen at once,
 * and — the part a guard could never do — makes it impossible to reintroduce
 * by adding an eighteenth.
 *
 * Same value, same uniqueness: `crypto.randomUUID()` is a v4 UUID from the
 * platform CSPRNG, which is what the Rust side was producing. The backend
 * never saw the id before it was used anyway — JobRegistry keys on whatever
 * string the invoke carries, so there was nothing to register and nothing to
 * wait for.
 */
export function newJobId(): string {
  return crypto.randomUUID();
}
