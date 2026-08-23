/**
 * How much of a join code to show, and where to cut it.
 *
 * The full invite is ~70 characters, which does not fit the host's chip and
 * should not: the chip is a "copy this" affordance, not the code itself. What
 * it has to do is let the host confirm at a glance that the thing on screen
 * matches the thing they pasted into chat, which needs a handful of leading
 * groups and nothing more.
 *
 * The rule is GROUPS, not characters. A character cut lands mid-group
 * (`SAUC-AC2HW-EHJKM-JUI74-IA4…`) and that stray fragment reads as a typo or a
 * truncated word rather than as a code with more to it.
 */

/** Show the handle plus this many groups. Four fits the chip at its natural width. */
const DEFAULT_GROUPS = 4;

export function shortJoinCode(code: string, groups: number = DEFAULT_GROUPS): string {
  if (!code) return "";
  const parts = code.split("-");
  // The handle ("SAUC") is not a group; it is the thing that says what this is.
  const shown = parts.slice(0, groups + 1);
  if (shown.length === parts.length) return code;
  return `${shown.join("-")}…`;
}
