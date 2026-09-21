import type { AafDocument } from "../bindings/AafDocument";
import { pathKey } from "./repath";

export function sourceFilename(document: AafDocument): string {
  return pathKey(document.source_path).split("/").pop() || document.manifest.name;
}
export function recordingDates(document: AafDocument): string[] {
  return [...new Set((document.manifest.recording_dates ?? []).map(item => item.date))].sort();
}
export function shootDate(document: AafDocument): string {
  if (document.shoot_date_override != null) return document.shoot_date_override || "Not provided";
  return recordingDates(document).join(", ") || "Not provided";
}
export function transcriptMetadata(document: AafDocument): string {
  return `Source: ${sourceFilename(document)}\nSequence: ${document.manifest.name}\nShoot date: ${shootDate(document)}${document.shoot_date_override != null ? " (user supplied)" : recordingDates(document).length ? " (source metadata)" : ""}`;
}
