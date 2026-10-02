import { invoke } from "@tauri-apps/api/core";
import { formatError } from "./error-format";
import { appUndo } from "./undo";
import { pathKey } from "./repath";
import { emptyOrganization, parseOrganization, type LibraryOrganization } from "./library-organization";

type Snapshot = { data: LibraryOrganization; ready: boolean; busy: boolean; error: string | null };

/** Serialized, write-through edits. The UI adopts a change only after the native
 * compare-and-save succeeds. A failed read is not permission to create an empty
 * file. No debounce and no unmount/quit flush dependency. */
export class LibraryOrganizationStore {
  private snapshot: Snapshot = { data: emptyOrganization(), ready: false, busy: false, error: null };
  private savedText: string | null = null;
  private loading: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  load = (): Promise<void> => {
    if (this.loading) return this.loading;
    const load = this.queue.then(async () => {
      this.publish({ busy: true, error: null });
      try {
        const text = await invoke<string | null>("library_organization_load");
        const data = parseOrganization(text);
        this.savedText = text;
        appUndo.clearScope("library-organization");
        this.publish({ data, ready: true });
      } catch (cause) { this.publish({ ready: false, error: formatError(cause) }); }
      finally { this.publish({ busy: false }); this.loading = null; }
    });
    this.loading = load;
    this.queue = load;
    return load;
  };
  ensure = (): Promise<void> => this.snapshot.ready ? Promise.resolve() : this.load();

  edit = (label: string, change: (data: LibraryOrganization) => LibraryOrganization, undoable = true): Promise<boolean> => {
    let succeeded = false;
    const task = this.queue.then(async () => {
      if (!this.snapshot.ready) { this.publish({ error: this.snapshot.error ?? "Load project folders before editing." }); return; }
      this.publish({ busy: true, error: null });
      const before = this.snapshot.data;
      try {
        const after = change(before);
        if (after === before) { succeeded = true; return; }
        const text = JSON.stringify(after);
        parseOrganization(text);
        await invoke("library_organization_save", { expected: this.savedText, text });
        this.savedText = text;
        this.publish({ data: after });
        succeeded = true;
        const replay = async (from: LibraryOrganization, to: LibraryOrganization) => {
          const ok = await this.edit(label, (now) => ({ ...now, folders: to.folders, favorites: to.favorites,
            assets: now.assets.map((asset) => {
              const previous = from.assets.find((a) => a.id === asset.id), target = to.assets.find((a) => a.id === asset.id);
              // Relink is undoable, but an intervening file rename wins over
              // an old relink snapshot, just as it does for membership undo.
              return previous && target && previous.locator !== target.locator && asset.locator === previous.locator ? target : asset;
            }),
          }), false);
          // A failed durable undo must not leave a usable redo for an action
          // that never happened. Keep the saved document and show the error.
          if (!ok) appUndo.clearScope("library-organization");
        };
        if (undoable) appUndo.push({ label, scope: "library-organization",
          // Path updates are not organization edits. Never resurrect old paths
          // when a rename happened between filing an item and pressing Undo.
          undo: () => { void replay(after, before); },
          redo: () => { void replay(before, after); },
        });
      } catch (cause) { this.publish({ error: formatError(cause) }); }
      finally { this.publish({ busy: false }); }
    });
    this.queue = task;
    return task.then(() => succeeded);
  };

  repath = async (oldPath: string, newPath: string): Promise<void> => {
    await this.ensure();
    await this.edit("update Library location", (data) => {
      const match = (path: string) => pathKey(path) === pathKey(oldPath);
      if (!data.assets.some((a) => (a.kind === "file" || a.kind === "transcript") && match(a.locator))) return data;
      return { ...data, assets: data.assets.map((a) => (a.kind === "file" || a.kind === "transcript") && match(a.locator)
        ? { ...a, locator: newPath, title: newPath.split("/").pop() || a.title } : a) };
    }, false);
  };
}

export const libraryOrganization = new LibraryOrganizationStore();
