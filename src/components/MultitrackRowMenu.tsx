import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { formatError } from "../lib/error-format";
import { hidePaths } from "../lib/library-hidden";
import { documentKey, type MultitrackLibraryEntry } from "../lib/transcript-library";
import { MultitrackDocumentDialog } from "./MultitrackDocumentDialog";

export type DocumentMenuTarget = { entry: MultitrackLibraryEntry; x: number; y: number };

/**
 * Right-click on an AAF Audio transcript in Transcripts: what a transcript
 * row offers, in the terms of a document that is not a file. Rename and Move
 * open a dialog; Remove takes it off this page only (Settings ▸ General brings
 * removed items back), and AAF Audio and String Outs still list it.
 */
export function MultitrackRowMenu({ target, projects, filedIn, libraryPath, onClose, onOpen, onOpenInStringOuts }: {
  target: DocumentMenuTarget; projects: { folder: string; title: string }[]; filedIn: string | null; libraryPath: string;
  onClose: () => void; onOpen: (id: string) => void; onOpenInStringOuts?: (id: string) => void;
}) {
  const [mode, setMode] = useState<"menu" | "rename" | "move">("menu");
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  useMenuKeys(menu, mode === "menu", onClose);
  const { entry } = target;
  if (mode !== "menu") return <MultitrackDocumentDialog mode={mode} entry={entry} projects={projects} filedIn={filedIn} libraryPath={libraryPath} onClose={onClose} />;
  const reveal = async () => {
    try { await invoke("reveal_in_finder", { path: entry.summary.source_path }); onClose(); }
    catch (cause) { setError(formatError(cause)); }
  };
  const run = (action: () => void) => () => { onClose(); action(); };
  const left = Math.max(8, Math.min(target.x, window.innerWidth - 240));
  const top = Math.max(8, Math.min(target.y, window.innerHeight - 260));
  return createPortal(<>
    <div className="cp-rowmenu-scrim" onMouseDown={onClose} />
    <div ref={menu} className="cp-rowmenu" style={{ left, top }} role="menu" aria-label={entry.title}>
      <button role="menuitem" onClick={() => setMode("rename")}>Rename…</button>
      <button role="menuitem" onClick={() => setMode("move")}>Move to project…</button>
      <button role="menuitem" onClick={run(() => onOpen(entry.id))}>Open in AAF Audio</button>
      {onOpenInStringOuts && <button role="menuitem" onClick={run(() => onOpenInStringOuts(entry.id))}>Open in String Outs</button>}
      <button role="menuitem" onClick={() => void reveal()}>Reveal AAF in Finder</button>
      <button role="menuitem" onClick={run(() => hidePaths([documentKey(entry.id)]))}>Remove from Transcripts</button>
      {error && <p className="cp-rowmenu-err" role="alert">{error}</p>}
    </div>
  </>, document.body);
}
