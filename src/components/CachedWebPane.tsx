import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { groupBySite, siteName, type CachedWebItem } from "../lib/web-source";
import { formatBytes } from "../lib/library";
import { secondsToClock } from "../lib/timecode";
import { IconCircleX, IconDownload, IconLink } from "./Icons";

/**
 * Everything this Mac has pulled off the web, shelved by where it came from.
 *
 * WHY THIS IS NOT THE FILE GRID. A cached web source is not a file with a
 * poster: it is a URL, a remote thumbnail, and — only sometimes — a downloaded
 * copy. Pushing it through the folder pane's item pipeline would mean
 * inventing a path for something that may not have one, and the first thing to
 * break would be every verb that assumes a path (rename, tag, reveal).
 *
 * METADATA-ONLY ENTRIES ARE THE MAJORITY, and they are the point. The app
 * streams most web sources and keeps only the resolve, so a shelf that listed
 * only fully-downloaded clips would show two rows out of forty and look
 * broken. Re-opening a metadata-only entry still skips yt-dlp's extraction,
 * which is the ten to fifteen seconds anyone actually notices.
 */
export function CachedWebPane({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const [items, setItems] = useState<CachedWebItem[] | null>(null);

  const load = useCallback(() => {
    void invoke<CachedWebItem[]>("list_cached_web")
      .then(setItems)
      // A cache that cannot be read is an EMPTY shelf, not an error banner:
      // nothing the user did is wrong and nothing of theirs is lost.
      .catch(() => setItems([]));
  }, []);
  useEffect(load, [load]);

  const forget = useCallback((url: string) => {
    // Optimistic: the row goes now, because the disk work is a file delete and
    // waiting on it makes a instant action feel broken.
    setItems((prev) => prev?.filter((i) => i.url !== url) ?? prev);
    void invoke("forget_cached_web", { url }).catch(load);
  }, [load]);

  if (items === null) return <div className="cp-web-empty">Reading the cache…</div>;
  if (items.length === 0) {
    return (
      <div className="cp-web-empty">
        Nothing cached from the web yet. Fetch a URL and it will appear here,
        ready to re-open without waiting for extraction again.
      </div>
    );
  }

  const groups = groupBySite(items);
  const withCopy = items.filter((i) => i.path).length;
  const bytes = items.reduce((n, i) => n + (i.size_bytes ?? 0), 0);

  return (
    <div className="cp-web-pane">
      <div className="cp-web-summary">
        {items.length} cached · {withCopy} downloaded
        {bytes > 0 ? ` · ${formatBytes(bytes)} on disk` : ""}
      </div>
      {groups.map((g) => (
        <section key={g.site} className="cp-web-shelf">
          <h3 className="cp-web-shelf-head">
            {g.site}
            <span className="cp-web-count">{g.items.length}</span>
          </h3>
          <ul className="cp-web-grid">
            {g.items.map((it) => (
              <li key={it.url} className="cp-web-card">
                <button
                  type="button"
                  className="cp-web-open"
                  title={it.url}
                  onClick={() => onOpenUrl(it.url)}
                >
                  <span className="cp-web-art">
                    {it.thumbnail
                      ? <img src={it.thumbnail} alt="" loading="lazy" />
                      : <IconLink size={20} />}
                    {it.duration_seconds != null && (
                      <span className="cp-web-dur">{secondsToClock(it.duration_seconds)}</span>
                    )}
                    {/* Downloaded vs resolve-only is the one fact that changes
                        what re-opening costs, so it is on the art, not buried
                        in a tooltip. */}
                    {it.path && (
                      <span className="cp-web-have" title="A full copy is on this Mac">
                        <IconDownload size={11} />
                      </span>
                    )}
                  </span>
                  <span className="cp-web-title">{it.title ?? it.url}</span>
                  <span className="cp-web-sub">
                    {it.uploader ?? siteName(it.url)}
                    {it.size_bytes ? ` · ${formatBytes(it.size_bytes)}` : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="cp-web-forget"
                  title="Forget this cached copy. The source stays online; this only reclaims disk."
                  aria-label={`Forget ${it.title ?? it.url}`}
                  onClick={() => forget(it.url)}
                >
                  <IconCircleX size={13} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
