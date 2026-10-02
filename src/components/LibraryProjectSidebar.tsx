import { useState } from "react";
import { IconChevronRight, IconFolderSolid, IconMore } from "./Icons";
import { LibraryOrganizationMenu, type OrganizationMenuAction } from "./LibraryOrganizationMenu";
import { folderChain, putFolder, removeFolder, type LibraryOrganization, type ProjectFolder } from "../lib/library-organization";
import { libraryOrganization } from "../lib/library-organization-store";
import { useCardDrag } from "../hooks/use-card-drag";
import { loadJson, saveJson } from "../lib/storage";

export function LibraryProjectSidebar({ data, selected, onSelect, onDisk, onEdit, onNew, busy, dropOver }: {
  data: LibraryOrganization; selected: string | null; onSelect: (id: string) => void; onDisk: (path: string) => void;
  onEdit: (folder: ProjectFolder) => void; onNew: (parentId: string | null) => void; busy: boolean; dropOver: string | null;
}) {
  const [collapsed, setCollapsed] = useState<string[]>(() => loadJson("saucebunny.projectFoldersCollapsed", []));
  const [menu, setMenu] = useState<{ x: number; y: number; actions: OrganizationMenuAction[] } | null>(null);
  const reorderFavorite = (id: string, delta: number) => libraryOrganization.edit("reorder favorites", (current) => {
    const favorites = [...current.favorites]; const index = favorites.findIndex((f) => f.id === id); const target = index + delta;
    if (index < 0 || target < 0 || target >= favorites.length) return current;
    [favorites[index], favorites[target]] = [favorites[target], favorites[index]];
    return { ...current, favorites };
  });
  const drag = useCardDrag({ itemSelector: "[data-project-source]", pathAttr: "data-project-source", targetSelector: "[data-project-parent]", targetAttr: "data-project-parent", pathsFor: (id) => [id],
    onDrop: (parent, ids) => { void libraryOrganization.edit("move project folder", (current) => {
      const folder = current.folders.find((f) => f.id === ids[0]);
      return folder ? putFolder(current, { ...folder, parentId: parent === "projects" ? null : parent }) : current;
    }); },
  });
  const favoriteDrag = useCardDrag({ itemSelector: "[data-favorite-source]", pathAttr: "data-favorite-source", targetSelector: "[data-favorite-target]", targetAttr: "data-favorite-target", pathsFor: (id) => [id],
    onDrop: (target, ids) => { void libraryOrganization.edit("reorder favorites", (current) => {
      const item = current.favorites.find((f) => f.id === ids[0]);
      if (!item || item.id === target) return current;
      const favorites = current.favorites.filter((f) => f.id !== item.id), index = favorites.findIndex((f) => f.id === target);
      if (index < 0) return current;
      favorites.splice(index, 0, item); return { ...current, favorites };
    }); },
  });
  const rows = (parentId: string | null, depth: number): React.ReactNode => data.folders.filter((f) => f.parentId === parentId).map((folder) => {
    const expanded = !collapsed.includes(folder.id);
    const hasChildren = data.folders.some((f) => f.parentId === folder.id);
    const favorite = data.favorites.find((f) => f.kind === "folder" && f.target === folder.id);
    const actions: OrganizationMenuAction[] = [
      { label: "New subfolder…", disabled: !!folder.rule || busy, run: () => onNew(folder.id) },
      { label: "Rename or move…", disabled: busy, run: () => onEdit(folder) },
      { label: favorite ? "Remove from Favorites" : "Add to Favorites", disabled: busy, run: () => { void libraryOrganization.edit("change favorite", (current) => ({ ...current, favorites: favorite ? current.favorites.filter((f) => f.id !== favorite.id) : [...current.favorites, { id: crypto.randomUUID(), kind: "folder", target: folder.id, name: folder.name }] })); } },
      { label: "Remove folder and subfolders", disabled: busy, run: () => { void libraryOrganization.edit("remove project folder", (current) => removeFolder(current, folder.id)); } },
    ];
    const showMenu = (element: HTMLElement) => { const rect = element.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, actions }); };
    return <div key={folder.id}>
      <div className={"cp-project-tree-row" + (selected === folder.id ? " selected" : "") + (dropOver === `project:${folder.id}` || drag.drag?.over === folder.id ? " dropping" : "")} style={{ ["--depth" as string]: depth }} data-project-parent={!folder.rule ? folder.id : undefined} data-drop={!folder.rule ? `project:${folder.id}` : undefined}>
        <button className="cp-lib-tree-act" aria-label={`${expanded ? "Collapse" : "Expand"} ${folder.name}`} aria-expanded={hasChildren ? expanded : undefined} disabled={!hasChildren} onClick={() => { const next = expanded ? [...collapsed, folder.id] : collapsed.filter((id) => id !== folder.id); setCollapsed(next); saveJson("saucebunny.projectFoldersCollapsed", next); }}><IconChevronRight size={12} className={expanded && hasChildren ? "cp-project-open" : undefined} /></button>
        <button className="cp-project-location" data-project-source={folder.id} aria-current={selected === folder.id ? "page" : undefined} title={folderChain(data.folders, folder.id).map((f) => f.name).join(" / ")} onClick={() => onSelect(folder.id)} onContextMenu={(event) => { event.preventDefault(); event.currentTarget.focus(); showMenu(event.currentTarget); }} onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); showMenu(event.currentTarget); } }}><IconFolderSolid size={14} /><span>{folder.name}</span>{folder.rule && <small>Smart</small>}</button>
        <button className="cp-lib-tree-act" aria-label={`Actions for ${folder.name}`} title={`Actions for ${folder.name}`} onClick={(event) => showMenu(event.currentTarget)}><IconMore size={14} /></button>
      </div>
      {expanded && rows(folder.id, depth + 1)}
    </div>;
  });
  return <div className="cp-project-sidebar" {...drag.handlers}>
    {data.favorites.length > 0 && <section aria-label="Favorites" {...favoriteDrag.handlers}><h3 className="cp-project-section-title">Favorites</h3>{data.favorites.map((favorite, index) => <div key={favorite.id} data-favorite-target={favorite.id} className={"cp-project-tree-row" + (favoriteDrag.drag?.over === favorite.id ? " dropping" : "")}>
      <button className="cp-project-location" data-favorite-source={favorite.id} onClick={() => favorite.kind === "folder" ? onSelect(favorite.target) : onDisk(favorite.target)}><IconFolderSolid size={14} /><span>{favorite.name}</span></button>
      <button className="cp-lib-tree-act" aria-label={`Favorite actions for ${favorite.name}`} onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ x: rect.left, y: rect.bottom, actions: [
        { label: "Move up", disabled: index === 0 || busy, run: () => { void reorderFavorite(favorite.id, -1); } },
        { label: "Move down", disabled: index === data.favorites.length - 1 || busy, run: () => { void reorderFavorite(favorite.id, 1); } },
        { label: "Remove from Favorites", disabled: busy, run: () => { void libraryOrganization.edit("remove favorite", (current) => ({ ...current, favorites: current.favorites.filter((f) => f.id !== favorite.id) })); } },
      ] }); }}><IconMore size={14} /></button>
    </div>)}</section>}
    <section aria-label="Projects"><button className={"cp-project-section-title cp-project-root" + (selected === "projects" ? " selected" : "")} data-project-parent="projects" onClick={() => onSelect("projects")}>Projects</button>
      {rows(null, 0)}
      {data.folders.length === 0 && <button className="cp-project-location" disabled={busy} onClick={() => onNew(null)}>New in-app folder…</button>}
    </section>
    {menu && <LibraryOrganizationMenu anchor={menu} actions={menu.actions} onClose={() => setMenu(null)} />}
    {drag.drag && <div className="cp-lib-drag-ghost" style={{ left: drag.drag.x + 12, top: drag.drag.y + 12 }}>Move folder</div>}
  </div>;
}
