import { formatError } from "./error-format";

/**
 * Recognising the "stale Rust binary" failure, and saying what to do about it.
 *
 * The situation: the frontend calls a command that exists in the source but not
 * in the process that is running. `cargo check` passes, `npx tsc` passes, and
 * the app fails at runtime with an error about a command nobody can find. It
 * happens whenever a Rust command is added and `npm run tauri dev` has not been
 * restarted, which is to say constantly, during exactly the kind of work where
 * a confusing error costs the most time.
 *
 * WHAT MAKES THIS FRAGILE, and why it is worth its own file. The detector
 * matches a message string, but it matches it AFTER `formatError` has been
 * through it, and formatError's string path runs `humanizeSpawnError`, which
 * rewrites messages wholesale when it recognises them. It does not recognise
 * this one, so the text survives - today. That is incidental, not designed: a
 * new humanizer rule that happens to match would silently turn this detector
 * off, the hint would stop appearing, and the only symptom would be a developer
 * staring at a raw error during the one workflow this exists to smooth.
 *
 * So the tests pin the contract between the two, not just the regex.
 */

/**
 * Tauri's own wording when the invoke handler has no such command. Anchored to
 * words rather than the whole string because the message arrives wrapped
 * differently depending on which error path produced it.
 */
const MISSING_COMMAND_RE = /Command \w+ not found/i;

/**
 * True when an error means "the running backend does not have this command".
 *
 * Takes `unknown` and formats it here rather than accepting a string, so every
 * caller gets the same unwrapping: a legacy `Result<T, String>` and an
 * `AppError::Invalid` carrying the same text both have to resolve to the same
 * answer, since which one a command returns is not something the call site
 * knows or should have to.
 */
export function isMissingCommandError(err: unknown): boolean {
  return MISSING_COMMAND_RE.test(formatError(err));
}

/** What to tell someone who just hit a stale backend. */
export function staleBinaryMessage(commandName: string): string {
  return `${commandName} hasn't been compiled into the running dev server yet. Stop and restart \`npm run tauri dev\` so cargo rebuilds the Rust backend.`;
}
