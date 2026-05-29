export function sanitizeFilename(name: string): string {
  return name
    .trim()
    .replace(/[\/\\:*?"<>|\0\x00-\x1f]/g, "_")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 200);
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
  return cleaned || "clip";
}

export function stripExt(name: string): string {
  return name.replace(/\.(mp4|mp3|mov|m4a|webm|mkv)$/i, "");
}

export function shortenPath(path: string | null, max = 38): string {
  if (!path) return "";
  if (path.length <= max) return path;
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
