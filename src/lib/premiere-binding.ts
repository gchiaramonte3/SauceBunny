import type { PremiereBinding } from "../bindings/PremiereBinding";

// Common wire bounds: preserve the app's bounded fields and the companion's
// canonical positive timebase. Native validation remains the final authority.
const MAX_BINDING_TEXT = 512;
const MAX_DISPLAY_FORMAT = 128;
const POSITIVE_TICKS = /^[1-9][0-9]{0,23}$/;
const SIGNED_TICKS = /^-?[0-9]{1,24}$/;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** A binding is an explicit choice, never proof of the NDI picture's timing. */
export function isPremiereBinding(value: unknown): value is PremiereBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return [v.bindingId, v.projectId, v.sequenceId, v.projectName, v.sequenceName].every(v => text(v, MAX_BINDING_TEXT))
    && text(v.displayFormat, MAX_DISPLAY_FORMAT)
    && typeof v.timebaseTicks === "string" && POSITIVE_TICKS.test(v.timebaseTicks)
    && typeof v.zeroPointTicks === "string" && SIGNED_TICKS.test(v.zeroPointTicks);
}

/** Display-name changes cannot retarget a marker; these six fields can. */
export function samePremiereBinding(a: PremiereBinding | null, b: PremiereBinding | null): boolean {
  return !!a && !!b && a.bindingId === b.bindingId && a.projectId === b.projectId
    && a.sequenceId === b.sequenceId && a.timebaseTicks === b.timebaseTicks
    && a.zeroPointTicks === b.zeroPointTicks && a.displayFormat === b.displayFormat;
}
