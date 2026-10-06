import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { AafDocument } from "../bindings/AafDocument";
import { useModalFocus } from "../hooks/use-modal-focus";
import { formatError } from "../lib/error-format";
import { documentName } from "../lib/multitrack";
import type { MultitrackLibraryEntry } from "../lib/transcript-library";
import { fileDocuments } from "../lib/transcript-project-store";
import { notifyTranscriptsChanged } from "../lib/transcript-history";
import { IconAlert } from "./Icons";

/**
 * Rename an AAF Audio transcript, or file it in a project. Neither touches a
 * file: a title is saved in the document (its sequence's name, which a
 * re-import finds it by, stays), and a project holds documents by reference.
 */
export function MultitrackDocumentDialog({ mode, entry, projects, filedIn, libraryPath, onClose }: {
  mode: "rename" | "move"; entry: MultitrackLibraryEntry;
  /** Projects to file in, by folder, with the title each shows. */
  projects: { folder: string; title: string }[];
  /** The project it is filed in now, if any. */
  filedIn: string | null; libraryPath: string; onClose: () => void;
}) {
  const [name, setName] = useState(documentName(entry.summary));
  const [newFolder, setNewFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null), titleId = useId();
  useModalFocus(true, dialog);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  const rename = async () => {
    setBusy(true); setError(null);
    try { await invoke<AafDocument>("aaf_rename", { documentId: entry.id, title: name.trim().normalize("NFC") || null }); onClose(); }
    catch (cause) { setError(formatError(cause)); setBusy(false); }
  };
  const file = (folder: string | null) => { fileDocuments([entry.id], folder); onClose(); };
  const createAndFile = async () => {
    setBusy(true); setError(null);
    try {
      const dir = await invoke<string>("create_transcript_folder", { libraryPath, name: newFolder.trim() });
      fileDocuments([entry.id], dir.replace(/\/+$/, "").split("/").pop() ?? newFolder.trim());
      // The page lists projects from the folders on disk: have it look again.
      notifyTranscriptsChanged();
      onClose();
    } catch (cause) { setError(formatError(cause)); setBusy(false); }
  };
  return createPortal(
    <div className="cp-rowmenu-scrim modal" onMouseDown={() => { if (!busy) onClose(); }}>
      <div ref={dialog} tabIndex={-1} className="cp-rowmenu-dialog" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {mode === "rename" ? <>
          <h4 id={titleId} className="cp-rowmenu-title">Rename transcript</h4>
          <input className="cp-rowmenu-input" aria-label="Name" value={name} autoFocus spellCheck={false} maxLength={200}
            onChange={(event) => { setName(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === "Enter") void rename(); }} />
          <p className="cp-rowmenu-warn"><IconAlert size={13} />Only the name shown in Sauce Bunny changes. The sequence keeps its name, {entry.summary.name}, which is what Avid and a new import go by. Leave this empty to use it.</p>
          {error && <p className="cp-rowmenu-err" role="alert">{error}</p>}
          <div className="cp-rowmenu-actions">
            <button className="btn btn-ghost cp-tx-iconbtn" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn cp-tx-iconbtn" onClick={() => void rename()} disabled={busy}>Rename</button>
          </div>
        </> : <>
          <h4 id={titleId} className="cp-rowmenu-title">Move “{entry.title}” to a project</h4>
          <div className="cp-rowmenu-folders">
            {projects.map((project) => <button key={project.folder} className="cp-rowmenu-folder" aria-current={project.folder === filedIn ? "true" : undefined}
              onClick={() => file(project.folder)} disabled={busy || project.folder === filedIn}>{project.title}</button>)}
            {filedIn && <button className="cp-rowmenu-folder" onClick={() => file(null)} disabled={busy}>No project (back to AAF Audio)</button>}
          </div>
          <div className="cp-rowmenu-newfolder">
            <input className="cp-rowmenu-input" aria-label="New project name" value={newFolder} placeholder="New project name…" spellCheck={false}
              onChange={(event) => { setNewFolder(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === "Enter" && newFolder.trim()) void createAndFile(); }} />
            <button className="btn cp-tx-iconbtn" onClick={() => void createAndFile()} disabled={busy || !newFolder.trim()}>Create &amp; move</button>
          </div>
          <p className="cp-rowmenu-warn"><IconAlert size={13} />Nothing moves on disk: the transcript stays in AAF Audio, and the project lists it.</p>
          {error && <p className="cp-rowmenu-err" role="alert">{error}</p>}
          <div className="cp-rowmenu-actions"><button className="btn btn-ghost cp-tx-iconbtn" onClick={onClose} disabled={busy}>Cancel</button></div>
        </>}
      </div>
    </div>,
    document.body,
  );
}
