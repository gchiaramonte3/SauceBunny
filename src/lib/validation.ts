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

/**
 * True when an error came from YouTube's "Sign in to confirm you're not a bot"
 * challenge — either the raw yt-dlp text or our humanized backend hint
 * (download.rs `YT_AUTH_HINT`). Drives the contextual auth modal.
 */
export function isYouTubeBotError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    m.includes("not a bot") ||
    m.includes("confirm you're not a bot") ||
    m.includes("sign in to confirm") ||
    m.includes("youtube auth")
  );
}

/**
 * True when a fetch failed because the SOURCE needs the user's login cookies —
 * YouTube's bot-check, or any login-gated site (Reddit now requires it, others
 * may follow). Catches both raw yt-dlp text and our humanized backend hints.
 * Drives the contextual cookie reminder for ANY site, not just YouTube.
 */
export function needsCookiesError(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    isYouTubeBotError(msg) ||
    m.includes("account authentication is required") ||
    m.includes("requires you to be signed in") ||
    m.includes("--cookies-from-browser") ||
    m.includes("use --cookies") ||
    m.includes("reuses those cookies")
  );
}

/**
 * True when an error reads like a STALE yt-dlp extractor — the classic
 * "YouTube changed something and yt-dlp shipped a fix days later" breakage
 * class (nsig/signature solvers, player-response parsing, format maps, CDN
 * 403s on stale URLs). These failures are fixed by updating yt-dlp and
 * retrying, so they drive the one-click "Update yt-dlp & retry" action on
 * the canvas error overlay.
 *
 * Precedence contract (tested): the auth/cookies flow OWNS its error class —
 * any message `needsCookiesError` claims is NEVER rot, even when a rot
 * signature appears in the same text (a sign-in wall isn't fixed by an
 * update). Genuinely-unavailable videos (unavailable/private/removed/
 * age-gated) are excluded the same way.
 */
export function looksLikeExtractorRot(errText: string): boolean {
  if (!errText) return false;
  const m = errText.toLowerCase();
  // 1) Auth flow wins — the sign-in reminder (YouTubeAuthModal) already
  //    handles these; offering an engine update would point users away
  //    from the actual fix.
  if (needsCookiesError(errText)) return false;
  // 2) Genuinely unavailable — no yt-dlp update will bring these back.
  if (
    m.includes("video unavailable") ||
    m.includes("private video") ||
    m.includes("this video is private") ||
    m.includes("removed") ||
    m.includes("confirm your age") ||
    m.includes("age-restricted") ||
    m.includes("age restricted")
  ) {
    return false;
  }
  // 3) The classic extractor-rot signatures.
  if (
    // player response / player js / initial data / ytcfg / signature
    // timestamp… — all surface as "Unable to extract <thing>".
    m.includes("unable to extract") ||
    m.includes("nsig extraction failed") ||
    m.includes("signature extraction failed") ||
    m.includes("precondition check failed") ||
    m.includes("requested format is not available") ||
    // "Failed to extract any player response", "player response is not
    // valid JSON" — variants that don't say "unable to extract".
    m.includes("player response")
  ) {
    return true;
  }
  // A 403 from the video CDN is rot ONLY in a YouTube/googlevideo context
  // (stale signed URLs) — anywhere else it's a real permissions refusal.
  if (m.includes("http error 403") && /youtube|googlevideo|youtu\.be/.test(m)) {
    return true;
  }
  return false;
}

/** Human-friendly site name from a hostname, for cookie-reminder copy.
 *  "www.reddit.com" → "Reddit", "youtu.be" → "YouTube". */
export function prettyHost(host: string): string {
  const h = host.replace(/^www\./, "").toLowerCase();
  const known: Record<string, string> = {
    "reddit.com": "Reddit",
    "youtube.com": "YouTube",
    "youtu.be": "YouTube",
    "vimeo.com": "Vimeo",
    "tiktok.com": "TikTok",
    "twitter.com": "X",
    "x.com": "X",
    "instagram.com": "Instagram",
    "facebook.com": "Facebook",
    "twitch.tv": "Twitch",
  };
  // Match by registrable-domain suffix, not exact host — otherwise
  // old.reddit.com → "Old" and mobile.twitter.com → "Mobile" in the
  // sign-in reminder copy.
  for (const [k, v] of Object.entries(known)) {
    if (h === k || h.endsWith("." + k)) return v;
  }
  const label = h.split(".")[0] || h;
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "this site";
}
