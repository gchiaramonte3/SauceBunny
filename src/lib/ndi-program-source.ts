import type { ObsSelection } from "../bindings/ObsSelection";

export type NdiProgramSource = { kind: "ndi"; name: string }
  | { kind: "capture"; selection: ObsSelection };

export const copyCaptureSelection = (selection: ObsSelection): ObsSelection => ({
  ...selection, crop: { ...selection.crop },
});

export function validCaptureSelection(selection: ObsSelection): boolean {
  if (!selection || !selection.crop) return false;
  const { application, process, window, crop } = selection;
  return typeof application === "string" && /^[a-z0-9.-]{3,256}$/i.test(application) && application.includes(".")
    && Number.isInteger(process) && process > 0 && process <= 0x7fffffff
    && Number.isInteger(window) && window > 0 && window <= 0xffffffff
    && [crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    && crop.x >= 0 && crop.y >= 0 && crop.width > 0 && crop.height > 0
    && crop.x + crop.width <= 1 && crop.y + crop.height <= 1;
}

/** Private local lookup only. Never use this identity as a room review key. */
export const captureSourceIdentity = ({ application, process, window, crop }: ObsSelection): string =>
  JSON.stringify([application, process, window, crop.x, crop.y, crop.width, crop.height]);

export function sameProgramSource(first: NdiProgramSource, second: NdiProgramSource): boolean {
  if (first.kind === "ndi") return second.kind === "ndi" && first.name === second.name;
  return second.kind === "capture" && captureSourceIdentity(first.selection) === captureSourceIdentity(second.selection);
}
