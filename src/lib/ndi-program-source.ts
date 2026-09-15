import type { ObsSelection } from "../bindings/ObsSelection";

export type NdiProgramSource = { kind: "ndi"; name: string }
  | { kind: "capture"; selection: ObsSelection };

export const isDisplayCapture = (selection: ObsSelection): selection is Extract<ObsSelection, { kind: "display" }> =>
  "kind" in selection && selection.kind === "display";

export const copyCaptureSelection = (selection: ObsSelection): ObsSelection => isDisplayCapture(selection)
  ? { ...selection, geometry: { ...selection.geometry }, crop: { ...selection.crop } }
  : { ...selection, crop: { ...selection.crop } };

const displayUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unsignedId = (value: number) => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const displayDimension = (value: number) => Number.isInteger(value) && value >= 2 && value <= 16_384;
type DisplayCapture = Extract<ObsSelection, { kind: "display" }>;
/** Match the native sauce_display_crop_make inward backing-pixel boundary.
 * Comparing normalized JSON decimals alone rejects harmless f64 parser drift.
 * Never use an epsilon: a change across even one accepted pixel is different.
 */
const displayPixelEdges = ({ crop, geometry }: DisplayCapture) => [
  Math.ceil(crop.x * geometry.pixelWidth), Math.ceil(crop.y * geometry.pixelHeight),
  Math.floor((crop.x + crop.width) * geometry.pixelWidth), Math.floor((crop.y + crop.height) * geometry.pixelHeight),
];

export function validCaptureSelection(selection: ObsSelection): boolean {
  if (!selection || typeof selection !== "object" || !selection.crop) return false;
  const { crop } = selection;
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0
    || crop.x + crop.width > 1 || crop.y + crop.height > 1) return false;
  if (isDisplayCapture(selection)) {
    const { geometry } = selection;
    return typeof selection.displayUuid === "string" && displayUuid.test(selection.displayUuid)
      && unsignedId(selection.displayId) && typeof selection.audio === "boolean"
      && !!geometry && [geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)
      && Math.abs(geometry.x) <= 1_000_000 && Math.abs(geometry.y) <= 1_000_000
      && [geometry.width, geometry.height, geometry.pixelWidth, geometry.pixelHeight].every(displayDimension)
      && crop.width * geometry.width > 16 && crop.height * geometry.height > 16
      && !["application", "process", "window"].some(key => key in selection);
  }
  if (["kind", "displayUuid", "displayId", "geometry"].some(key => key in selection)) return false;
  const { application, process, window } = selection;
  return typeof application === "string" && /^[a-z0-9._-]{3,256}$/i.test(application) && application.includes(".")
    && (selection.audio == null || typeof selection.audio === "boolean")
    && Number.isInteger(process) && process > 0 && process <= 0x7fffffff && unsignedId(window);
}

/** Private local lookup only. Never use this identity as a room review key. */
export const captureSourceIdentity = (selection: ObsSelection): string => {
  const { crop } = selection;
  if (isDisplayCapture(selection)) {
    const { geometry } = selection;
    return JSON.stringify(["display", selection.displayUuid, selection.displayId,
      geometry.x, geometry.y, geometry.width, geometry.height, geometry.pixelWidth, geometry.pixelHeight,
      crop.x, crop.y, crop.width, crop.height]);
  }
  // Preserve the original window key so existing review passes keep their notes.
  return JSON.stringify([selection.application, selection.process, selection.window, crop.x, crop.y, crop.width, crop.height]);
};

export function sameProgramSource(first: NdiProgramSource, second: NdiProgramSource): boolean {
  if (first.kind === "ndi") return second.kind === "ndi" && first.name === second.name;
  if (second.kind !== "capture" || !validCaptureSelection(first.selection) || !validCaptureSelection(second.selection)
    || (first.selection.audio ?? true) !== (second.selection.audio ?? true)) return false;
  const a = first.selection, b = second.selection;
  if (isDisplayCapture(a)) {
    if (!isDisplayCapture(b) || a.displayUuid !== b.displayUuid || a.displayId !== b.displayId
      || !(["x", "y", "width", "height", "pixelWidth", "pixelHeight"] as const)
        .every(key => a.geometry[key] === b.geometry[key])) return false;
    const firstEdges = displayPixelEdges(a), secondEdges = displayPixelEdges(b);
    return firstEdges.every((edge, index) => edge === secondEdges[index]);
  }
  // Window review identity and its established exact-crop behavior are unchanged.
  return !isDisplayCapture(b) && captureSourceIdentity(a) === captureSourceIdentity(b);
}
