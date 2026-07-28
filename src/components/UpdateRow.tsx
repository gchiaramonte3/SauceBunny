import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  checkForUpdate, loadLastCheck, type UpdateStatus,
} from "../lib/update-check";

/**
 * Settings > About: what version am I running, and is there a newer one.
 *
 * Check-only by design. It reports and links; it does not install. A
 * self-replacing un-notarized app turns a working install into a Gatekeeper
 * problem, so installing waits for notarization (see
 * _design/versioning-and-updates.md).
 *
 * The version shown is read from the bundle at runtime, never hardcoded - the
 * About tab used to claim v0.1.0 while the app was 0.2.0, which is exactly the
 * drift the version scheme exists to prevent.
 */
export function UpdateRow() {
  const [version, setVersion] = useState<string | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(() => loadLastCheck()?.status ?? null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  const check = async () => {
    if (!version) return;
    setChecking(true);
    try {
      setStatus(await checkForUpdate(version));
    } finally {
      setChecking(false);
    }
  };

  const openDownload = (url: string) => {
    // Failure is survivable: the release page is in the app menu too.
    invoke("open_external_url", { url }).catch(() => { /* ignore */ });
  };

  return (
    <div className="cp-pane-row">
      <div className="k">
        Version
        <span className="desc">
          Sauce Bunny checks a public list of releases. Nothing about you or your
          media is sent.
        </span>
      </div>
      <div className="v cp-update-row">
        <code className="cp-update-ver">{version ?? "…"}</code>
        {status?.kind === "available" && (
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => openDownload(status.url)}
          >
            Get {status.version}
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => { void check(); }}
          disabled={checking || !version}
        >
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {status?.kind === "current" && <span className="cp-update-note">Up to date</span>}
        {status?.kind === "unknown" && (
          <span className="cp-update-note">Couldn&apos;t check right now</span>
        )}
      </div>
    </div>
  );
}
