import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import { CollapsibleSection } from "./CollapsibleSection";
import type { Defaults } from "./SettingsModal";
import type { YtdlpStatus } from "../bindings/YtdlpStatus";


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
  // Last-known version seeds the row instantly; the live probe (spawning
  // yt-dlp --version takes a second or two) refreshes it in the background.
  // Without the seed the row sat on "checking…" long enough to read as hung.
  const [status, setStatus] = useState<YtdlpStatus | null>(() => {
    try {
      const raw = localStorage.getItem("saucebunny.ytdlpVersion");
      return raw ? (JSON.parse(raw) as YtdlpStatus) : null;
    } catch { return null; }
  });
  const [busy, setBusy] = useState<"idle" | "checking" | "updating" | "resetting">("checking");
  const [msg, setMsg] = useState<string | null>(null);
  /** Shown only after a stable update turned out to be a no-op. Nightly is not
   *  advertised up front: it is the escalation for someone already stuck. */
  const [offerNightly, setOfferNightly] = useState(false);

  const applyStatus = (s: YtdlpStatus) => {
    setStatus(s);
    try { localStorage.setItem("saucebunny.ytdlpVersion", JSON.stringify(s)); } catch { /* quota */ }
  };
  const refresh = async () => {
    setBusy("checking");
    try {
      applyStatus(await invoke<YtdlpStatus>("ytdlp_version"));
    } catch (e) {
      setMsg(formatError(e));
    } finally {
      setBusy("idle");
    }
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Update the downloader, and be honest when there was nothing to update to.
   *
   * yt-dlp ships extractor fixes to nightly days or weeks before stable. In
   * that window a stable update returns the SAME version already installed, and
   * the old copy still said "Updated to 2026.07.04." - which reads as a repair
   * having happened. Somebody whose downloads are broken then has no idea the
   * button did nothing, and no idea what to try next. So a no-op says so, and
   * names the one thing left.
   */
  const update = async (channel: "stable" | "nightly" = "stable") => {
    setBusy("updating");
    setMsg(null);
    const before = status?.version ?? null;
    try {
      const s = await invoke<YtdlpStatus>("update_ytdlp", { channel });
      applyStatus(s);
      if (before && s.version === before && channel === "stable") {
        setOfferNightly(true);
        setMsg(`Already on the newest stable build (${s.version}). If downloads are still failing, YouTube has probably changed something the stable build has not caught up with yet.`);
      } else {
        setOfferNightly(false);
        setMsg(`Updated to ${s.version}.`);
      }
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

  // Live Full Disk Access state for the Safari note (re-checked on selection
  // and on window focus, so granting in System Settings updates the line).
  const [safariFda, setSafariFda] = useState<boolean | null>(null);
  useEffect(() => {
    if (browser !== "safari") return;
    const check = () => { void invoke<boolean>("safari_fda_status").then(setSafariFda).catch(() => setSafariFda(null)); };
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [browser]);

  // Does the picked browser actually HAVE a cookie database on this Mac?
  // Learned at the click, not from a failed fetch later: a browser that was
  // never installed used to sit in this control looking as valid as the rest,
  // and every resolve then paid a hard yt-dlp error — repeated on every
  // transcribe — that read as the app being broken.
  const [dbReady, setDbReady] = useState<boolean | null>(null);
  useEffect(() => {
    if (browser === "none" || browser === "safari") { setDbReady(null); return; }
    void invoke<boolean>("cookie_browser_ready", { browser })
      .then(setDbReady)
      .catch(() => setDbReady(null));
  }, [browser]);

  // Contextual hint under the browser picker — collapses the old standalone
  // "Full Disk Access" row + the per-browser permission caveats into one line
  // that changes with the selection (progressive disclosure).
  const cookieNote: { text: string; action?: { label: string; fn: () => void } } =
    browser === "safari"
      ? safariFda
        ? { text: "Full Disk Access is on. Safari sign-ins are picked up automatically." }
        : { text: "Safari needs Full Disk Access. Grant it, then sign-ins are picked up automatically.", action: { label: "Grant access ↗", fn: openFda } }
      : browser === "none"
        ? { text: "Public videos only. Pick a browser to load age-gated or members-only sources." }
        : dbReady === false
          ? { text: `${browser[0].toUpperCase() + browser.slice(1)} has no cookie database on this Mac (not installed, or never run). No cookies will be sent. Pick the browser you actually use.` }
          : browser === "firefox"
            ? { text: "Firefox needs no extra permission." }
            : { text: `${browser[0].toUpperCase() + browser.slice(1)} asks for your Mac password once to read its cookies.` };

  return (
    <section>
      <h3 className="cp-pane-title">Web sources</h3>
      <p className="cp-pane-sub">
        How pasted web video loads. 100% local: your browser's cookies are borrowed,
        your password is never seen, and nothing leaves your Mac.
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
            <span className="desc" title={`Opens YouTube in ${browserLabel(browser)} so you can log in; the cookies are picked up automatically.`}>
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
              The scrub copy only. Exports use the export-form quality.
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
              The tool that reads web video sites. Update if videos stop loading.{" "}
              {status?.updated ? "Using your updated copy." : "Using the bundled copy."}
            </span>
          </div>
          <div className="v cp-ytdlp-actions">
            <code className="cp-ytdlp-version">
              {status?.version ?? (busy === "checking" ? "checking…" : "unknown")}
            </code>
            <button className="btn btn-primary" onClick={() => update("stable")} disabled={busy === "updating"}>
              {busy === "updating" ? "Updating…" : "Update yt-dlp"}
            </button>
            {/* Appears only once a stable update has proved to be a no-op. Not
                offered up front: nightly is a daily unreviewed build, and it is
                worth its risk only to somebody whose downloads are already
                failing on the newest stable. */}
            {offerNightly && (
              <button
                className="btn btn-ghost"
                onClick={() => update("nightly")}
                disabled={busy === "updating"}
                title="Nightly carries YouTube fixes days before they reach stable"
              >
                Try the nightly build
              </button>
            )}
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
