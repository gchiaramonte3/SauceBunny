import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import { IconAlert } from "./Icons";
import type { TranscriptHistoryEntry } from "../lib/transcript-history";
import { useModalFocus } from "../hooks/use-modal-focus";

export type RowMenuTarget = { entry: TranscriptHistoryEntry; title: string; x: number; y: number };

type Props = {
  target: RowMenuTarget;
  onClose: () => void;
  /** Existing destination folders (label + absolute dir); "Library root" included. */
  folderOptions: { label: string; dir: string }[];
  /** The transcript library root, for creating a new folder. */
  libraryPath: string;
  onRename: (entry: TranscriptHistoryEntry, newStem: string) => Promise<void>;
  onMove: (entry: TranscriptHistoryEntry, destDir: string) => Promise<void>;
};

/**
 * Right-click menu for a transcript row + its Rename / Move dialogs. Rename and
 * Move both mutate files on disk (via App's handlers → Rust), so each is a
 * deliberate dialog with a warning, never a silent action. Kept a sibling so
 * TranscriptReader stays a lean layout shell.
 */
export function ReaderRowMenu({ target, onClose, folderOptions, libraryPath, onRename, onMove }: Props) {
  const [mode, setMode] = useState<"menu" | "rename" | "move">("menu");
  const [nameInput, setNameInput] = useState(target.title);
  const [newFolder, setNewFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(true, dialogRef);

  // Outside-click / Escape closes the whole thing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Same verb the library's card menu offers. It was absent here, so the one
   *  place you manage transcripts could not show you where they live. */
  async function revealInFinder() {
    try { await invoke("reveal_in_finder", { path: target.entry.srtPath }); }
    catch (e) { setErr(formatError(e)); return; }
    onClose();
  }

  async function doRename() {
    const stem = nameInput.trim();
    if (!stem) { setErr("Enter a name."); return; }
    setBusy(true); setErr(null);
    try { await onRename(target.entry, stem); onClose(); }
    catch (e) { setErr(formatError(e)); setBusy(false); }
  }
  async function doMove(destDir: string) {
    setBusy(true); setErr(null);
    try { await onMove(target.entry, destDir); onClose(); }
    catch (e) { setErr(formatError(e)); setBusy(false); }
  }
  async function createAndMove() {
    const name = newFolder.trim();
    if (!name) { setErr("Enter a folder name."); return; }
    setBusy(true); setErr(null);
    try {
      const dir = await invoke<string>("create_transcript_folder", { libraryPath, name });
      await onMove(target.entry, dir);
      onClose();
    } catch (e) { setErr(formatError(e)); setBusy(false); }
  }

  // The bare context menu, positioned at the cursor (clamped to the viewport).
  //
  // PORTALED, like CueSelectionMenu and LibraryCardMenu. This one used to
  // render inline in the reader's tree at z-index 401 while the app stacks
  // layers up to 10002, so the menu and its Rename dialog were in the DOM and
  // underneath something - which from the outside is a rename that does
  // nothing. `position: fixed` was also anchored to whatever ancestor happened
  // to establish a containing block rather than to the viewport, so the cursor
  // coordinates it is positioned from could put it somewhere else entirely.
  if (mode === "menu") {
    const left = Math.min(target.x, window.innerWidth - 200);
    const top = Math.min(target.y, window.innerHeight - 110);
    return createPortal(
      <>
        <div className="cp-rowmenu-scrim" onMouseDown={onClose} />
        <div className="cp-rowmenu" style={{ left, top }} role="menu">
          <button role="menuitem" onClick={() => { setNameInput(target.title); setErr(null); setMode("rename"); }}>Rename…</button>
          <button role="menuitem" onClick={() => { setErr(null); setMode("move"); }}>Move to folder…</button>
          <button role="menuitem" onClick={() => { void revealInFinder(); }}>Reveal in Finder</button>
        </div>
      </>,
      document.body,
    );
  }

  const ext = target.entry.srtPath.split(".").pop() || "srt";
  return createPortal(
    <div className="cp-rowmenu-scrim modal" onMouseDown={onClose}>
      <div ref={dialogRef} tabIndex={-1} className="cp-rowmenu-dialog" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {mode === "rename" ? (
          <>
            <h4 className="cp-rowmenu-title">Rename transcript</h4>
            <input
              className="cp-rowmenu-input" value={nameInput} autoFocus spellCheck={false}
              onChange={(e) => { setNameInput(e.target.value); setErr(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void doRename(); }}
            />
            <p className="cp-rowmenu-warn">
              <IconAlert size={13} />
              This renames the file on disk to <b>{(nameInput.trim() || "…")}.{ext}</b>. Its speaker labels and analysis move with it; the source video is untouched.
            </p>
            {err && <p className="cp-rowmenu-err">{err}</p>}
            <div className="cp-rowmenu-actions">
              <button className="btn btn-ghost cp-tx-iconbtn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn cp-tx-iconbtn" onClick={doRename} disabled={busy || !nameInput.trim()}>Rename</button>
            </div>
          </>
        ) : (
          <>
            <h4 className="cp-rowmenu-title">Move “{target.title}”</h4>
            <div className="cp-rowmenu-folders">
              {folderOptions.map((f) => (
                <button key={f.dir} className="cp-rowmenu-folder" onClick={() => doMove(f.dir)} disabled={busy}>{f.label}</button>
              ))}
            </div>
            <div className="cp-rowmenu-newfolder">
              <input
                className="cp-rowmenu-input" value={newFolder} placeholder="New folder name…" spellCheck={false}
                onChange={(e) => { setNewFolder(e.target.value); setErr(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") void createAndMove(); }}
              />
              <button className="btn cp-tx-iconbtn" onClick={createAndMove} disabled={busy || !newFolder.trim()}>Create &amp; move</button>
            </div>
            <p className="cp-rowmenu-warn">
              <IconAlert size={13} />
              This moves the transcript file (and its sidecars) on disk. The source video is untouched.
            </p>
            {err && <p className="cp-rowmenu-err">{err}</p>}
            <div className="cp-rowmenu-actions">
              <button className="btn btn-ghost cp-tx-iconbtn" onClick={onClose} disabled={busy}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
