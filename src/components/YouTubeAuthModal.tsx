import { useEffect, type ReactNode } from "react";
import type { Defaults } from "./SettingsModal";

/** The browser identifiers we can borrow YouTube cookies from. Derived from
 *  the canonical Defaults union so this list can never drift from Settings. */
type Browser = Defaults["ytCookiesBrowser"];
type RealBrowser = Exclude<Browser, "none">;

/** Which surface is showing. Drives the copy only — the picker is identical. */
export type YtAuthMode = "welcome" | "blocked" | "severed";

// Ordered by least friction on macOS. Firefox reads cookies with no prompt
// and no special permission (easiest). Chrome/Brave/Edge encrypt theirs → a
// one-time "<Browser> Safe Storage" keychain prompt (click Always Allow).
// Safari's cookies sit in a TCC container → require Full Disk Access for this
// app, so it's LAST (and silently skipped if FDA isn't granted — see
// cookies_args in download.rs, which degrades to no-auth instead of failing).
const REAL_BROWSERS: RealBrowser[] = ["firefox", "chrome", "brave", "edge", "safari"];
const LABELS: Record<RealBrowser, string> = {
  chrome: "Chrome",
  safari: "Safari",
  firefox: "Firefox",
  brave: "Brave",
  edge: "Edge",
};
const HINTS: Record<RealBrowser, string> = {
  firefox: "Easiest",
  chrome: "Mac password",
  brave: "Mac password",
  edge: "Mac password",
  safari: "Full Disk Access",
};

const COPY: Record<YtAuthMode, { title: string; lead: ReactNode; dismiss: string }> = {
  welcome: {
    title: "Connect YouTube",
    lead: (
      <>
        Sign in once so YouTube stays reliable and you hit far fewer{" "}
        <strong>“confirm you’re not a bot”</strong> checks. Pick a browser you’re already
        signed into on YouTube — Sauce Bunny borrows its cookies.
      </>
    ),
    dismiss: "Maybe later",
  },
  blocked: {
    title: "Connect YouTube",
    lead: (
      <>
        YouTube is asking Sauce Bunny to <strong>confirm you’re not a bot</strong>. Pick a
        browser you’re already signed into on this Mac and it’ll retry with your login.
      </>
    ),
    dismiss: "Not now",
  },
  severed: {
    title: "Reconnect YouTube",
    lead: (
      <>
        Your YouTube sign-in <strong>stopped working</strong> — the cookies likely expired or
        you signed out of that browser. Pick your browser again to refresh the connection.
      </>
    ),
    dismiss: "Not now",
  },
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
  mode,
  current,
  onPick,
  onClose,
}: {
  open: boolean;
  mode: YtAuthMode;
  current: Browser;
  onPick: (b: RealBrowser) => void;
  onClose: () => void;
}) {
  const copy = COPY[mode];
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
        aria-label={copy.title}
      >
        <div className="cp-modal-header">
          <h2>{copy.title}</h2>
          <div className="filler" />
          <button className="cp-modal-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="cp-ytauth-body">
          <p className="cp-ytauth-lead">{copy.lead}</p>

          <div className="cp-ytauth-browsers">
            {REAL_BROWSERS.map((b) => (
              <button
                key={b}
                type="button"
                className={
                  "cp-ytauth-browser" +
                  (current === b ? " active" : "") +
                  (b === "firefox" ? " recommended" : "")
                }
                onClick={() => onPick(b)}
                title={
                  b === "firefox"
                    ? "Use your Firefox YouTube login — no prompt, nothing to grant"
                    : b === "safari"
                      ? "Use your Safari login — needs Full Disk Access for Sauce Bunny"
                      : `Use your ${LABELS[b]} login — macOS asks for your Mac password once`
                }
              >
                <span className="cp-ytauth-browser-name">{LABELS[b]}</span>
                <span className="cp-ytauth-browser-hint">{HINTS[b]}</span>
                {current === b && <span className="cp-ytauth-browser-tag">current</span>}
              </button>
            ))}
          </div>

          <p className="cp-ytauth-note">
            Cookies are read locally and never leave your Mac — no account or password is entered.{" "}
            <strong>Firefox</strong> is easiest (no prompt). Chrome/Brave/Edge ask for your Mac login
            password once — click <strong>Always Allow</strong>. Safari needs <strong>Full Disk
            Access</strong> granted to Sauce Bunny. Change anytime in <strong>Settings → YouTube
            auth</strong>.
          </p>
        </div>

        <div className="cp-ytauth-foot">
          <button type="button" className="cp-ytauth-dismiss" onClick={onClose}>
            {copy.dismiss}
          </button>
        </div>
      </div>
    </div>
  );
}
