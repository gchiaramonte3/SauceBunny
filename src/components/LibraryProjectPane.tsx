import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { IconFolderSolid, IconMore, IconPanelLeft, IconPlus, IconRefresh } from "./Icons";
import type { LibraryFolder } from "../types";
import type { TranscriptHistoryEntry } from "../lib/transcript-history";
import { TRANSCRIPTS_CHANGED_EVENT } from "../lib/transcript-history";
import { subscribePersistedReviews } from "../lib/review-store";
import { assetKey, folderChain, matchesSmartFolder, moveFolderAssets, relinkAsset, type LibraryAsset, type LibraryOrganization, type ProjectFolder } from "../lib/library-organization";
import { assetKindLabel, loadProjectCatalog, projectTranscriptEntry, unknownAssetFacts, type ProjectCatalog } from "../lib/library-project-catalog";
import { libraryOrganization } from "../lib/library-organization-store";
import { LibraryProjectItemsDialog } from "./LibraryProjectItemsDialog";
import { LibraryOrganizationMenu, type OrganizationMenuAction } from "./LibraryOrganizationMenu";
import { useCardDrag } from "../hooks/use-card-drag";
import { formatError } from "../lib/error-format";
import { subscribeHidden } from "../lib/library-hidden";

export function LibraryProjectPane({ data, selected, trees, transcriptLibrary, busy, treeOpen, onShowTree, onSelect, onEdit, onNew, onOpenLocal, onOpenWeb, onOpenTranscript, onOpenMultitrack, onDropOver }: {
  data: LibraryOrganization; selected: string; trees: LibraryFolder[]; transcriptLibrary: string; busy: boolean; treeOpen: boolean;
  onShowTree: () => void; onSelect: (id: string) => void; onEdit: (folder: ProjectFolder) => void; onNew: (parent: string | null) => void;
  onOpenLocal: (path: string) => void; onOpenWeb: (url: string) => void; onOpenTranscript: (entry: TranscriptHistoryEntry) => void; onOpenMultitrack: (id: string) => void;
  onDropOver: (target: string | null) => void;
}) {
  const [catalog, setCatalog] = useState<ProjectCatalog>({ assets: [], facts: new Map(), transcripts: new Map(), errors: [] });
  const [loading, setLoading] = useState(true), [tick, setTick] = useState(0), [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(""), [page, setPage] = useState(0), [chosen, setChosen] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<{ assets?: LibraryAsset[]; moving?: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; actions: OrganizationMenuAction[] } | null>(null);
  const folder = data.folders.find((f) => f.id === selected), parentId = folder?.id ?? null;
  const refresh = () => setTick((value) => value + 1);
  useEffect(() => {
    let current = true; const controller = new AbortController(); setLoading(true);
    void loadProjectCatalog(trees, data.assets, transcriptLibrary, controller.signal).then((next) => { if (current) { setCatalog(next); setLoading(false); } }).catch((cause) => { if (current) { setError(formatError(cause)); setLoading(false); } });
    return () => { current = false; controller.abort(); };
  }, [trees, data.assets, transcriptLibrary, tick]);
  useEffect(() => {
    window.addEventListener("focus", refresh); window.addEventListener(TRANSCRIPTS_CHANGED_EVENT, refresh);
    const unsubscribe = subscribePersistedReviews(refresh);
    const unhide = subscribeHidden(refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener(TRANSCRIPTS_CHANGED_EVENT, refresh); unsubscribe(); unhide(); };
  }, []);
  useEffect(() => { setPage(0); setChosen(new Set()); setQuery(""); setAdding(null); }, [selected]);
  const items = useMemo(() => {
    const source = !folder ? [] : folder.rule ? catalog.assets.filter((asset) => matchesSmartFolder(asset, catalog.facts.get(assetKey(asset)) ?? unknownAssetFacts, folder.rule!)) : data.assets.filter((asset) => folder.assetIds.includes(asset.id));
    return source.filter((asset) => asset.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => a.title.localeCompare(b.title));
  }, [folder, catalog, data.assets, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(items.length / 100) - 1)), shown = items.slice(currentPage * 100, (currentPage + 1) * 100);
  const selectedAssets = items.filter((a) => chosen.has(a.id));
  const drag = useCardDrag({ itemSelector: "[data-project-asset]", pathAttr: "data-project-asset", targetSelector: "[data-drop^='project:']", targetAttr: "data-drop", pathsFor: (id) => chosen.has(id) ? selectedAssets.map((a) => a.id) : [id],
    onDrop: (target, ids, { copy }) => { const assets = items.filter((a) => ids.includes(a.id)); void libraryOrganization.edit(copy ? "add folder references" : "move folder references", (current) => moveFolderAssets(current, folder?.rule ? null : parentId, target.slice(8), assets, copy)); },
  });
  useEffect(() => { onDropOver(drag.drag?.over ?? null); return () => onDropOver(null); }, [drag.drag?.over, onDropOver]);
  const openAsset = (asset: LibraryAsset) => {
    if (catalog.facts.get(assetKey(asset))?.offline) { setError("This item is unavailable. Reconnect its drive or use Relink from its menu."); return; }
    if (asset.kind === "file") onOpenLocal(asset.locator);
    else if (asset.kind === "web") onOpenWeb(asset.locator);
    else if (asset.kind === "transcript") onOpenTranscript(projectTranscriptEntry(asset, catalog));
    else onOpenMultitrack(asset.locator);
  };
  const relink = async (asset: LibraryAsset) => {
    try {
      const path = await open({ directory: false, multiple: false, title: `Relink ${asset.title}`, filters: asset.kind === "transcript" ? [{ name: "Transcript", extensions: ["srt", "vtt"] }] : undefined });
      if (typeof path === "string") await libraryOrganization.edit("relink Library item", (current) => relinkAsset(current, asset.id, path));
    } catch (cause) { setError(formatError(cause)); }
  };
  const actionsFor = (asset: LibraryAsset): OrganizationMenuAction[] => {
    const assets = chosen.has(asset.id) ? selectedAssets : [asset];
    return [
      { label: "Open", run: () => openAsset(asset) },
      { label: "Add to another project folder…", disabled: busy, run: () => setAdding({ assets }) },
      { label: "Move references…", disabled: busy || !!folder?.rule, run: () => setAdding({ assets, moving: true }) },
      ...(asset.kind === "file" || asset.kind === "transcript" ? [{ label: "Relink…", disabled: busy || !data.assets.some((a) => a.id === asset.id), run: () => { void relink(asset); } }] : []),
      { label: "Remove from this folder", disabled: busy || !!folder?.rule, run: () => { const ids = new Set(assets.map((a) => a.id)); void libraryOrganization.edit("remove folder references", (current) => ({ ...current, folders: current.folders.map((f) => f.id === parentId ? { ...f, assetIds: f.assetIds.filter((id) => !ids.has(id)) } : f) })); } },
    ];
  };
  return <section className="cp-project-pane" aria-label="Project folder contents" {...drag.handlers} onKeyDown={(event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.metaKey && event.key.toLowerCase() === "a") { event.preventDefault(); event.stopPropagation(); setChosen(new Set(shown.map((a) => a.id))); }
    if (event.key === "Escape") setChosen(new Set());
  }}>
    <header className="cp-project-toolbar">
      {!treeOpen && <button className="cp-icon-btn" title="Show folder tree" aria-label="Show folder tree" onClick={onShowTree}><IconPanelLeft size={16} /></button>}
      <nav className="cp-project-breadcrumbs" aria-label="Project folder path"><button onClick={() => onSelect("projects")}>Projects</button>{folder && folderChain(data.folders, folder.id).map((crumb) => <button key={crumb.id} aria-current={crumb.id === parentId ? "page" : undefined} onClick={() => onSelect(crumb.id)}>{crumb.name}</button>)}</nav>
      <button className="cp-icon-btn" title="Refresh project items" aria-label="Refresh project items" disabled={loading} onClick={refresh}><IconRefresh size={14} /></button>
      <input className="cp-rowmenu-input" type="search" aria-label="Search project folder" placeholder="Search this folder…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} />
      {!folder?.rule && <button className="btn btn-ghost" disabled={busy} onClick={() => onNew(parentId)}><IconPlus size={14} />New folder</button>}
      {folder && <button className="btn btn-ghost" disabled={busy} onClick={() => folder.rule ? onEdit(folder) : setAdding({})}>{folder.rule ? "Edit rules…" : "Add items…"}</button>}
    </header>
    <p className="cp-project-help">{folder?.rule ? "Smart folder · Matches known Library items. Unscanned locations are not included." : "In-app folders contain references. Original files stay where they are."}</p>
    {(error || catalog.errors.length > 0) && <div className="cp-project-error" role="alert">{error || catalog.errors.join(" ")}<button className="btn btn-ghost" onClick={() => { setError(null); refresh(); }}>Retry</button></div>}
    <div className="cp-project-content">
      <div className="cp-project-folder-grid">{data.folders.filter((f) => f.parentId === parentId && f.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((child) => <button key={child.id} className="cp-project-folder" data-drop={!child.rule ? `project:${child.id}` : undefined} onClick={() => onSelect(child.id)}><IconFolderSolid size={20} /><span>{child.name}</span>{child.rule && <small>Smart folder</small>}</button>)}</div>
      {shown.map((asset) => <div key={asset.id} className={"cp-project-item" + (chosen.has(asset.id) ? " selected" : "")} data-project-asset={asset.id} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, actions: actionsFor(asset) }); }}>
        <input type="checkbox" aria-label={`Select ${asset.title}`} checked={chosen.has(asset.id)} onChange={(event) => setChosen((current) => { const next = new Set(current); if (event.target.checked) next.add(asset.id); else next.delete(asset.id); return next; })} />
        <button className="cp-project-item-open" onClick={() => openAsset(asset)} title={asset.locator}><span>{asset.title}</span><small>{assetKindLabel[asset.kind]}{catalog.facts.get(assetKey(asset))?.offline ? " · Offline" : ""}</small></button>
        <button className="cp-icon-btn" aria-label={`Actions for ${asset.title}`} title={`Actions for ${asset.title}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, actions: actionsFor(asset) }); }}><IconMore size={16} /></button>
      </div>)}
      {!items.length && folder && <p className="cp-project-help">{loading ? "Checking Library items…" : folder.rule || query ? "No matching items." : "Add media, web links, transcripts or a saved Multitrack sequence."}</p>}
      {!folder && !data.folders.length && <p className="cp-project-help">Create your first in-app folder to organize a project.</p>}
    </div>
    <footer className="cp-project-pages"><span>{items.length} items{selectedAssets.length ? ` · ${selectedAssets.length} selected` : ""}{loading ? " · Updating…" : ""}</span>{items.length > 100 && <><button className="btn btn-ghost" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button><span>Page {currentPage + 1} of {Math.ceil(items.length / 100)}</span><button className="btn btn-ghost" disabled={(currentPage + 1) * 100 >= items.length} onClick={() => setPage(currentPage + 1)}>Next</button></>}</footer>
    {adding && <LibraryProjectItemsDialog data={data} catalog={catalog.assets} folderId={adding.assets ? null : parentId} initialAssets={adding.assets} fromFolderId={parentId} moving={adding.moving} onClose={() => setAdding(null)} />}
    {menu && <LibraryOrganizationMenu anchor={menu} actions={menu.actions} onClose={() => setMenu(null)} />}
    {drag.drag && <div className="cp-lib-drag-ghost" style={{ left: drag.drag.x + 12, top: drag.drag.y + 12 }}>{drag.drag.copy || folder?.rule ? "Add" : "Move"} {drag.drag.paths.length} references</div>}
  </section>;
}
