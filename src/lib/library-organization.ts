import { pathKey } from "./repath";
import { STORE_SCHEMA_VERSION, futureVersionIn } from "./store-schema";

export type LibraryAssetKind = "file" | "web" | "transcript" | "multitrack";
export type LibraryAsset = {
  id: string;
  kind: LibraryAssetKind;
  /** Path, web URL, or saved Multitrack document ID. Never a cache path for web media. */
  locator: string;
  title: string;
};
export type SmartFolderRule = {
  query: string;
  kind: LibraryAssetKind | "all";
  tag: string;
  status: "any" | "not-transcribed" | "needs-review" | "offline";
};
export type ProjectFolder = {
  id: string;
  parentId: string | null;
  name: string;
  assetIds: string[];
  rule: SmartFolderRule | null;
};
export type LibraryFavorite = { id: string; kind: "folder" | "disk"; target: string; name: string };
export type LibraryOrganization = {
  version: number;
  assets: LibraryAsset[];
  folders: ProjectFolder[];
  favorites: LibraryFavorite[];
};

export function emptyOrganization(): LibraryOrganization {
  return { version: STORE_SCHEMA_VERSION, assets: [], folders: [], favorites: [] };
}

const kinds = ["file", "web", "transcript", "multitrack"] as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Library organization. The saved file has not been changed.");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16384) throw new Error("Invalid Library text. The saved file has not been changed.");
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid Library list. The saved file has not been changed.");
  return value;
}
function unique(ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate Library identities. The saved file has not been changed.");
}
function parseRule(raw: unknown): SmartFolderRule | null {
  if (raw === null) return null;
  const rule = object(raw);
  if (typeof rule.query !== "string" || typeof rule.tag !== "string"
    || !["all", ...kinds].includes(String(rule.kind))
    || !["any", "not-transcribed", "needs-review", "offline"].includes(String(rule.status))) throw new Error("Invalid smart folder rule.");
  return rule as SmartFolderRule;
}

/** Strict rather than lossy: damaged/unknown shapes cannot be saved back over the user's work. */
export function parseOrganization(raw: string | null): LibraryOrganization {
  if (raw === null) return emptyOrganization();
  if (futureVersionIn(raw) !== null) throw new Error("These folders were saved by a newer Sauce Bunny. Update the app before editing them.");
  const data = object(JSON.parse(raw));
  if (data.version !== STORE_SCHEMA_VERSION) throw new Error("Unsupported Library organization format.");
  const assets = list(data.assets).map((item): LibraryAsset => {
    const asset = object(item);
    if (!kinds.includes(asset.kind as LibraryAssetKind)) throw new Error("Unsupported Library item.");
    const locator = text(asset.locator);
    if (asset.kind === "web" && !/^https?:\/\//i.test(locator)) throw new Error("Invalid web link in Library.");
    if ((asset.kind === "file" || asset.kind === "transcript") && !locator.startsWith("/")) throw new Error("Invalid Library file location.");
    return { id: text(asset.id), title: text(asset.title), kind: asset.kind as LibraryAssetKind, locator };
  });
  const folders = list(data.folders).map((item): ProjectFolder => {
    const folder = object(item);
    return { id: text(folder.id), parentId: folder.parentId === null ? null : text(folder.parentId), name: folderName(text(folder.name)), assetIds: list(folder.assetIds).map(text), rule: parseRule(folder.rule) };
  });
  const favorites = list(data.favorites).map((item): LibraryFavorite => {
    const favorite = object(item);
    if (favorite.kind !== "folder" && favorite.kind !== "disk") throw new Error("Invalid favorite.");
    return { id: text(favorite.id), name: text(favorite.name), kind: favorite.kind, target: text(favorite.target) };
  });
  unique(assets.map((a) => a.id)); unique(folders.map((f) => f.id)); unique(favorites.map((f) => f.id));
  const assetIds = new Set(assets.map((a) => a.id));
  for (const folder of folders) {
    unique(folder.assetIds);
    if (folder.assetIds.some((id) => !assetIds.has(id))) throw new Error("A folder references an unknown Library item.");
    if (folder.rule && folder.assetIds.length) throw new Error("A smart folder cannot contain manually filed items.");
    if (folder.parentId && folders.find((f) => f.id === folder.parentId)?.rule) throw new Error("A smart folder cannot contain subfolders.");
    if (folders.some((f) => f.id !== folder.id && f.parentId === folder.parentId && f.name.toLocaleLowerCase() === folder.name.toLocaleLowerCase())) throw new Error("Duplicate folder names in the same location.");
    folderChain(folders, folder.id);
  }
  for (const favorite of favorites) {
    if (favorite.kind === "folder" && !folders.some((f) => f.id === favorite.target)) throw new Error("A favorite references an unknown folder.");
    if (favorite.kind === "disk" && !favorite.target.startsWith("/")) throw new Error("Invalid favorite location.");
  }
  return { version: STORE_SCHEMA_VERSION, assets, folders, favorites };
}

export function folderName(value: string): string {
  const name = value.trim().normalize("NFC");
  if (!name || name.length > 160 || /[\u0000-\u001f/]/.test(name)) throw new Error("Use a folder name of 1 to 160 characters without slashes.");
  return name;
}

export function folderChain(folders: readonly ProjectFolder[], id: string | null): ProjectFolder[] {
  const chain: ProjectFolder[] = [];
  const seen = new Set<string>();
  while (id !== null) {
    if (chain.length >= 64) throw new Error("Project folders can be nested up to 64 levels.");
    if (seen.has(id)) throw new Error("A folder cannot contain itself.");
    seen.add(id);
    const folder = folders.find((f) => f.id === id);
    if (!folder) throw new Error("That project folder no longer exists.");
    chain.unshift(folder); id = folder.parentId;
  }
  return chain;
}

export function putFolder(data: LibraryOrganization, folder: ProjectFolder): LibraryOrganization {
  const name = folderName(folder.name);
  if (folder.parentId !== null && !data.folders.some((f) => f.id === folder.parentId && !f.rule)) throw new Error("Choose a regular parent folder.");
  if (data.folders.some((f) => f.id !== folder.id && f.parentId === folder.parentId && f.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error("A folder with that name already exists here.");
  const folders = data.folders.some((f) => f.id === folder.id)
    ? data.folders.map((f) => f.id === folder.id ? { ...folder, name } : f)
    : [...data.folders, { ...folder, name }];
  folderChain(folders, folder.id);
  return { ...data, folders, favorites: data.favorites.map((f) => f.kind === "folder" && f.target === folder.id ? { ...f, name } : f) };
}

export function removeFolder(data: LibraryOrganization, id: string): LibraryOrganization {
  const removed = new Set(data.folders.filter((f) => folderChain(data.folders, f.id).some((p) => p.id === id)).map((f) => f.id));
  // Asset references remain available to other folders, smart folders and undo.
  return { ...data, folders: data.folders.filter((f) => !removed.has(f.id)), favorites: data.favorites.filter((f) => f.kind !== "folder" || !removed.has(f.target)) };
}

export function assetKey(asset: Pick<LibraryAsset, "kind" | "locator">): string {
  return `${asset.kind}:${asset.kind === "file" || asset.kind === "transcript" ? pathKey(asset.locator) : asset.locator}`;
}

export function addFolderAssets(data: LibraryOrganization, folderId: string, additions: readonly LibraryAsset[]): LibraryOrganization {
  const folder = data.folders.find((f) => f.id === folderId);
  if (!folder || folder.rule) throw new Error("Choose a regular project folder to add items.");
  const assets = [...data.assets];
  const ids = new Set(folder.assetIds);
  for (const asset of additions) {
    const existing = assets.find((a) => assetKey(a) === assetKey(asset));
    if (!existing) assets.push(asset);
    ids.add(existing?.id ?? asset.id);
  }
  return { ...data, assets, folders: data.folders.map((f) => f.id === folderId ? { ...f, assetIds: [...ids] } : f) };
}

export function moveFolderAssets(data: LibraryOrganization, fromId: string | null, toId: string, additions: readonly LibraryAsset[], copy = false): LibraryOrganization {
  if (fromId === toId) return data;
  const next = addFolderAssets(data, toId, additions);
  if (!fromId || copy) return next;
  const removed = new Set(additions.map((a) => a.id));
  return { ...next, folders: next.folders.map((f) => f.id === fromId && !f.rule ? { ...f, assetIds: f.assetIds.filter((id) => !removed.has(id)) } : f) };
}

/** Evidence comes from current scans/history, not stale flags persisted on a reference. */
export type LibraryAssetFacts = { tags: string[]; transcribed: boolean | null; needsReview: boolean | null; offline: boolean | null };
export function matchesSmartFolder(asset: LibraryAsset, facts: LibraryAssetFacts, rule: SmartFolderRule): boolean {
  if (rule.kind !== "all" && asset.kind !== rule.kind) return false;
  if (!asset.title.normalize("NFC").toLocaleLowerCase().includes(rule.query.trim().normalize("NFC").toLocaleLowerCase())) return false;
  if (rule.tag && !facts.tags.some((tag) => tag.toLocaleLowerCase() === rule.tag.trim().toLocaleLowerCase())) return false;
  return rule.status === "any" || (rule.status === "not-transcribed" && facts.transcribed === false)
    || (rule.status === "needs-review" && facts.needsReview === true) || (rule.status === "offline" && facts.offline === true);
}

export function relinkAsset(data: LibraryOrganization, id: string, locator: string): LibraryOrganization {
  const asset = data.assets.find((a) => a.id === id);
  if (!asset || (asset.kind !== "file" && asset.kind !== "transcript")) throw new Error("Only local files can be relinked.");
  if (!locator.startsWith("/")) throw new Error("Choose an absolute file location.");
  return { ...data, assets: data.assets.map((a) => a.id === id ? { ...a, locator, title: locator.split("/").pop() || a.title } : a) };
}
