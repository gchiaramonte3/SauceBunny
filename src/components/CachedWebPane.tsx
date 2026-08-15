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

  // A confirm step, but only where there is something to lose. CLAUDE.md's
  // co-review rule is that a multi-GB consequence gets named in the control
  // the user clicks and never only in a tooltip; deleting one is the same
  // bargain in reverse, and this button was breaking the rule it was written
  // under. Resolve-only rows keep their single click: the whole cost of
  // forgetting one is the ten seconds of extraction it was saving.
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    // An armed row disarms itself. A confirm that stays hot is a mine: the
    // next ordinary click on this card would be the destructive one.
    const t = setTimeout(() => setArmed(null), 4000);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setArmed(null); };
    window.addEventListener("keydown", esc);
    return () => { clearTimeout(t); window.removeEventListener("keydown", esc); };
  }, [armed]);

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
            {g.items.map((it) => {
              const isArmed = armed === it.url;
              const size = it.size_bytes ? formatBytes(it.size_bytes) : "the copy";
              return (
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
                  className={"cp-web-forget" + (isArmed ? " armed" : "")}
                  title={it.path
                    ? "Delete the downloaded copy from this Mac. The source stays online."
                    : "Forget this resolve. Nothing is on disk; re-opening extracts again."}
                  aria-label={isArmed
                    ? `Confirm deleting the ${size} copy of ${it.title ?? it.url}`
                    : it.path
                      ? `Delete the ${size} copy of ${it.title ?? it.url}`
                      : `Forget ${it.title ?? it.url}`}
                  onClick={() => {
                    if (!it.path) { forget(it.url); return; }
                    if (isArmed) { setArmed(null); forget(it.url); return; }
                    setArmed(it.url);
                  }}
                >
                  {isArmed
                    ? <span className="cp-web-forget-label">Delete {size}</span>
                    : <IconCircleX size={13} />}
                </button>
              </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
