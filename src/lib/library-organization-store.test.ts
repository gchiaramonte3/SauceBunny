import { beforeEach, describe, expect, it, vi } from "vitest";
const ipc = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ipc);
import { LibraryOrganizationStore } from "./library-organization-store";
import { addFolderAssets, emptyOrganization, putFolder, relinkAsset, removeFolder } from "./library-organization";
import { appUndo } from "./undo";

let disk: string | null;
beforeEach(() => {
  disk = null; appUndo.clear(); ipc.invoke.mockReset();
  ipc.invoke.mockImplementation(async (cmd: string, args?: { expected: string | null; text: string }) => {
    if (cmd === "library_organization_load") return disk;
    if (cmd === "library_organization_save" && args) {
      if (args.expected !== disk) throw new Error("Conflicting write");
      disk = args.text; return;
    }
    throw new Error(`Unexpected ${cmd}`);
  });
});
const add = (store: LibraryOrganizationStore, id: string) => store.edit("new folder", (data) => putFolder(data, { id, name: id, parentId: null, assetIds: [], rule: null }));

describe("durable organization edits", () => {
  it("serializes concurrent edits and reopens exactly what was saved", async () => {
    const store = new LibraryOrganizationStore(); await store.load();
    await Promise.all([add(store, "a"), add(store, "b")]);
    const reopened = new LibraryOrganizationStore(); await reopened.load();
    expect(reopened.getSnapshot().data.folders.map((f) => f.id)).toEqual(["a", "b"]);
  });
  it("does not acknowledge failed writes and can retry", async () => {
    const store = new LibraryOrganizationStore(); await store.load();
    ipc.invoke.mockRejectedValueOnce(new Error("Disk full"));
    expect(await add(store, "a")).toBe(false);
    expect(store.getSnapshot().data.folders).toEqual([]);
    expect(store.getSnapshot().error).toBe("Disk full");
    expect(appUndo.getSnapshot().canUndo).toBe(false);
    expect(await add(store, "a")).toBe(true);
  });
  it("does not overwrite a failed read or a concurrent writer", async () => {
    const store = new LibraryOrganizationStore();
    ipc.invoke.mockRejectedValueOnce(new Error("Permission denied")); await store.load();
    expect(await add(store, "a")).toBe(false);
    expect(disk).toBeNull();
    await store.load(); disk = JSON.stringify(emptyOrganization());
    expect(await add(store, "a")).toBe(false);
    expect(store.getSnapshot().error).toBe("Conflicting write");
  });
  it("undoes membership without reviving an old asset path", async () => {
    const store = new LibraryOrganizationStore(); await store.load(); await add(store, "a");
    await store.edit("add item", (data) => addFolderAssets(data, "a", [{ id: "asset", kind: "file", locator: "/old.mov", title: "Old" }]));
    await store.repath("/old.mov", "/new.mov");
    appUndo.undo(); await store.edit("barrier", (data) => data, false);
    expect(store.getSnapshot().data.folders[0].assetIds).toEqual([]);
    expect(store.getSnapshot().data.assets[0].locator).toBe("/new.mov");
    appUndo.redo(); await store.edit("barrier", (data) => data, false);
    expect(store.getSnapshot().data.folders[0].assetIds).toEqual(["asset"]);
    expect(store.getSnapshot().data.assets[0].locator).toBe("/new.mov");
  });
  it("undoes and redoes hierarchy removal together with favorites", async () => {
    const store = new LibraryOrganizationStore(); await store.load(); await add(store, "a");
    await store.edit("child", (data) => putFolder(data, { id: "b", name: "b", parentId: "a", assetIds: [], rule: null }));
    await store.edit("pin", (data) => ({ ...data, favorites: [{ id: "pin", kind: "folder", target: "b", name: "b" }] }));
    await store.edit("remove", (data) => removeFolder(data, "a"));
    expect(store.getSnapshot().data.folders).toHaveLength(0);
    appUndo.undo(); await store.edit("barrier", (data) => data, false);
    expect(store.getSnapshot().data.folders).toHaveLength(2);
    expect(store.getSnapshot().data.favorites[0].target).toBe("b");
    appUndo.redo(); await store.edit("barrier", (data) => data, false);
    expect(store.getSnapshot().data.folders).toHaveLength(0);
    expect(store.getSnapshot().data.favorites).toHaveLength(0);
  });
  it("undoes relinking but never overwrites a later real rename", async () => {
    const store = new LibraryOrganizationStore(); await store.load(); await add(store, "a");
    await store.edit("file", (data) => addFolderAssets(data, "a", [{ id: "asset", kind: "file", locator: "/old.mov", title: "Old" }]));
    await store.edit("relink", (data) => relinkAsset(data, "asset", "/new.mov"));
    appUndo.undo(); await store.edit("barrier", (data) => data, false);
    expect(store.getSnapshot().data.assets[0].locator).toBe("/old.mov");
    appUndo.redo(); await store.edit("barrier", (data) => data, false);
    await store.repath("/new.mov", "/renamed.mov");
    appUndo.undo(); await store.edit("barrier", (data) => data, false);
    expect(store.getSnapshot().data.assets[0].locator).toBe("/renamed.mov");
  });
  it("keeps committed data on a failed undo and invalidates unsafe redo", async () => {
    const store = new LibraryOrganizationStore(); await store.load(); await add(store, "a");
    ipc.invoke.mockRejectedValueOnce(new Error("Disk full"));
    appUndo.undo();
    await vi.waitFor(() => expect(store.getSnapshot().error).toBe("Disk full"));
    expect(store.getSnapshot().data.folders).toHaveLength(1);
    expect(appUndo.getSnapshot().canRedo).toBe(false);
  });
  it("serializes reload behind pending saves and rejects obsolete history", async () => {
    const store = new LibraryOrganizationStore(); await store.load();
    let release!: () => void;
    ipc.invoke.mockImplementationOnce(async (_cmd, args) => { await new Promise<void>((resolve) => { release = resolve; }); disk = args.text; });
    const saving = add(store, "a"); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const loading = store.load(); release(); await saving; await loading;
    expect(store.getSnapshot().data.folders[0].id).toBe("a");
    expect(appUndo.getSnapshot().canUndo).toBe(false);
  });
});
