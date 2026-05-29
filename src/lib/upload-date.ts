// yt-dlp gives upload_date as YYYYMMDD. Render as "Apr 24, 2026".
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function formatUploadDate(raw: string | null): string | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  const y = parseInt(raw.slice(0, 4), 10);
  const m = parseInt(raw.slice(4, 6), 10);
  const d = parseInt(raw.slice(6, 8), 10);
  if (m < 1 || m > 12) return null;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function formatViewCount(n: number | null): string | null {
  if (n == null) return null;
  if (n < 1000) return `${n} views`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K views`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views`;
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B views`;
}

export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
