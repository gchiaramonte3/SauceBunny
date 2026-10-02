import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/use-modal-focus";
import { folderChain, putFolder, type LibraryOrganization, type ProjectFolder, type SmartFolderRule } from "../lib/library-organization";
import { libraryOrganization } from "../lib/library-organization-store";

export function LibraryProjectFolderDialog({ folder, data, onClose, onSaved }: {
  folder: ProjectFolder; data: LibraryOrganization; onClose: () => void; onSaved: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(true, ref);
  const [draft, setDraft] = useState(folder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing] = useState(() => data.folders.some((f) => f.id === folder.id));
  const parents = data.folders.filter((f) => !f.rule && !folderChain(data.folders, f.id).some((p) => p.id === folder.id));
  const patchRule = (patch: Partial<SmartFolderRule>) => setDraft((d) => ({ ...d, rule: d.rule ? { ...d.rule, ...patch } : null }));
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ok = await libraryOrganization.edit(existing ? "edit project folder" : "new project folder", (current) => {
      const latest = current.folders.find((f) => f.id === folder.id);
      if (existing && !latest) throw new Error("This folder was removed. Close this dialog and choose a current folder.");
      // The dialog edits metadata, not membership. Keep additions/removals
      // acknowledged while the dialog was open (including undo/redo).
      return putFolder(current, { ...draft, assetIds: latest?.assetIds ?? draft.assetIds });
    });
    setBusy(false);
    if (ok) { onSaved(draft.id); onClose(); }
    else setError(libraryOrganization.getSnapshot().error);
  };
  return createPortal(<div className="cp-rowmenu-scrim modal" onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}>
    <div className="cp-rowmenu-dialog cp-project-dialog" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={existing ? "Edit project folder" : "New in-app folder"}>
      <h4 className="cp-rowmenu-title">{existing ? "Edit folder" : draft.rule ? "New smart folder" : "New in-app folder"}</h4>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>Name<input className="cp-rowmenu-input" value={draft.name} maxLength={160} disabled={busy} onChange={(event) => setDraft({ ...draft, name: event.target.value })} autoFocus /></label>
        <label>Inside<select className="cp-select" value={draft.parentId ?? ""} disabled={busy} onChange={(event) => setDraft({ ...draft, parentId: event.target.value || null })}>
          <option value="">Projects</option>{parents.map((parent) => <option key={parent.id} value={parent.id}>{folderChain(data.folders, parent.id).map((p) => p.name).join(" / ")}</option>)}
        </select></label>
        {draft.rule && <fieldset disabled={busy}><legend>Match all rules</legend>
          <label>Name contains<input className="cp-rowmenu-input" value={draft.rule.query} onChange={(event) => patchRule({ query: event.target.value })} /></label>
          <label>Item type<select className="cp-select" value={draft.rule.kind} onChange={(event) => patchRule({ kind: event.target.value as SmartFolderRule["kind"] })}>
            <option value="all">All types</option><option value="file">Local media</option><option value="web">Web links</option><option value="transcript">Transcripts</option><option value="multitrack">AAF Audio</option>
          </select></label>
          <label>Finder tag<input className="cp-rowmenu-input" value={draft.rule.tag} placeholder="Any tag" onChange={(event) => patchRule({ tag: event.target.value })} /></label>
          <label>Status<select className="cp-select" value={draft.rule.status} onChange={(event) => patchRule({ status: event.target.value as SmartFolderRule["status"] })}>
            <option value="any">Any status</option><option value="not-transcribed">No linked transcript</option><option value="needs-review">Changes requested</option><option value="offline">Offline</option>
          </select></label>
        </fieldset>}
        <p className="cp-project-help">{draft.rule ? "Results update from known Library items. No files are moved." : "Organize references here. Original files stay where they are."}</p>
        {error && <p className="cp-project-error" role="alert">{error}</p>}
        <div className="cp-rowmenu-actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !draft.name.trim()}>{busy ? "Saving…" : existing ? "Save" : "Create folder"}</button></div>
      </form>
    </div>
  </div>, document.body);
}
