import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/use-modal-focus";
import { IconAlert } from "./Icons";
import type { LibraryFolder } from "../types";

/**
 * File one or more library files into a folder, without a pointer.
 *
 * THE DRAG'S TWIN. Dragging a card onto a folder is the fast way; this is the
 * way that exists at all for anyone not using a mouse. That rule is the
 * project's, not an invention here - `e2e/transcript-drag.spec.ts` states it
 * outright about the same gesture on the transcript picker: "the drag is an
 * addition to a menu item, never the only route". The Library shipped the drag
 * first and this second, which is the wrong order, and this closes it.
 *
 * The menu item it hangs off already existed: `LibraryCardMenu` has rendered
 * "Move to folder…" behind an `onMove` prop the whole time, and the Library
 * was the one pane that never passed it.
 *
 * Modelled on FrameMoveDialog down to the class names, because it is the same
 * act on the same kind of thing - so it needed no new styles.
 *
 * Destinations are the CURRENT folder's subfolders: exactly the set the drag
 * can reach, so the two routes cannot offer different answers.
 */
export function LibraryMoveDialog({ paths, folders, onMove, onCreateFolder, onClose }: {
  /** Absolute paths being filed. More than one when a selection is moved. */
  paths: readonly string[];
  /** Subfolders of the folder now open - the drag's drop targets. */
  folders: readonly LibraryFolder[];
  onMove: (dest: string, paths: readonly string[]) => void;
  /** Make a subfolder here and file these into it. Resolves to a refusal, or
   *  null when it worked. Absent = no route, so the field is not offered. */
  onCreateFolder?: (name: string, paths: readonly string[]) => Promise<string | null>;
  onClose: () => void;
}) {
  // aria-modal claims everything outside is inert, so focus has to be trapped
  // and restored - the house hook does both.
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialogRef);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  const makeAndMove = async () => {
    if (!onCreateFolder || busy) return;
    setBusy(true);
    setRefusal(null);
    const why = await onCreateFolder(newName, paths);
    if (why) { setRefusal(why); setBusy(false); return; }
    onClose();
  };

  const go = (dest: string) => {
    setBusy(true);
    onMove(dest, paths);
    onClose();
  };

  const title = paths.length === 1
    ? `Move “${paths[0].split("/").pop() ?? paths[0]}”`
    : `Move ${paths.length} files`;

  return createPortal(
    <div className="cp-rowmenu-scrim modal" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* tabIndex={-1} so the trap has somewhere to put focus on open; without
          it the first Tab escapes the scrim. */}
      <div ref={dialogRef} tabIndex={-1} className="cp-rowmenu-dialog" role="dialog" aria-modal="true" aria-label="Move to folder">
        <h4 className="cp-rowmenu-title">{title}</h4>
        {folders.length === 0 && !onCreateFolder ? (
          // Only when there is genuinely no route. With onCreateFolder wired,
          // the field below IS the answer, and this used to name a control that
          // lived on a different surface behind this modal - an instruction you
          // could not follow without cancelling first.
          <p className="cp-rowmenu-warn">
            <IconAlert size={13} />
            This folder has no subfolders yet. Make one with “New folder” first.
          </p>
        ) : folders.length === 0 ? null : (
          <div className="cp-rowmenu-folders">
            {folders.map((f) => (
              <button
                key={f.path}
                className="cp-rowmenu-folder"
                onClick={() => go(f.path)}
                disabled={busy}
              >
                {f.name}
              </button>
            ))}
          </div>
        )}
        {onCreateFolder && (
          <div className="cp-rowmenu-newfolder">
            <label className="cp-rowmenu-newfolder-label" htmlFor="cp-move-newfolder">
              {folders.length === 0 ? "Make a folder for them" : "Or make a new one"}
            </label>
            <div className="cp-rowmenu-newfolder-row">
              <input
                id="cp-move-newfolder"
                className="cp-rowmenu-input"
                value={newName}
                placeholder="Folder name"
                disabled={busy}
                onChange={(e) => { setNewName(e.target.value); setRefusal(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void makeAndMove(); } }}
              />
              <button
                className="btn cp-tx-iconbtn"
                onClick={() => void makeAndMove()}
                disabled={busy || !newName.trim()}
              >
                Create and move
              </button>
            </div>
            {refusal && <p className="cp-rowmenu-warn"><IconAlert size={13} />{refusal}</p>}
          </div>
        )}
        <p className="cp-rowmenu-warn">
          <IconAlert size={13} />
          This moves the {paths.length === 1 ? "file" : "files"} on disk.
        </p>
        <div className="cp-rowmenu-actions">
          <button className="btn btn-ghost cp-tx-iconbtn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
