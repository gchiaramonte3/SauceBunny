import { formatBytes } from "../lib/format-bytes";

/** All model families share the same neutral download treatment. Unknown size
 * stays indeterminate; byte events are queryable, not a live-announcement flood. */
export function ModelDownloadProgress({ name, done = 0, total = 0, percent: suppliedPercent }: { name: string; done?: number; total?: number; percent?: number }) {
  const bytesKnown = Number.isFinite(total) && total > 0 && Number.isFinite(done);
  const completed = bytesKnown ? Math.max(0, Math.min(done, total)) : 0;
  const percent = bytesKnown ? completed / total * 100 : suppliedPercent !== undefined && Number.isFinite(suppliedPercent) ? Math.max(0, Math.min(suppliedPercent, 100)) : undefined;
  const known = percent !== undefined;
  const text = known ? `${Math.round(percent)}%${bytesKnown ? ` · ${formatBytes(completed) || "0 B"} / ${formatBytes(total)}` : ""}` : "Downloading…";
  return <div className="cp-model-progress">
    <div className={`bar${known ? "" : " is-indeterminate"}`} role="progressbar" aria-label={`Downloading ${name}`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={known ? Math.round(percent) : undefined} aria-valuetext={text}>
      {known && <span style={{ width: `${percent}%` }} />}
    </div>
    <span className="meta">{text}</span>
  </div>;
}
