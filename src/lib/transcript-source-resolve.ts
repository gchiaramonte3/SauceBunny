// Poster art for a transcript card/row, with RE-ASSOCIATION for source-less
// transcripts. Most transcripts on the Home "Transcribed" shelf are synthesized
// scan entries (no history row → sourcePath/sourceUrl both null), so their card
// used to fall to a glyph even when the source is right there in Continue /
// recents. Here we match the transcript's filename slug back to a known recent
// source (whose SRT was named from that source's title) and reuse its poster.
//
// No new poster machinery — a resolved LOCAL path flows through the existing
// `requestThumb` lazy decoder; a resolved URL through youTubeThumbnailUrl ??
// webPosterFor, exactly like the reader's rowArt.

import { suggestFilename } from "./filename";
import { youTubeThumbnailUrl } from "./validation";
import { webPosterFor } from "./web-poster-store";
import { mediaKindOf } from "./import-extensions";
import type { RecentSource } from "./recent-sources";
import type { LibraryTranscript } from "./transcript-library";
import type { LibraryCardArt } from "../components/LibraryCard";

export type RecentIndexEntry = { slug: string; source: RecentSource };

/** Precompute recent sources' title slugs once (longest/most-specific first),
 *  so the per-card match is a cheap scan. Memoize on the recents array. */
export function buildRecentIndex(recents: RecentSource[]): RecentIndexEntry[] {
  return recents
    .map((source) => ({ slug: suggestFilename(source.title), source }))
    .filter((e) => e.slug.length > 0)
    .sort((a, b) => b.slug.length - a.slug.length);
}

function remoteArt(url: string): LibraryCardArt {
  return { kind: "remote", url: youTubeThumbnailUrl(url) ?? webPosterFor(url) };
}

/** Art for a transcript. Uses its own source keys when present; otherwise
 *  re-associates a source-less transcript to a recent source by slug. Returns
 *  the glyph-fallback (`remote`/null) when nothing matches. */
export function transcriptArt(t: LibraryTranscript, index: RecentIndexEntry[]): LibraryCardArt {
  const e = t.entry;
  if (e.sourcePath) return { kind: "local", path: e.sourcePath, media: mediaKindOf(e.sourcePath) };
  if (e.sourceUrl) return remoteArt(e.sourceUrl);

  const slug = suggestFilename(t.title);
  if (slug) {
    // Exact slug, or the longest recent-slug that's a prefix at a separator
    // boundary — so caption/range/uniquing suffixes (".en", "-orig", "-in-out",
    // "-2") still match their source without "Foo" matching "Foobar".
    for (const { slug: rs, source } of index) {
      if (rs === slug || (slug.startsWith(rs) && /^[.-]/.test(slug.slice(rs.length)))) {
        return source.kind === "file"
          ? { kind: "local", path: source.value, media: mediaKindOf(source.value) }
          : remoteArt(source.value);
      }
    }
  }
  return { kind: "remote", url: null };
}
