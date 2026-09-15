import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AafDocument } from "../bindings/AafDocument";
import { exportMultitrack, untimedTranscriptRows } from "../lib/multitrack";
import { multitrackAvidMarkers, multitrackExportName, multitrackPeople, multitrackScope } from "../lib/multitrack-person";
import { formatError } from "../lib/error-format";

export type MultitrackExportFormat = "txt" | "csv" | "avid";
export function useMultitrackExport(document: AafDocument) {
  const [phase, setPhase] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [status, setStatus] = useState(""), [error, setError] = useState<string | null>(null);
  const busy = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (action: () => Promise<string | null>) => {
    if (busy.current) return;
    busy.current = true; setPhase("loading"); setError(null); setStatus("");
    try { const message = await action(); if (mounted.current) { setStatus(message ?? ""); setPhase(message ? "success" : "idle"); } }
    catch (cause) { if (mounted.current) { setError(formatError(cause)); setPhase("error"); } }
    finally { busy.current = false; }
  };
  const download = (format: MultitrackExportFormat, trackIds?: string[], name = "All voices") => run(async () => {
    const scoped = multitrackScope(document, trackIds), avid = format === "avid", extension = format === "csv" ? "csv" : "txt";
    const text = avid ? multitrackAvidMarkers(scoped) : exportMultitrack(scoped, format);
    if (!text) throw new Error("No timed passages are available for markers. Download plain text to keep text needing timing review.");
    const path = await save({ defaultPath: `${multitrackExportName(document.manifest.name)} - ${multitrackExportName(name)}${avid ? " - Avid markers" : ""}.${extension}`, filters: [{ name: avid ? "Avid markers" : format === "csv" ? "CSV spreadsheet" : "Plain text", extensions: [extension] }] });
    if (!path || !mounted.current) return null;
    await invoke("write_text_to_path", { path, text, atomic: true });
    const skipped = avid ? untimedTranscriptRows(scoped).length : 0;
    return `Saved to ${path}${skipped ? `. ${skipped} untimed passages remain in plain-text exports.` : ""}`;
  });
  const downloadPeople = () => run(async () => {
    const files = multitrackPeople(document).map((person) => ({ person, text: multitrackAvidMarkers(multitrackScope(document, person.trackIds)) })).filter((file) => file.text);
    if (!files.length) throw new Error("No timed passages are available for Avid markers.");
    const folder = await open({ directory: true, multiple: false, title: "Save Avid markers by person" });
    if (typeof folder !== "string" || !mounted.current) return null;
    let saved = 0;
    try {
      for (const file of files) {
        if (!mounted.current) break;
        const name = `${multitrackExportName(document.manifest.name)} - ${multitrackExportName(file.person.name)} - Avid markers.txt`;
        await invoke("write_text_to_path", { path: `${folder.replace(/\/$/, "")}/${name}`, text: file.text, atomic: true, unique: true }); ++saved;
      }
    } catch (cause) { throw new Error(`${saved} of ${files.length} files saved in ${folder}. Export stopped: ${formatError(cause)}. Saved files are intact.`); }
    const skipped = untimedTranscriptRows(document).length;
    return `${saved} files saved in ${folder}${skipped ? `. ${skipped} untimed passages remain in plain-text exports.` : ""}`;
  });
  return { phase, status, error, download, downloadPeople, clearResolution: () => setPhase("idle") };
}
