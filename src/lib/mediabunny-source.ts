import { CustomSource, UrlSource, type Source } from "mediabunny";
import { invoke } from "@tauri-apps/api/core";

/**
 * Back mediabunny's `CustomSource` with native filesystem byte-range reads
 * instead of `UrlSource`'s `asset://` range-fetch.
 *
 * `UrlSource` range-fetches a local file over the Tauri `asset://` protocol,
 * which FAILS on large local files (an 800 MB h264/aac mp4 never loads — the
 * media engine's ranged reads over asset:// stall). mediabunny documents
 * `CustomSource` as the correct source for large local files: it does lazy
 * byte-range reads via a callback. (`FilePathSource` is Node/Bun/Deno-only,
 * so it's unavailable inside WKWebView — `CustomSource` over native fs is the
 * right tool.)
 *
 * `read_file_range` returns RAW bytes (a Tauri IPC `Response`), which resolves
 * to an `ArrayBuffer` on the JS side; we wrap it as a `Uint8Array` of exactly
 * the requested `[start, end)` slice. `prefetchProfile: "fileSystem"` tells
 * mediabunny to prefetch small, page-aligned windows — tuned for local disk,
 * not a high-latency network.
 */
export function localFileSource(path: string): CustomSource {
  return new CustomSource({
    getSize: () => invoke<number>("get_file_size", { path }),
    read: async (start, end) =>
      new Uint8Array(
        await invoke<ArrayBuffer>("read_file_range", {
          path,
          offset: start,
          length: end - start,
        }),
      ),
    prefetchProfile: "fileSystem",
    // Keep more of the file resident (default 8 MiB) so scrubbing back and
    // forth re-reads recently-touched GOP byte ranges from memory instead of
    // re-invoking read_file_range.
    maxCacheSize: 64 * 1024 * 1024,
  });
}

/**
 * Pick the right mediabunny `Source` for a path or URL:
 *   - `http(s)://`  → `UrlSource` (the loopback-proxy / web-stream path;
 *                     behaviour must stay byte-for-byte identical).
 *   - anything else → `localFileSource` (native fs byte-range reads).
 */
export function mediabunnySource(pathOrUrl: string): Source {
  return /^https?:\/\//i.test(pathOrUrl)
    ? new UrlSource(pathOrUrl)
    : localFileSource(pathOrUrl);
}
