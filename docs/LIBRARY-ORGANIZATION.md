# Library organization

User-approved implementation, September 15, 2026. Keep Home and the existing
Library appearance. This is organization, not media acquisition or a file-manager
replacement. No build, installation or publication is implied.

## Acceptance checklist

- [x] Nested in-app folders can reference local media, web links, transcripts
  and saved Multitrack documents. One item can belong to multiple folders.
- [x] Create, rename, remove, nest and membership changes have keyboard routes,
  pointer drag equivalents where applicable, and undo/redo. Removal never deletes
  original media or transcripts.
- [x] Sidebar distinguishes Favorites, Projects and Folders on Disk. The plus
  menu distinguishes New in-app folder from Add folder from disk.
- [x] Favorites can pin disk/project locations and be reordered.
- [x] Move original on disk has a complete destination picker, including deep
  folders; creation from All asks for an explicit destination.
- [x] Smart folders persist query rules and recompute results from current data.
- [x] Every scanned item is reachable beyond the old 300-item cap, and deep
  directories load on demand without registering redundant roots.
- [x] Organization persists across restart, remains visible with missing drives,
  follows in-app media renames, and offers explicit relinking. Failed, corrupt,
  newer-format and conflicting saves cannot silently erase prior work.
- [x] Tests cover persistence/concurrency, hierarchy, undo, mixed-source opening,
  pointer/keyboard interactions, narrow/enlarged layouts and original-file safety.

## Data boundaries

Project folders store references, not copies. Disk operations stay explicit and
continue through the existing rename/repath machinery. Existing web collections
and transcript projects remain intact; no automatic filesystem migration.

The organization document is user-authored data in Documents/Sauce Bunny/Library,
not a cache. Asset IDs remain stable when paths change. Folder undo restores
organization, never an older asset-path snapshot. Saves acknowledge durable native
writes, not a renderer debounce; compare-and-save rejects stale documents.

## Verification

Completed in source, September 15, 2026:

- `npm run verify`: all gates passed, including TypeScript, lint, native
  compilation/Clippy, 729 Rust unit tests, sidecar/packaging policies, the AAF
  reader and 446 Chromium cases. Existing ignored/skipped cases remain.
- Final frontend recheck: TypeScript, 4,253 tests and lint passed, including
  the additional mixed-source dispatch and stale-dialog regressions.
- Final Library acceptance set: all 10 cases passed in Chromium and WebKit.
  This includes folder nesting, pointer/keyboard filing, Option-copy, undo/redo,
  favorite reordering, offline relink, saved Multitrack/transcript opening,
  dynamic smart results, narrow/enlarged text, all 318 paginated media items,
  page-only selection, deep destinations, and disk Favorites without redundant
  root registration. Layout screenshots were visually inspected.
- Model/store tests exercise compare-and-save conflicts, failed writes/reads,
  malformed/newer versions, pending-save reloads, failed undo, rename/relink
  continuity and stable identities. Native tests use isolated temporary files
  and verify that original asset bytes remain untouched and separate handles
  cannot bypass the writer lock.
- Catalog tests cover 500-path batching, stale-refresh cancellation, unknown
  access versus offline state, hidden-media discovery and explicit references.
  Dialog tests preserve membership changed while editing and refuse to
  resurrect a deleted folder.

Browser tests mock native IPC. Native persistence tests exercise real temporary
files; they do not certify the installed WKWebView application or network drives.
No user originals were moved, no live capture was started, and no app/DMG was
installed, published or pushed. Home's production appearance is unchanged.
