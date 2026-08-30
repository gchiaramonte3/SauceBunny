import { useEffect, useId, useRef, useState } from "react";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import { IconAlert } from "./Icons";
import { useModalFocus } from "../hooks/use-modal-focus";

export type ProjectMenuTarget = {
  folder: string;
  title: string;
  /** Transcripts currently in this project — the candidates for its picture. */
  items: { path: string; title: string }[];
  /** The transcript supplying the picture right now (chosen or fallen back to). */
  posterFrom: string | null;
  x: number;
  y: number;
};

type Props = {
  target: ProjectMenuTarget;
  libraryPath: string;
  onClose: () => void;
  /** Folder renamed on disk — carry the metadata and re-scan. */
  onRenamed: (from: string, to: string) => void;
  /** Folder gone from disk — forget it and re-scan. */
  onDeleted: (folder: string) => void;
  /** Pick which transcript supplies the picture (null = back to newest). */
  onPickPoster: (folder: string, transcriptPath: string | null) => void;
};

/**
 * The actions on a project: rename it, choose its picture, delete it.
 *
 * Rename and delete move directories on disk, so each is a dialog with the
 * consequence written out rather than a menu item that acts on click. Delete
 * in particular refuses in Rust while transcripts remain; this shows that
 * refusal as the sentence it is instead of an error toast, because "move them
 * out first" is an instruction, not a failure.
 */
export function ProjectMenu({ target, libraryPath, onClose, onRenamed, onDeleted, onPickPoster }: Props) {
  const [mode, setMode] = useState<"menu" | "rename" | "poster" | "delete">("menu");
  const [nameInput, setNameInput] = useState(target.title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(mode !== "menu", dialogRef);
  // The menu half needs the OTHER keyboard model: arrows between items,
  // Home/End, type-ahead, Tab to leave. It is portalled to document.body,
  // so without focus moving in on open there is no way to reach it at all.
  const menuRef = useRef<HTMLDivElement>(null);
  /**
   * The dialog's accessible name.
   *
   * It declared role="dialog" aria-modal="true" with NEITHER aria-label nor
   * aria-labelledby, while rendering an <h4> title two lines below that
   * nothing pointed at - so a screen reader announced "dialog" and left the
   * user to work out which one. In this file that includes the DELETE
   * confirmation.
   *
   * ONE id for all modes: they are mutually exclusive, so exactly one <h4>
   * is ever in the tree, and the mode is already in the title text ("Rename
   * project", "Delete X"), which is what makes the announcement distinct.
   *
   * modal-focus-contract parses this very tag for four other properties and
   * never asked for a name; it does now.
   */
  const titleId = useId();
  useMenuKeys(menuRef, mode === "menu", onClose);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function doRename() {
    const name = nameInput.trim();
    if (!name) { setErr("Enter a name."); return; }
    if (name === target.folder) { onClose(); return; }
    setBusy(true); setErr(null);
    try {
      await invoke<string>("rename_transcript_folder", {
        libraryPath, folder: target.folder, newName: name,
      });
      onRenamed(target.folder, name);
      onClose();
    } catch (e) { setErr(formatError(e)); setBusy(false); }
  }

  async function doDelete() {
    setBusy(true); setErr(null);
    try {
      await invoke("delete_transcript_folder", { libraryPath, folder: target.folder });
      onDeleted(target.folder);
      onClose();
    } catch (e) { setErr(formatError(e)); setBusy(false); }
  }

  if (mode === "menu") {
    const left = Math.min(target.x, window.innerWidth - 210);
    const top = Math.min(target.y, window.innerHeight - 130);
    return createPortal(
      <>
        <div className="cp-rowmenu-scrim" onMouseDown={onClose} />
        <div ref={menuRef} className="cp-rowmenu" style={{ left, top }} role="menu">
          <button role="menuitem" onClick={() => { setNameInput(target.title); setErr(null); setMode("rename"); }}>Rename project…</button>
          <button role="menuitem" disabled={target.items.length === 0} onClick={() => { setErr(null); setMode("poster"); }}>Choose picture…</button>
          <button role="menuitem" onClick={() => { setErr(null); setMode("delete"); }}>Delete project…</button>
        </div>
      </>,
      document.body,
    );
  }

  return createPortal(
    <div className="cp-rowmenu-scrim modal" onMouseDown={onClose}>
      <div ref={dialogRef} tabIndex={-1} className="cp-rowmenu-dialog" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {mode === "rename" && (
          <>
            <h4 id={titleId} className="cp-rowmenu-title">Rename project</h4>
            <input
              className="cp-rowmenu-input" value={nameInput} autoFocus spellCheck={false}
              onChange={(e) => { setNameInput(e.target.value); setErr(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") void doRename(); }}
            />
            <p className="cp-rowmenu-warn">
              <IconAlert size={13} />
              This renames the folder on disk, so the transcripts inside it move with it and keep working. Its picture and colour follow.
            </p>
            {err && <p className="cp-rowmenu-err">{err}</p>}
            <div className="cp-rowmenu-actions">
              <button className="btn btn-ghost cp-tx-iconbtn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn cp-tx-iconbtn" onClick={doRename} disabled={busy || !nameInput.trim()}>Rename</button>
            </div>
          </>
        )}
        {mode === "poster" && (
          <>
            <h4 id={titleId} className="cp-rowmenu-title">Picture for “{target.title}”</h4>
            <div className="cp-rowmenu-folders">
              {target.items.map((t) => (
                <button
                  key={t.path}
                  className={"cp-rowmenu-folder" + (t.path === target.posterFrom ? " on" : "")}
                  onClick={() => { onPickPoster(target.folder, t.path); onClose(); }}
                >{t.title}</button>
              ))}
            </div>
            <p className="cp-rowmenu-warn">
              <IconAlert size={13} />
              The project shows the picture of the transcript you pick. Without one it shows the newest, which changes as you add transcripts.
            </p>
            <div className="cp-rowmenu-actions">
              <button className="btn btn-ghost cp-tx-iconbtn" onClick={() => { onPickPoster(target.folder, null); onClose(); }}>Use the newest</button>
              <button className="btn cp-tx-iconbtn" onClick={onClose}>Done</button>
            </div>
          </>
        )}
        {mode === "delete" && (
          <>
            <h4 id={titleId} className="cp-rowmenu-title">Delete “{target.title}”</h4>
            <p className="cp-rowmenu-warn">
              <IconAlert size={13} />
              {target.items.length === 0
                ? "This removes the empty folder from disk. Nothing else is touched."
                : `This project holds ${target.items.length} transcript${target.items.length === 1 ? "" : "s"}. Move them out first. Deleting is refused while they are here.`}
            </p>
            {err && <p className="cp-rowmenu-err">{err}</p>}
            <div className="cp-rowmenu-actions">
              <button className="btn btn-ghost cp-tx-iconbtn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn cp-tx-iconbtn" onClick={doDelete} disabled={busy || target.items.length > 0}>Delete folder</button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
