# Claude Code prompt — warm-boot cache for web sources + local-path clarity

One session. Follows the v3 polish pass; independent of it.

```
Goal: re-opening a previously loaded web source should start playback in
under a second instead of paying yt-dlp's full 10–15s extraction again, and
local files must be unmistakably local (no stream language, no yt-dlp) in
both code and logs.

Read first: src-tauri/src/commands/download.rs (the resolve path, the
download-to-cache fallback around line 1320-1370 which already reuses a
complete cached copy, the audio-cache reuse, and the comment near line 847
noting signed URLs expire ~6h), src/hooks/use-web-playback.ts and
src/lib/web-playback-machine.ts (the state machine that drives resolve →
proxy → MSE), src/App.tsx loadLocalPath (~2134) and the web fetch path,
src-tauri/src/commands/system.rs (get_cache_stats, the startup cache sweep),
src/components/SettingsModal.tsx cache section, CLAUDE.md storage-layout and
build-ID sections.

PART A — local-path purity (small, do first)
1. Audit that no local-file load can invoke yt-dlp or the stream proxy:
   probe_local_file → mediabunny CustomSource → prepare_local_for_playback
   (ffmpeg) is the entire local universe. If any shared helper could route a
   local path into resolve/stream code, guard it with an explicit error
   (fail loud, per the team's philosophy) rather than silently proceeding.
2. Log clarity: local loads must log under a "local" tag with copy like
   "Opening local file" / "Decoding via mediabunny" — never "Resolving
   stream". Verify the status line in App.tsx (~4564) can't show stream copy
   for a local source.

PART B — the media cache: move reusable artifacts out of the sweep
3. Today the startup sweep deletes saucebunny-* cache dirs older than 24h,
   which destroys the deliberately-reusable artifacts (full downloaded
   copies, cached audio tracks) and defeats their "downloaded ONCE and
   reused" design. Create an organized, sweep-exempt layout under
   app_cache_dir()/saucebunny-media/:
     downloads/   (full source copies, existing deterministic keys)
     audio/       (cached audio tracks)
     meta/        (new, part C)
   Migrate the existing writers/readers to these paths (one-time lazy
   migration: check old path if new missing). The >24h sweep continues to
   clean everything ELSE (job scratch, temp remux output) but skips
   saucebunny-media/. Thumbnails already have their own keyed cache; leave
   them, but report them in stats (below).
4. Cache management UI (Settings → the existing cache section): show
   per-category sizes (Downloads / Audio / Metadata / Thumbnails) from an
   extended CacheStats, with a "Clear" button per category plus "Clear all".
   Clearing is always safe: everything regenerates. No automatic size caps —
   just visible sizes and user control (constitution: no artificial limits).

PART C — warm boot for web sources
5. Metadata cache: after a successful yt-dlp metadata extraction, persist the
   parsed Metadata JSON to media/meta/<key>.json (key = the same canonical
   source key the audio cache uses) with a fetched_at timestamp. On fetch of
   a known source, hydrate the UI from this file IMMEDIATELY (title,
   duration, thumbnail) while revalidating in the background only if older
   than 24h. This makes re-open feel instant even before playback starts.
6. Resolved-stream cache: when yt-dlp -g resolves direct CDN URLs, parse the
   expiry (googlevideo carries an `expire=` unix param; if a host's URL has
   no parseable expiry, use fetched_at + 30 minutes as the conservative
   validity) and persist {video_url, audio_url?, format_note, expires_at}
   into the same meta file. On re-open: if now < expires_at minus a 10-minute
   safety margin, SKIP extraction entirely and hand the cached URLs straight
   to the proxy/MSE path. Log "Stream ready from cache". If the cached URL
   then fails (403/network — the proxy's ffmpeg will error), the existing
   onMediaError chain must fall back to a FRESH resolve (not straight to
   download-to-cache): add that one retry-with-fresh-resolve step to the
   state machine in web-playback-machine.ts, with a unit test in its
   existing test file.
7. Cached-copy fast path: if a COMPLETE downloaded copy exists in
   downloads/ for the source, prefer it at path-selection time: boot
   LocalMediaPlayer from the file immediately and skip resolve/proxy
   altogether (today the cached copy is only used as the failure fallback).
   The transcript/audio pipelines already accept the cached copy; verify
   marks/export still reference the original source URL identity, not the
   cache path, in history and review docs.

Wiring: new/changed Rust commands return Result<T, AppError>; derive ts-rs
on any new cross-boundary struct (extended CacheStats, the meta file shape
if it crosses); cargo test --lib to regenerate bindings; bump
BACKEND_BUILD_ID in system.rs AND src/lib/build-id.ts. Rust unit tests:
expire-param parsing (real googlevideo URL fixture, URL without expiry,
garbage), sweep exemption (temp dir older than 24h inside saucebunny-media
survives, sibling outside doesn't).

Verify: cargo check && cargo test --lib from src-tauri/, npx tsc --noEmit &&
npm test && npm run test:e2e, then npm run tauri dev:
- Open a YouTube URL (cold): normal resolve, note the time.
- Close and re-open the same URL within minutes: playback starts from the
  cached stream URL with no yt-dlp extraction in the logs.
- Restart the app entirely and re-open: still warm (meta file persisted;
  sweep spared it).
- Let a stream URL expire (or hand-edit expires_at into the past): re-open
  triggers one fresh resolve, plays, and rewrites the cache.
- Open a local file: logs show only local/mediabunny lines.
- Settings shows the four cache categories; clearing Downloads then
  re-opening the web source falls back to streaming cleanly.
```

Commit: `cache: warm-boot web sources, sweep-exempt media cache, local-path clarity`
