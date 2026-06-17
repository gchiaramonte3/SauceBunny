import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import { CollapsibleSection } from "./CollapsibleSection";
import type { Defaults } from "./SettingsModal";

/** Mirrors the Rust `YtdlpStatus` struct returned by ytdlp_version/update_ytdlp. */
type YtdlpStatus = { version: string; updated: boolean };

const BROWSERS = ["none", "chrome", "safari", "firefox", "brave", "edge"] as const;
const PREVIEW_HEIGHTS = [480, 720, 1080] as const;

function browserLabel(b: string): string {
  return b === "none" ? "your default browser" : b[0].toUpperCase() + b.slice(1);
}

/**
 * The "Web sources" Settings tab — everything that applies to any web video you
 * paste (YouTube, Vimeo, Reddit, X, LinkedIn, …), not just YouTube:
 *   1. Sign in: which browser to borrow cookies from + a one-click link to log
 *      into YouTube in that browser + a Full Disk Access shortcut (Safari only).
 *   2. Preview: resolution cap for the throwaway scrub/mark download (export
 *      quality is independent).
 *   3. Engine: the yt-dlp version in use + an Update button (yt-dlp ships fixes
 *      for site changes constantly) + Reset-to-bundled.
 *
 * This is cookie-borrowing ONLY — Sauce Bunny never sees a password and never
 * creates an account. Cookies are read locally by yt-dlp and never leave the Mac.
 * (Component/file name kept as YouTubeSettings to avoid churn; it's web-generic.)
 */
export function YouTubeSettings({
  defaults,
  setDefaults,
  sectionOpen,
  toggleSection,
}: {
  defaults: Defaults;
  setDefaults: (d: Defaults) => void;
  sectionOpen: (id: string) => boolean;
  toggleSection: (id: string) => void;
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

  // Contextual hint under the browser picker — collapses the old standalone
  // "Full Disk Access" row + the per-browser permission caveats into one line
  // that changes with the selection (progressive disclosure).
  const cookieNote: { text: string; action?: { label: string; fn: () => void } } =
    browser === "safari"
      ? { text: "Safari needs Full Disk Access — grant it, then it picks up your sign-ins automatically.", action: { label: "Grant access ↗", fn: openFda } }
      : browser === "firefox"
        ? { text: "Firefox needs no extra permission." }
        : browser === "none"
          ? { text: "Public videos only — pick a browser to load age-gated or members-only sources." }
          : { text: `${browser[0].toUpperCase() + browser.slice(1)} asks for your Mac password once to read its cookies.` };

  return (
    <section>
      <h3 className="cp-pane-title">Web sources</h3>
      <p className="cp-pane-sub">
        How any pasted web video loads — YouTube, Vimeo, Reddit, X, and anywhere yt-dlp supports.
        100% local: Sauce Bunny borrows your browser's cookies but never sees your password, and
        nothing leaves your Mac.
      </p>

      <CollapsibleSection id="web-signin" label="Sign in" open={sectionOpen("web-signin")} onToggle={() => toggleSection("web-signin")}>
        <div className="cp-pane-row">
          <div className="k">
            Browser cookies
            <span className="desc">Borrow a browser's sign-in so gated sites stay reliable.</span>
          </div>
          <div className="v">
            <div
              className="cp-segmented"
              style={{ minWidth: 320, ["--seg-count"]: BROWSERS.length, ["--seg-active"]: Math.max(0, BROWSERS.indexOf(browser)) } as CSSProperties}
            >
              {BROWSERS.map((b) => (
                <button
                  key={b}
                  className={browser === b ? "active" : ""}
                  onClick={() => setDefaults({ ...defaults, ytCookiesBrowser: b })}
                  title={b === "none" ? "Don't send cookies" : `Read cookies from ${b}`}
                >
                  {b === "none" ? "Off" : b[0].toUpperCase() + b.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Contextual note — replaces the standalone Full Disk Access row +
            the per-browser permission caveats; changes with the selection. */}
        <div className="cp-pane-note">
          <span>{cookieNote.text}</span>
          {cookieNote.action && (
            <button className="btn btn-ghost" onClick={cookieNote.action.fn}>
              {cookieNote.action.label}
            </button>
          )}
        </div>

        <div className="cp-pane-row">
          <div className="k">
            YouTube account
            <span className="desc" title={`Opens YouTube in ${browserLabel(browser)} so you can log in; Sauce Bunny then picks up the cookies automatically.`}>
              Sign in once for reliable, bot-check-free loads.
            </span>
          </div>
          <div className="v">
            <button className="btn btn-ghost" onClick={signIn}>
              Open YouTube ↗
            </button>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="web-preview" label="Preview" open={sectionOpen("web-preview")} onToggle={() => toggleSection("web-preview")}>
        <div className="cp-pane-row">
          <div className="k">
            Preview quality
            <span className="desc" title="Resolution of the throwaway scrub/mark copy. Lower = smaller + faster. Your exported clip uses the export-form quality, not this.">
              The scrub copy only — your export uses the export-form quality.
            </span>
          </div>
          <div className="v">
            <div
              className="cp-segmented"
              style={{ minWidth: 240, ["--seg-count"]: PREVIEW_HEIGHTS.length, ["--seg-active"]: Math.max(0, PREVIEW_HEIGHTS.indexOf(defaults.previewMaxHeight)) } as CSSProperties}
            >
              {PREVIEW_HEIGHTS.map((h) => (
                <button
                  key={h}
                  className={defaults.previewMaxHeight === h ? "active" : ""}
                  onClick={() => setDefaults({ ...defaults, previewMaxHeight: h })}
                  title={`Download web previews at up to ${h}p`}
                >
                  {h}p
                </button>
              ))}
            </div>
          </div>
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="web-engine" label="Engine" open={sectionOpen("web-engine")} onToggle={() => toggleSection("web-engine")}>
        <div className="cp-pane-row">
          <div className="k">
            yt-dlp version
            <span className="desc">
              The tool that reads YouTube + other sites — update if videos stop loading.{" "}
              {status?.updated ? "Using your updated copy." : "Using the bundled copy."}
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
      </CollapsibleSection>
    </section>
  );
}
