// yt-dlp gives upload_date as YYYYMMDD. Render as "Apr 24, 2026".
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export function formatUploadDate(raw: string | null): string | null {
  if (!raw || !/^\d{8}$/.test(raw)) return null;
  const y = parseInt(raw.slice(0, 4), 10);
  const m = parseInt(raw.slice(4, 6), 10);
  const d = parseInt(raw.slice(6, 8), 10);
  // The day is checked as well as the month: validating one and not the other
  // let "20260231" through as "Feb 31, 2026". 31 rather than a per-month
  // calendar because this is display hygiene for third-party metadata, not a
  // date library.
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > 31) return null;
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function formatViewCount(n: number | null): string | null {
  if (n == null) return null;
  // "1 views" is wrong, and reachable: a fresh upload, or the unlisted test
  // video someone is reviewing minutes after posting it.
  if (n === 1) return "1 view";
  if (n < 1000) return `${n} views`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K views`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M views`;
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B views`;
}

