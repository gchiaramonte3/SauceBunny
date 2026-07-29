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

