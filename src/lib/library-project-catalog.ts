import { invoke } from "@tauri-apps/api/core";
import type { CachedWebItem } from "../bindings/CachedWebItem";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import type { TranscriptFile } from "../bindings/TranscriptFile";
import type { LibraryReferenceStatus } from "../bindings/LibraryReferenceStatus";
import type { TaggedPath } from "../bindings/TaggedPath";
import type { LibraryFolder } from "../types";
import { collectLibraryItems } from "./library";
import { assetKey, type LibraryAsset, type LibraryAssetFacts, type LibraryAssetKind } from "./library-organization";
import { getHistory, type TranscriptHistoryEntry } from "./transcript-history";
import { mergeTranscriptLibrary } from "./transcript-library";
import { reviewStatusForKey } from "./review-store";
import { pathKey } from "./repath";
import { withoutHidden } from "./library-hidden";
import { formatError } from "./error-format";

export type ProjectCatalog = {
  assets: LibraryAsset[];
  facts: Map<string, LibraryAssetFacts>;
  transcripts: Map<string, TranscriptHistoryEntry>;
  errors: string[];
};
export const unknownAssetFacts: LibraryAssetFacts = { tags: [], transcribed: null, needsReview: null, offline: null };
export const assetKindLabel: Record<LibraryAssetKind, string> = { file: "Local media", web: "Web link", transcript: "Transcript", multitrack: "Multitrack" };
export function libraryAsset(kind: LibraryAssetKind, locator: string, title?: string): LibraryAsset {
  return { id: `item:${assetKey({ kind, locator })}`, kind, locator, title: title || locator.split("/").pop() || locator };
}

/** Read-only catalog. Partial failures are visible, and unknown availability is
 * never mislabeled as offline. No media downloads or thumbnail generation. */
export async function loadProjectCatalog(trees: LibraryFolder[], references: LibraryAsset[], transcriptLibrary: string, signal?: AbortSignal): Promise<ProjectCatalog> {
  signal?.throwIfAborted();
  const errors: string[] = [];
  const read = async <T,>(name: string, promise: Promise<T[]>): Promise<T[]> => {
    try { const rows = await promise; if (!Array.isArray(rows)) throw new Error("Source returned no list. Update the running app."); return rows; }
    catch (cause) { errors.push(`${name}: ${formatError(cause)}`); return []; }
  };
  const [web, sequences, files] = await Promise.all([
    read("Web library", invoke<CachedWebItem[]>("list_cached_web")),
    read("Multitrack", invoke<AafDocumentSummary[]>("aaf_list")),
    transcriptLibrary ? read("Transcripts", invoke<TranscriptFile[]>("scan_transcript_library", { path: transcriptLibrary })) : Promise.resolve([] as TranscriptFile[]),
  ]);
  signal?.throwIfAborted();
  const history = getHistory(), transcripts = mergeTranscriptLibrary(files, history);
  const catalog = [
    ...references,
    ...withoutHidden(trees.flatMap(collectLibraryItems)).map((item) => libraryAsset("file", item.path, item.name)),
    ...web.map((item) => libraryAsset("web", item.url, item.title || item.url)),
    ...transcripts.map((item) => libraryAsset("transcript", item.path, item.title)),
    ...sequences.map((item) => libraryAsset("multitrack", item.id, item.name)),
  ];
  const byKey = new Map<string, LibraryAsset>();
  for (const asset of catalog) if (!byKey.has(assetKey(asset))) byKey.set(assetKey(asset), asset);
  const assets = [...byKey.values()], paths = [...new Set(assets.filter((a) => a.kind === "file" || a.kind === "transcript").map((a) => a.locator))];
  const status = new Map<string, boolean | null>(), tags = new Map<string, string[]>();
  for (let offset = 0; offset < paths.length; offset += 500) {
    signal?.throwIfAborted();
    const batch = paths.slice(offset, offset + 500);
    const [availability, tagged] = await Promise.all([
      read("File availability", invoke<LibraryReferenceStatus[]>("library_reference_status", { paths: batch })),
      read("Finder tags", invoke<TaggedPath[]>("read_finder_tags", { paths: batch })),
    ]);
    for (const item of availability) status.set(pathKey(item.path), item.exists === null ? null : !item.exists);
    for (const item of tagged) tags.set(pathKey(item.path), item.tags.map((tag) => tag.name));
  }
  signal?.throwIfAborted();
  const sequencesById = new Map(sequences.map((s) => [s.id, s]));
  const transcribedPaths = new Set(history.flatMap((h) => h.sourcePath ? [pathKey(h.sourcePath)] : []));
  const transcribedUrls = new Set(history.flatMap((h) => h.sourceUrl ? [h.sourceUrl] : []));
  const facts = new Map<string, LibraryAssetFacts>();
  for (const asset of assets) {
    const local = asset.kind === "file" || asset.kind === "transcript";
    const sequence = asset.kind === "multitrack" ? sequencesById.get(asset.locator) : undefined;
    const review = reviewStatusForKey(asset.locator);
    facts.set(assetKey(asset), { tags: local ? tags.get(pathKey(asset.locator)) ?? [] : [],
      offline: local ? status.get(pathKey(asset.locator)) ?? null : asset.kind === "multitrack" ? (errors.some((e) => e.startsWith("Multitrack:")) ? null : !sequence) : null,
      transcribed: asset.kind === "transcript" ? true : asset.kind === "multitrack" ? (sequence ? sequence.transcribed_tracks > 0 : null) : asset.kind === "file" ? transcribedPaths.has(pathKey(asset.locator)) : transcribedUrls.has(asset.locator),
      needsReview: review ? review.state === "changes" : null,
    });
  }
  return { assets, facts, transcripts: new Map(transcripts.map((t) => [pathKey(t.path), t.entry])), errors: [...new Set(errors)] };
}

export function projectTranscriptEntry(asset: LibraryAsset, catalog: ProjectCatalog): TranscriptHistoryEntry {
  return catalog.transcripts.get(pathKey(asset.locator)) ?? { id: asset.id, srtPath: asset.locator, sourcePath: null, sourceUrl: null, title: asset.title, origin: "unknown", createdAt: 0, lastOpenedAt: 0 };
}
