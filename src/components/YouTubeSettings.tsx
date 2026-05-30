import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import type { Defaults } from "./SettingsModal";

/** Mirrors the Rust `YtdlpStatus` struct returned by ytdlp_version/update_ytdlp. */
type YtdlpStatus = { version: string; updated: boolean };

const BROWSERS = ["none", "chrome", "safari", "firefox", "brave", "edge"] as const;

function browserLabel(b: string): string {
  return b === "none" ? "your default browser" : b[0].toUpperCase() + b.slice(1);
}

/**
 * The "YouTube" Settings tab — its own space for everything YouTube/web-source:
 *   1. Sign in: which browser to borrow cookies from + a one-click link to log
 *      into YouTube in that browser + a Full Disk Access shortcut (Safari only).
 *   2. Engine: the yt-dlp version in use + an Update button (yt-dlp ships fixes
 *      for site changes constantly) + Reset-to-bundled.
 *
 * This is cookie-borrowing ONLY — Sauce Bunny never sees a password and never
 * creates an account. Cookies are read locally by yt-dlp and never leave the Mac.
 */
export function YouTubeSettings({
  defaults,
  setDefaults,
}: {
  defaults: Defaults;
  setDefaults: (d: Defaults) => void;
}) {
  const [status, setStatus] = useState<YtdlpStatus | null>(null);
  const [busy, setBusy] = useState<"idle" | "checking" | "updating" | "resetting">("checking");
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    setBusy("checking");
    try {
      setStatus(await invoke<YtdlpStatus>("ytdlp_version"));
    } catch (e) {
      setMsg(formatError(e));
    } finally {
      setBusy("idle");
    }
  };
  useEffect(() => {
    refresh();
  }, []);

  const update = async () => {
    setBusy("updating");
    setMsg(null);
    try {
      const s = await invoke<YtdlpStatus>("update_ytdlp");
      setStatus(s);
      setMsg(`Updated to ${s.version}.`);
    } catch (e) {
      setMsg(`Update failed: ${formatError(e)}`);
    } finally {
      setBusy("idle");
    }
  };

  const reset = async () => {
    setBusy("resetting");
    setMsg(null);
    try {
      await invoke("reset_ytdlp");
      await refresh();
      setMsg("Reverted to the bundled yt-dlp.");
    } catch (e) {
      setMsg(formatError(e));
    } finally {
      setBusy("idle");
    }
  };

  const browser = defaults.ytCookiesBrowser;
  const signIn = () =>
    invoke("open_youtube_signin", { browser: browser === "none" ? null : browser }).catch(() => {});
  const openFda = () => invoke("open_full_disk_access").catch(() => {});

  return (
    <section>
      <h3 className="cp-pane-title">YouTube</h3>
      <p className="cp-pane-sub">
        Sign in once so YouTube stays reliable and you hit far fewer bot checks. Sauce Bunny
        borrows your browser's existing YouTube cookies — it never sees or stores your password,
        and nothing leaves your Mac.
      </p>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Sign in</div>
        <div className="cp-pane-row">
          <div className="k">
            Cookies from browser
            <span className="desc">
              Pick the browser you're already signed into on YouTube. Safari is the best fit on a
              Mac — it's made for macOS — but needs Full Disk Access (granted below). Firefox needs
              no permission; Chrome/Brave/Edge ask for your Mac password once.
            </span>
          </div>
          <div className="v">
            <div
              className="cp-segmented"
              style={{ minWidth: 320, gridTemplateColumns: "repeat(6, 1fr)" }}
            >
              {BROWSERS.map((b) => (
                <button
                  key={b}
                  className={browser === b ? "active" : ""}
                  onClick={() => setDefaults({ ...defaults, ytCookiesBrowser: b })}
                  title={b === "none" ? "Don't send cookies" : `Read YouTube cookies from ${b}`}
                >
                  {b === "none" ? "Off" : b[0].toUpperCase() + b.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="cp-pane-row">
          <div className="k">
            Sign in to YouTube
            <span className="desc">
              Opens YouTube in {browserLabel(browser)} so you can log in. Once you're signed in
              there, Sauce Bunny picks up the cookies automatically.
            </span>
          </div>
          <div className="v">
            <button className="btn btn-ghost" onClick={signIn}>
              Open YouTube ↗
            </button>
          </div>
        </div>

        <div className="cp-pane-row">
          <div className="k">
            Full Disk Access
            <span className="desc">
              Only needed for Safari cookies. Grant Sauce Bunny access in System Settings, then
              come back and pick Safari above.
            </span>
          </div>
          <div className="v">
            <button className="btn btn-ghost" onClick={openFda}>
              Open settings ↗
            </button>
          </div>
        </div>
      </div>

      <div className="cp-pane-section">
        <div className="cp-pane-section-label">Engine</div>
        <div className="cp-pane-row">
          <div className="k">
            yt-dlp version
            <span className="desc">
              yt-dlp is the tool that reads YouTube and other sites. Its maintainers ship fixes
              often when sites change — update here if videos stop loading.{" "}
              {status?.updated ? "Currently using your updated copy." : "Currently using the bundled copy."}
            </span>
          </div>
          <div className="v cp-ytdlp-actions">
            <code className="cp-ytdlp-version">
              {busy === "checking" ? "checking…" : (status?.version ?? "unknown")}
            </code>
            <button className="btn btn-primary" onClick={update} disabled={busy === "updating"}>
              {busy === "updating" ? "Updating…" : "Update yt-dlp"}
            </button>
            {status?.updated && (
              <button className="btn btn-ghost" onClick={reset} disabled={busy === "resetting"}>
                Reset to bundled
              </button>
            )}
          </div>
        </div>
        {msg && <p className="cp-ytdlp-msg">{msg}</p>}
      </div>
    </section>
  );
}
