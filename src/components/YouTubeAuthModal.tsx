import { useEffect } from "react";
import type { Defaults } from "./SettingsModal";

/** The browser identifiers we can borrow YouTube cookies from. Derived from
 *  the canonical Defaults union so this list can never drift from Settings. */
type Browser = Defaults["ytCookiesBrowser"];
type RealBrowser = Exclude<Browser, "none">;

const REAL_BROWSERS: RealBrowser[] = ["chrome", "safari", "firefox", "brave", "edge"];
const LABELS: Record<RealBrowser, string> = {
  chrome: "Chrome",
  safari: "Safari",
  firefox: "Firefox",
  brave: "Brave",
  edge: "Edge",
};

/**
 * Contextual "Connect YouTube" sheet. Pops the moment a YouTube bot-check
 * blocks a fetch so the user can borrow their browser's existing YouTube
 * login (cookies) without digging through Settings.
 *
 * This is cookie-borrowing ONLY — never a password / credential form and
 * never account creation. Picking a browser sets `defaults.ytCookiesBrowser`
 * (the exact same mechanism as Settings → YouTube auth) and retries the
 * source with `--cookies-from-browser` threaded into yt-dlp.
 */
export function YouTubeAuthModal({
  open,
  current,
  onPick,
  onClose,
}: {
  open: boolean;
  current: Browser;
  onPick: (b: RealBrowser) => void;
  onClose: () => void;
}) {
  // Self-contained Esc handling (capture phase so it beats the App-level
  // shortcut handler) — the modal owns its own dismissal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="cp-modal-backdrop" onClick={onClose}>
      <div
        className="cp-modal cp-ytauth"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Connect YouTube"
      >
        <div className="cp-modal-header">
          <h2>Connect YouTube</h2>
          <div className="filler" />
          <button className="cp-modal-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="cp-ytauth-body">
          <p className="cp-ytauth-lead">
            YouTube is asking Sauce Bunny to <strong>confirm you're not a bot</strong>. Pick a
            browser you're already signed into on this Mac — Sauce Bunny will reuse its YouTube
            cookies so playback and downloads keep working.
          </p>

          <div className="cp-ytauth-browsers">
            {REAL_BROWSERS.map((b) => (
              <button
                key={b}
                type="button"
                className={"cp-ytauth-browser" + (current === b ? " active" : "")}
                onClick={() => onPick(b)}
                title={`Use your ${LABELS[b]} YouTube login`}
              >
                <span className="cp-ytauth-browser-name">{LABELS[b]}</span>
                {current === b && <span className="cp-ytauth-browser-tag">current</span>}
              </button>
            ))}
          </div>

          <p className="cp-ytauth-note">
            Cookies are read locally and never leave your Mac — no password required. Chrome, Brave,
            and Edge may prompt your macOS keychain. You can change this anytime in{" "}
            <strong>Settings → YouTube auth</strong>.
          </p>
        </div>

        <div className="cp-ytauth-foot">
          <button type="button" className="cp-ytauth-dismiss" onClick={onClose}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
