import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AafDocument } from "../bindings/AafDocument";
import { exportMultitrack, untimedTranscriptRows } from "../lib/multitrack";
import { multitrackAvidMarkers, multitrackExportName, multitrackPeople, multitrackScope } from "../lib/multitrack-person";
import { formatError } from "../lib/error-format";
import { multitrackPrintDoc, multitrackSrt } from "../lib/multitrack-export";

export type MultitrackExportFormat = "txt" | "csv" | "avid" | "srt" | "pdf" | "print";
function exportNotes(document: AafDocument, format: MultitrackExportFormat): string {
  const skipped = format === "avid" || format === "srt" ? untimedTranscriptRows(document).length : 0;
  const legacy = format === "avid" && document.transcripts.some((item) => document.manifest.tracks.find((track) => track.id === item.track_id)?.physical_track_number == null);
  return `${skipped ? `. ${skipped} untimed passages remain in text, CSV and PDF exports.` : ""}${legacy ? ". Older import: markers use the audio-lane numbers shown in Sauce Bunny." : ""}${format === "srt" ? ". SRT timing starts at sequence zero; simultaneous voices share captions." : ""}`;
}
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
    let scoped = multitrackScope(document, trackIds);
    const avid = format === "avid";
    if (format === "print") {
      await invoke("print_transcript", { html: multitrackPrintDoc(scoped, name) });
      return "Print dialog opened. Confirm printing in the dialog.";
    }
    const extension = avid ? "txt" : format;
    const path = await save({ defaultPath: `${multitrackExportName(document.manifest.name)} - ${multitrackExportName(name)}${avid ? " - Avid markers" : ""}.${extension}`, filters: [{ name: avid ? "Avid markers" : format === "csv" ? "CSV spreadsheet" : format === "srt" ? "SRT captions" : format === "pdf" ? "PDF document" : "Plain text", extensions: [extension] }] });
    if (!path || !mounted.current) return null;
    // A track/date can finish saving while Save As is open. Export the native
    // committed document, not a render captured before the dialog appeared.
    scoped = multitrackScope(await invoke<AafDocument>("aaf_open", { documentId: document.id }), trackIds);
    const text = format === "pdf" ? multitrackPrintDoc(scoped, name) : avid ? multitrackAvidMarkers(scoped) : format === "srt" ? multitrackSrt(scoped) : exportMultitrack(scoped, format);
    if (!text) throw new Error("No timed passages are available for this export. Download plain text to keep text needing timing review.");
    if (format === "pdf") await invoke("export_transcript_pdf", { path, html: text });
    else await invoke("write_text_to_path", { path, text, atomic: true });
    return `Saved to ${path}${exportNotes(scoped, format)}`;
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
    return `${saved} files saved in ${folder}${exportNotes(document, "avid")}`;
  });
  return { phase, status, error, download, downloadPeople, clearResolution: () => setPhase("idle") };
}
