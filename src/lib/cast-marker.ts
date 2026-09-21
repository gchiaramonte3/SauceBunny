import type { AafGender } from "../bindings/AafGender";
import type { AafMarkerColor } from "../bindings/AafMarkerColor";

export const CAST_GENDERS = ["unspecified", "man", "woman", "nonbinary", "other"] as const satisfies readonly AafGender[];
export const AVID_COLORS = ["red", "green", "blue", "cyan", "yellow", "magenta", "white", "black", "purple", "violet", "pink", "denim", "forest", "orange", "gold", "grey"] as const satisfies readonly AafMarkerColor[];
export function assignedMarkerColor(gender: AafGender, previous?: AafMarkerColor | null): AafMarkerColor | undefined {
  return gender === "man" ? "blue" : gender === "woman" ? "pink" : previous ?? undefined;
}
export function isGender(value: unknown): value is AafGender { return CAST_GENDERS.some((item) => item === value); }
export function isMarkerColor(value: unknown): value is AafMarkerColor { return AVID_COLORS.some((item) => item === value); }
export function preferenceLabel(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }
