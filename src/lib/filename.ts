/** Byte budget for the user-visible BASE filename. macOS/APFS caps a full
 *  filename at 255 UTF-8 BYTES; 180 leaves room for uniquing suffixes
 *  ("-12"), pipeline suffixes, and extensions. MIRRORED in
 *  src-tauri/src/commands/mod.rs MAX_BASE_BYTES — keep both in sync. */
export const MAX_BASE_BYTES = 180;

const utf8 = new TextEncoder();

/** Truncate to the UTF-8 byte budget WITHOUT splitting a multi-byte
 *  character: accumulate whole code points until the next one would
 *  overflow. Mirrors Rust's truncate_utf8_bytes. */
export function truncateUtf8Bytes(s: string, max = MAX_BASE_BYTES): string {
  if (utf8.encode(s).length <= max) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const b = utf8.encode(ch).length;
    if (bytes + b > max) break;
    out += ch;
    bytes += b;
  }
  return out;
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\/\\:*?"<>|\0\x00-\x1f]/g, "_")
    .replace(/^\.+|\.+$/g, "");
  // Exact-budget cut for user-typed names (mirrors Rust sanitize_filename);
  // trailing separators left by the cut are noise.
  return truncateUtf8Bytes(cleaned).replace(/[-_.\s]+$/, "");
}

export function suggestFilename(title: string): string {
  // Strip leading/trailing non-alphanumerics so we don't end up with files
  // like  `'Most-TERRIFYING-Answer-I've-Had-...`  whose leading apostrophe
  // is technically valid but looks like a typo.
  const cleaned = sanitizeFilename(title || "clip")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "");
  // SUGGESTED names prefer ending on a whole word. sanitizeFilename already
  // applied the byte cut, so detect "the title was cut" from the ORIGINAL's
  // byte length, then back off to the last "-" boundary (when reasonably
  // deep) so the name never ends mid-word.
  const wasCut = utf8.encode(title || "clip").length > MAX_BASE_BYTES;
  if (wasCut) {
    const dash = cleaned.lastIndexOf("-");
    const trimmed = (dash > 40 ? cleaned.slice(0, dash) : cleaned).replace(/[-_.\s]+$/, "");
    return trimmed || "clip";
  }
  return cleaned || "clip";
}


export function shortenPath(path: string | null, max = 38): string {
  if (!path) return "";
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/** Display-only middle ellipsis for long filenames: keeps the start (most
 *  identifying) and the tail (suffix/extension area). Full string belongs in
 *  the title tooltip. */
export function middleEllipsize(name: string, head = 34, tail = 14): string {
  if (name.length <= head + tail + 1) return name;
  return `${name.slice(0, head)}…${name.slice(-tail)}`;
}
