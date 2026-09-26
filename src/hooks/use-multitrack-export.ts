import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AafDocument } from "../bindings/AafDocument";
import { exportMultitrack, untimedTranscriptRows } from "../lib/multitrack";
import { multitrackAvidMarkers, multitrackExportName, multitrackScope } from "../lib/multitrack-person";
import { hasGroupMicrophones, multitrackAvidFiles, multitrackAvidGuide, needsMicrophoneFiles } from "../lib/multitrack-avid-files";
import { alternativeLane } from "../lib/multitrack-graph";
import { formatError } from "../lib/error-format";
import { multitrackPrintDoc, multitrackSrt } from "../lib/multitrack-export";

export type MultitrackExportFormat = "txt" | "csv" | "avid" | "srt" | "pdf" | "print";
function exportNotes(document: AafDocument, format: MultitrackExportFormat): string {
  const skipped = format === "avid" || format === "srt" ? untimedTranscriptRows(document).length : 0;
  const legacy = format === "avid" && document.transcripts.some((item) => document.manifest.tracks.find((track) => track.id === item.track_id)?.physical_track_number == null);
  const alternatives = format === "avid" && document.transcripts.some(item => alternativeLane(document, item.track_id));
  return `${skipped ? `. ${skipped} untimed passages remain in text, CSV and PDF exports.` : ""}${legacy ? ". Older import: markers use the original sequence-lane numbers shown in Sauce Bunny." : ""}${alternatives ? ". Group microphones target their parent sequence track, not the source group. Import one microphone file per parent track at a time." : ""}${format === "srt" ? ". SRT timing starts at sequence zero; simultaneous voices share captions." : ""}`;
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
  const saveAvidFiles = async (trackIds: string[], byMicrophone: boolean) => {
    const folder = await open({ directory: true, multiple: false, title: byMicrophone ? "Save Avid markers by microphone (parent sequence tracks)" : "Save Avid markers by person" });
    if (typeof folder !== "string" || !mounted.current) return null;
    const committed = await invoke<AafDocument>("aaf_open", { documentId: document.id });
    if (!mounted.current) return null;
    const files = multitrackAvidFiles(committed, trackIds, byMicrophone);
    if (!files.length) throw new Error("No timed passages are available for Avid markers.");
    const saved: { path: string; trackIds: string[] }[] = [];
    try {
      for (const file of files) {
        if (!mounted.current) return null;
        const path = await invoke<string>("write_text_to_path", { path: `${folder.replace(/\/$/, "")}/${file.name}`, text: file.text, atomic: true, unique: true });
        saved.push({ path, trackIds: file.trackIds });
      }
      if (byMicrophone && mounted.current) await invoke("write_text_to_path", {
        path: `${folder.replace(/\/$/, "")}/${multitrackExportName(committed.manifest.name)} - Avid import guide.md`,
        text: multitrackAvidGuide(committed, saved), atomic: true, unique: true,
      });
    } catch (cause) { throw new Error(`${saved.length} of ${files.length} marker files saved in ${folder}. Export stopped: ${formatError(cause)}. Saved files are intact.`); }
    return `${saved.length} files saved in ${folder}${exportNotes(multitrackScope(committed, trackIds), "avid")}`;
  };
  const download = (format: MultitrackExportFormat, trackIds?: string[], name = "All voices") => run(async () => {
    const ids = trackIds ? [...trackIds] : document.manifest.tracks.map(track => track.id);
    let scoped = multitrackScope(document, ids);
    const avid = format === "avid";
    if (avid && needsMicrophoneFiles(document, ids)) return saveAvidFiles(ids, true);
    if (format === "print") {
      await invoke("print_transcript", { html: multitrackPrintDoc(scoped, name) });
      return "Print dialog opened. Confirm printing in the dialog.";
    }
    const extension = avid ? "txt" : format;
    const path = await save({ ...(avid && ids.some(id => alternativeLane(document, id)) ? { title: "Save Avid markers (parent sequence track)" } : {}), defaultPath: `${multitrackExportName(document.manifest.name)} - ${multitrackExportName(name)}${avid ? " - Avid markers" : ""}.${extension}`, filters: [{ name: avid ? "Avid markers" : format === "csv" ? "CSV spreadsheet" : format === "srt" ? "SRT captions" : format === "pdf" ? "PDF document" : "Plain text", extensions: [extension] }] });
    if (!path || !mounted.current) return null;
    // A track/date can finish saving while Save As is open. Export the native
    // committed document, not a render captured before the dialog appeared.
    scoped = multitrackScope(await invoke<AafDocument>("aaf_open", { documentId: document.id }), ids);
    if (!mounted.current) return null;
    const text = format === "pdf" ? multitrackPrintDoc(scoped, name) : avid ? multitrackAvidMarkers(scoped) : format === "srt" ? multitrackSrt(scoped) : exportMultitrack(scoped, format);
    if (!text) throw new Error("No timed passages are available for this export. Download plain text to keep text needing timing review.");
    if (format === "pdf") await invoke("export_transcript_pdf", { path, html: text });
    else await invoke("write_text_to_path", { path, text, atomic: true });
    return `Saved to ${path}${exportNotes(scoped, format)}`;
  });
  const downloadPeople = () => run(() => saveAvidFiles(document.manifest.tracks.map(track => track.id), hasGroupMicrophones(document)));
  return { phase, status, error, download, downloadPeople, clearResolution: () => setPhase("idle") };
}
