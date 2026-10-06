import { IconFolderOffline } from "./Icons";
import { offlineCopy } from "../lib/media-offline";
import type { RootScan } from "../hooks/use-library-scan";

type Offline = Extract<RootScan, { status: "offline" }>;

/**
 * Library roots that cannot be reached, in the sidebar under the folder tree.
 * They used to vanish from it, so a missing drive made the library quietly
 * smaller with no way to retry or remove the root from here.
 */
export function LibraryOfflineRoots({ roots, scans, onLocate, onRetry, onRemove }: {
  roots: readonly string[]; scans: Record<string, RootScan>;
  onLocate: (root: string) => void; onRetry: (root: string) => void; onRemove: (root: string) => void;
}) {
  const offline = roots.flatMap((root) => {
    const scan = scans[root];
    return scan?.status === "offline" ? [{ root, scan: scan as Offline }] : [];
  });
  if (!offline.length) return null;
  return <section className="cp-lib-offline-roots" aria-label="Offline folders">
    <h3 className="cp-project-section-title">Offline</h3>
    {offline.map(({ root, scan }) => {
      const name = root.split("/").pop() || root, copy = offlineCopy(scan.state, scan.volume);
      return <div key={root} className="cp-lib-offline-root" title={`${copy.title}\n${root}`}>
        <IconFolderOffline size={14} className="cp-lib-offline-icon"/>
        <span className="cp-lib-offline-name"><span>{name}</span><small>{copy.title}</small></span>
        {copy.locate && <button type="button" className="cp-lib-tree-act" aria-label={`Locate ${name}`} title="Locate folder…"
          onClick={() => onLocate(root)}>Locate…</button>}
        {copy.retry && <button type="button" className="cp-lib-tree-act" aria-label={`Retry ${name}`} title="Retry" onClick={() => onRetry(root)}>Retry</button>}
        <button type="button" className="cp-lib-tree-act" aria-label={`Remove ${name} from library`} title="Remove from Library"
          onClick={() => onRemove(root)}>×</button>
      </div>;
    })}
  </section>;
}
