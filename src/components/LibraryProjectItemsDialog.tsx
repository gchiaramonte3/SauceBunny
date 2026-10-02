import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import { useModalFocus } from "../hooks/use-modal-focus";
import { folderChain, moveFolderAssets, type LibraryAsset, type LibraryOrganization } from "../lib/library-organization";
import { libraryAsset, assetKindLabel } from "../lib/library-project-catalog";
import { libraryOrganization } from "../lib/library-organization-store";
import { formatError } from "../lib/error-format";

export function LibraryProjectItemsDialog({ data, catalog = [], initialAssets, folderId, fromFolderId = null, moving = false, onClose }: {
  data: LibraryOrganization; catalog?: LibraryAsset[]; initialAssets?: LibraryAsset[]; folderId: string | null;
  fromFolderId?: string | null; moving?: boolean; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(true, ref);
  const targets = data.folders.filter((f) => !f.rule && (!moving || f.id !== fromFolderId));
  const [destination, setDestination] = useState(folderId ?? targets[0]?.id ?? "");
  const [chosen, setChosen] = useState<LibraryAsset[]>(initialAssets ?? []);
  const [query, setQuery] = useState(""), [url, setUrl] = useState("");
  const [page, setPage] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const filtered = useMemo(() => catalog.filter((a) => `${a.title} ${assetKindLabel[a.kind]}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [catalog, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 100) - 1));
  const browse = async () => {
    setBusy(true); setError(null);
    try {
      const paths = await open({ multiple: true, directory: false, title: "Add references to files", filters: [{ name: "Media and transcripts", extensions: ["mp4", "mov", "mkv", "m4v", "avi", "webm", "mp3", "wav", "aiff", "aif", "flac", "m4a", "aac", "ogg", "srt", "vtt"] }] });
      if (paths) setChosen((current) => [...new Map([...current, ...(Array.isArray(paths) ? paths : [paths]).map((path) => libraryAsset(/\.(srt|vtt)$/i.test(path) ? "transcript" : "file", path))].map((a) => [a.id, a])).values()]);
    } catch (cause) { setError(formatError(cause)); }
    finally { setBusy(false); }
  };
  const addUrl = () => {
    try {
      const parsed = new URL(url.trim());
      if (!["https:", "http:"].includes(parsed.protocol)) throw new Error("Paste an http or https video link.");
      const asset = libraryAsset("web", parsed.href, parsed.href);
      setChosen((current) => current.some((a) => a.id === asset.id) ? current : [...current, asset]); setUrl(""); setError(null);
    } catch { setError("Paste a complete http or https video link."); }
  };
  const save = async () => {
    if (busy || !destination || !chosen.length) return;
    setBusy(true); setError(null);
    const ok = await libraryOrganization.edit(moving ? "move folder references" : "add folder references", (current) => moveFolderAssets(current, moving ? fromFolderId : null, destination, chosen));
    setBusy(false);
    if (ok) onClose(); else setError(libraryOrganization.getSnapshot().error);
  };
  return createPortal(<div className="cp-rowmenu-scrim modal" onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onClose(); } }}>
    <div ref={ref} className="cp-rowmenu-dialog cp-project-dialog" role="dialog" aria-modal="true" aria-label={moving ? "Move references" : "Add to project folder"} tabIndex={-1}>
      <h4 className="cp-rowmenu-title">{moving ? "Move references" : "Add to project folder"}</h4>
      <label>Project folder<select className="cp-select" value={destination} disabled={busy} onChange={(event) => setDestination(event.target.value)}><option value="" disabled>Choose a folder…</option>{targets.map((folder) => <option key={folder.id} value={folder.id}>{folderChain(data.folders, folder.id).map((f) => f.name).join(" / ")}</option>)}</select></label>
      {!targets.length && <p className="cp-project-help">Create an in-app folder using the Library + menu first.</p>}
      {!initialAssets && <>
        <div className="cp-project-inline"><button className="btn btn-ghost" disabled={busy} onClick={() => void browse()}>Choose files…</button>
          <form className="cp-project-inline" onSubmit={(event) => { event.preventDefault(); addUrl(); }}><input className="cp-rowmenu-input" type="url" aria-label="Web link to add" placeholder="Paste a video link…" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} /><button className="btn btn-ghost" disabled={busy || !url.trim()}>Add link</button></form></div>
        <input className="cp-rowmenu-input" type="search" aria-label="Search available Library items" placeholder="Search media, links, transcripts…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
        <div className="cp-project-catalog" role="group" aria-label="Available Library items">{filtered.slice(currentPage * 100, (currentPage + 1) * 100).map((asset) => <label key={asset.id} title={asset.locator}><input type="checkbox" disabled={busy} checked={chosen.some((a) => a.id === asset.id)} onChange={(event) => setChosen((current) => event.target.checked ? [...current, asset] : current.filter((a) => a.id !== asset.id))} /><span>{asset.title}<small>{assetKindLabel[asset.kind]}</small></span></label>)}</div>
        {filtered.length > 100 && <div className="cp-project-pages"><button className="btn btn-ghost" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {Math.ceil(filtered.length / 100)}</span><button className="btn btn-ghost" disabled={(currentPage + 1) * 100 >= filtered.length} onClick={() => setPage(currentPage + 1)}>Next</button></div>}
      </>}
      <p className="cp-project-help">{chosen.length} selected. {moving ? "Only the folder references move." : "Original files stay where they are. Links are not downloaded."}</p>
      {chosen.length > 0 && <details className="cp-project-picked"><summary>Selected items</summary>{chosen.map((asset) => <div key={asset.id}><span>{asset.title}</span><button className="btn btn-ghost" aria-label={`Remove ${asset.title} from selection`} disabled={busy} onClick={() => setChosen((current) => current.filter((a) => a.id !== asset.id))}>Remove</button></div>)}</details>}
      {error && <p className="cp-project-error" role="alert">{error}</p>}
      <div className="cp-rowmenu-actions"><button className="btn btn-ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="btn" disabled={busy || !targets.some((f) => f.id === destination) || !chosen.length} onClick={() => void save()}>{busy ? "Saving…" : moving ? "Move references" : "Add references"}</button></div>
    </div>
  </div>, document.body);
}
