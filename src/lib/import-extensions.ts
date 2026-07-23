/**
 * The single source of truth for which file extensions the import
 * surfaces accept. The Toolbar "Import file" dialog and the full-window
 * drag-and-drop target (DropTarget) must stay in sync — both read from
 * here instead of carrying their own copies of the list.
 */

export const VIDEO_EXTENSIONS: string[] = ["mp4", "mov", "m4v", "mkv", "webm", "avi"];
export const AUDIO_EXTENSIONS: string[] = ["mp3", "m4a", "wav", "flac", "ogg", "aac"];
export const TRANSCRIPT_EXTENSIONS: string[] = ["srt", "vtt"];

/** Lowercased extension without the dot; "" when the filename has none. */
export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True when the path looks like a media file the import picker would accept. */
export function isMediaFile(path: string): boolean {
  const ext = fileExtension(path);
  return VIDEO_EXTENSIONS.includes(ext) || AUDIO_EXTENSIONS.includes(ext);
}

/** True when the path looks like a transcript file (.srt/.vtt). */
export function isTranscriptFile(path: string): boolean {
  return TRANSCRIPT_EXTENSIONS.includes(fileExtension(path));
}

/** Media kind of a path, by extension — audio vs (default) video. Shared so
 *  the "audio has no frame to thumbnail" skip isn't forked across the Library
 *  cards and the reader rows. */
export function mediaKindOf(path: string): "video" | "audio" {
  return AUDIO_EXTENSIONS.includes(fileExtension(path)) ? "audio" : "video";
}
