const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
]);

/**
 * True if the URL is a YouTube canonical host. Drives the IFrame
 * fast-path: if this returns true we can mount the embed BEFORE yt-dlp
 * returns metadata. Non-YouTube URLs still work — they go through the
 * direct-stream-URL resolve path which adds a 1-2s round trip.
 */
export function isYouTubeUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const normalized = raw.includes("://") ? raw : `https://${raw}`;
    const u = new URL(normalized.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return YT_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Permissive validation — any http(s) URL with a real host. yt-dlp covers
 * ~1,800 sites via dedicated extractors plus a `generic` fallback for any
 * page with embedded video, so we don't try to whitelist hosts; yt-dlp
 * itself surfaces an "Unsupported URL" error if it can't extract.
 */
export function isLikelyVideoUrl(raw: string): boolean {
  if (!raw) return false;
  try {
    const normalized = raw.includes("://") ? raw : `https://${raw}`;
    const u = new URL(normalized.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return !!u.hostname;
  } catch {
    return false;
  }
}

export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  if (!t) return "";
  if (t.includes("://")) return t;
  return `https://${t}`;
}

/**
 * Extract the 11-char YouTube video ID from a watch/youtu.be/shorts/embed
 * URL, or null if it isn't a recognizable YouTube video URL. Used to show
 * the poster image INSTANTLY on paste (r62) — the thumbnail derives purely
 * from the ID, so we don't wait the ~8s for yt-dlp metadata to render a
 * preview frame.
 */
export function youTubeVideoId(raw: string): string | null {
  try {
    const u = new URL(normalizeUrl(raw));
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return /^[\w-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[\w-]{11}$/.test(v)) return v;
      // /shorts/ID, /embed/ID, /live/ID
      const m = u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/);
      if (m) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-quality always-present YouTube thumbnail URL for a video ID.
 *  `hqdefault` exists for every video (unlike maxresdefault). */
export function youTubeThumbnailUrl(raw: string): string | null {
  const id = youTubeVideoId(raw);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : null;
}

/** Pretty display of the source host, e.g. "vimeo.com" or "youtu.be". */
export function hostnameOf(raw: string): string {
  try {
    return new URL(normalizeUrl(raw)).hostname.replace(/^www\./, "");
  } catch {
    return "web";
  }
}
