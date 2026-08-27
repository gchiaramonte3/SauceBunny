import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import { useModalFocus } from "../hooks/use-modal-focus";
import { IconAlert } from "./Icons";

/**
 * File one frame into a folder.
 *
 * Modelled on ReaderRowMenu's move dialog, down to the class names, because
 * it is the same act on the same kind of thing: pick a destination, or name
 * a new one and go there in a single step. Reusing that shape means this
 * needed no new styles.
 *
 * Deliberately NOT WebCollectionMenu's checkbox popover. That one is a
 * checkbox because a web clip may belong to several collections at once; a
 * file lives in exactly ONE directory, so a checkbox here would give a move
 * the affordance of a tag and quietly lie about what the action does.
 */
export function FrameMoveDialog({ name, folders, currentFolder, onMoved, onClose }: {
  /** The frame's filename, for the title. */
  name: string;
  /** Every folder under the Frames root, as relative paths. */
  folders: readonly string[];
  /** Where it lives now, "" for the root - offered, but marked. */
  currentFolder: string;
  onMoved: () => void;
  onClose: () => void;
}) {
  // aria-modal claims everything outside is inert, so focus has to be
  // trapped and restored - the house hook does both.
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialogRef);
  const [busy, setBusy] = useState(false);
  const [newFolder, setNewFolder] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const move = async (dest: string) => {
    setBusy(true);
    setErr(null);
    try {
      await invoke("move_frame_to_folder", { path: name, dest });
      onMoved();
      onClose();
    } catch (e) {
      setErr(formatError(e));
      setBusy(false);
    }
  };

  const createAndMove = async () => {
    const trimmed = newFolder.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      await invoke("create_frames_folder", { parent: currentFolder, name: trimmed });
      const dest = currentFolder ? `${currentFolder}/${trimmed}` : trimmed;
      await invoke("move_frame_to_folder", { path: name, dest });
      onMoved();
      onClose();
    } catch (e) {
      setErr(formatError(e));
      setBusy(false);
    }
  };

  // The root is always a destination; a frame already in a folder needs a way
  // back out, and that is the only way to get it.
  const options = ["", ...folders.filter((f) => f !== "")];

  return createPortal(
    <div className="cp-rowmenu-scrim modal" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* tabIndex={-1} so the trap has somewhere to put focus on open;
          without it the first Tab escapes the scrim. */}
      <div ref={dialogRef} tabIndex={-1} className="cp-rowmenu-dialog" role="dialog" aria-modal="true" aria-label="Move frame">
        <h4 className="cp-rowmenu-title">Move “{name.split("/").pop()}”</h4>
        <div className="cp-rowmenu-folders">
          {options.map((f) => (
            <button
              key={f || "__root"}
              className="cp-rowmenu-folder"
              onClick={() => void move(f)}
              disabled={busy || f === currentFolder}
            >
              {f === "" ? "Frames (top level)" : f}
              {f === currentFolder ? " · here now" : ""}
            </button>
          ))}
        </div>
        <div className="cp-rowmenu-newfolder">
          <input
            className="cp-rowmenu-input"
            value={newFolder}
            placeholder="New folder name…"
            spellCheck={false}
            onChange={(e) => { setNewFolder(e.target.value); setErr(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") void createAndMove(); }}
          />
          <button className="btn cp-tx-iconbtn" onClick={() => void createAndMove()} disabled={busy || !newFolder.trim()}>
            Create &amp; move
          </button>
        </div>
        <p className="cp-rowmenu-warn">
          <IconAlert size={13} />
          This moves the file on disk, inside your Frames folder.
        </p>
        {err && <p className="cp-rowmenu-err">{err}</p>}
        <div className="cp-rowmenu-actions">
          <button className="btn btn-ghost cp-tx-iconbtn" onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
