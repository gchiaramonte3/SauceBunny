import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useModalFocus } from "../hooks/use-modal-focus";
import { formatError } from "../lib/error-format";
import { newFolderPath } from "../lib/library-folder";
import type { LibraryFolder } from "../types";

/** Select a destination before moving originals. One-level reads plus Browse
 * reach deep and unregistered folders without adding persistent Library roots. */
export function LibraryMoveDialog({ paths, folders, initialPath, onMove, onClose }: {
  paths: readonly string[]; folders: readonly LibraryFolder[]; initialPath?: string;
  onMove: (dest: string, paths: readonly string[]) => Promise<string | null>; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(true, ref);
  const [destination, setDestination] = useState(initialPath ?? "");
  const [children, setChildren] = useState<LibraryFolder[]>([]);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null), [newName, setNewName] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true; setChildren([]);
    if (!destination) { setLoading(false); return; }
    setLoading(true);
    void invoke<LibraryFolder>("scan_library_folder", { path: destination, maxDepth: 1 }).then((tree) => {
      if (current) setChildren(tree.folders);
    }).catch((cause) => { if (current) setError(formatError(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [destination, tick]);
  const browse = async () => {
    setBusy(true); setError(null);
    try { const path = await open({ directory: true, multiple: false, title: "Move originals into…" }); if (typeof path === "string") setDestination(path); }
    catch (cause) { setError(formatError(cause)); }
    finally { setBusy(false); }
  };
  const move = async (create = false) => {
    if (busy || !destination) return;
    setBusy(true); setError(null);
    try {
      let target = destination;
      if (create) {
        const folder = newFolderPath(destination, newName);
        if ("error" in folder) throw new Error(folder.error);
        await invoke("ensure_dir_exists", { path: folder.path }); target = folder.path;
      }
      const refusal = await onMove(target, paths);
      if (refusal) { setError(refusal); setTick((value) => value + 1); }
      else onClose();
    } catch (cause) { setError(formatError(cause)); }
    finally { setBusy(false); }
  };
  return createPortal(<div className="cp-rowmenu-scrim modal" onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}>
    <div ref={ref} tabIndex={-1} className="cp-rowmenu-dialog cp-project-dialog" role="dialog" aria-modal="true" aria-label="Move to folder">
      <h4 className="cp-rowmenu-title">Move {paths.length === 1 ? paths[0].split("/").pop() : paths.length + " files"} on disk</h4>
      <p className="cp-project-help">This moves originals, not project references. Choose the destination, then confirm Move.</p>
      <label>Library root<select className="cp-select" aria-label="Destination root" value={folders.some((f) => f.path === destination) ? destination : ""} disabled={busy} onChange={(event) => { setDestination(event.target.value); setError(null); }}><option value="">Choose a root…</option>{folders.map((folder) => <option key={folder.path} value={folder.path}>{folder.path}</option>)}</select></label>
      <div className="cp-project-inline"><button className="btn btn-ghost" disabled={busy} onClick={() => void browse()}>Browse any folder…</button><button className="btn btn-ghost" disabled={busy || !destination || destination === "/"} onClick={() => { setDestination(destination.slice(0, destination.lastIndexOf("/")) || "/"); setError(null); }}>Up one folder</button></div>
      <p className="cp-project-destination">{destination || "No destination selected"}</p>
      <div className="cp-project-catalog" aria-label="Destination subfolders">{children.map((folder) => <button key={folder.path} className="cp-rowmenu-folder" disabled={busy} onClick={() => { setDestination(folder.path); setError(null); }}>{folder.name}</button>)}{loading && <p role="status">Loading folders…</p>}</div>
      {error && <p className="cp-project-error" role="alert">{error}<button className="btn btn-ghost" disabled={busy || loading} onClick={() => { setError(null); setTick((value) => value + 1); }}>Refresh folders</button></p>}
      <label>New subfolder (optional)<input className="cp-rowmenu-input" aria-label="Folder name" value={newName} disabled={busy} onChange={(event) => setNewName(event.target.value)} /></label>
      <div className="cp-rowmenu-actions"><button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-ghost" disabled={busy || !destination || !newName.trim()} onClick={() => void move(true)}>Create and move</button><button className="btn" disabled={busy || !destination} onClick={() => void move()}>{busy ? "Moving…" : "Move here"}</button></div>
    </div>
  </div>, document.body);
}
