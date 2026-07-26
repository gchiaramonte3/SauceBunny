import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * The ONE place this app mints an `asset://` URL.
 *
 * `app.security.assetProtocol.scope` is no longer `**` (r152). A path is
 * readable over `asset://` only if one of two halves covers it:
 *
 *   STATIC  — anything under `$APPCACHE/**`: every artifact the app writes for
 *             itself. Poster JPEGs (`save_poster_to_cache`,
 *             `generate_local_thumbnail`, `lookup_local_thumbnail`), ffmpeg
 *             playback copies (`prepare_local_for_playback`), downloaded
 *             sources and cached audio tracks. This half has to be static
 *             rather than granted at runtime because these URLs get persisted
 *             into recents and queue rows and re-rendered on a later launch
 *             with no backend call in between.
 *   DYNAMIC — the user's own media, granted ONE FILE AT A TIME by
 *             `probe_local_file` (see `allow_asset_read` in
 *             src-tauri/src/commands/mod.rs). Every local source in the app
 *             passes through that command first, and the webview cannot grant
 *             itself anything.
 *
 * Local files read by mediabunny do NOT come through here: `mediabunnySource`
 * backs them with the `get_file_size` / `read_file_range` commands, which the
 * scope does not gate. This function is for the native `<video>`/`<audio>`
 * element, `<img>` posters, and mediabunny's `UrlSource` audio extractor.
 *
 * A path covered by NEITHER half gets HTTP 403 with an empty body, which shows
 * up as a black video or a broken thumbnail and never as an error — so if you
 * are adding a new kind of path here, make sure something grants it. The Rust
 * side logs a line when a grant fails to take.
 */
export function assetUrl(path: string): string {
  return convertFileSrc(path);
}
