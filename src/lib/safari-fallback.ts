/**
 * What to tell someone who picked Safari for cookies and has no Full Disk
 * Access.
 *
 * The old message was a dead end: "Turn on Sauce Bunny in the settings window
 * that just opened, then load the video again." Three things wrong with it.
 *
 *   · It asks for a system permission when one is very often not needed at all.
 *     SAFARI IS THE ONLY BROWSER THAT REQUIRES Full Disk Access — Chrome,
 *     Firefox, Brave and Edge keep their cookies where we can already read
 *     them. If any of those is signed in, switching is one click and no
 *     permission dialog, which is a strictly better outcome than granting the
 *     app access to every file on the Mac.
 *   · "Then load the video again" is not reliably true. macOS does not hand
 *     Full Disk Access to a process that is already running; it offers to quit
 *     and reopen the app. Telling someone to retry sends them back to the same
 *     failure and makes the app look broken twice.
 *   · A toast cannot carry a button in this app, so any instruction it gives
 *     has to be followed from memory. The shorter the instruction, the better
 *     the odds.
 *
 * So: prefer the option that needs no permission, and be honest about the
 * relaunch when there isn't one.
 */

/** Browsers whose cookies we can read with no system permission. */
export const NO_PERMISSION_BROWSERS = ["chrome", "brave", "firefox", "edge"] as const;
export type CookieBrowser = (typeof NO_PERMISSION_BROWSERS)[number] | "safari" | "none";

export function browserLabel(b: string): string {
  return b === "none" ? "your default browser" : b.charAt(0).toUpperCase() + b.slice(1);
}

export type SafariGuidance = {
  title: string;
  body: string;
  /** True when we are steering to another browser rather than a permission. */
  suggestsAlternative: boolean;
  /** The browser being suggested, if any. */
  alternative: string | null;
};

/**
 * Pick the guidance.
 *
 * `ready` is which browsers actually have a cookie database on this Mac, so we
 * never suggest a browser that is not installed — the same lesson
 * `cookie_browser_ready` already encodes for the Settings picker, where an
 * uninstalled browser "sat in the control looking as valid as the rest".
 */
export function safariGuidance(ready: readonly string[]): SafariGuidance {
  const alt = NO_PERMISSION_BROWSERS.find((b) => ready.includes(b)) ?? null;
  if (alt) {
    return {
      title: "Safari needs Full Disk Access",
      body: `${browserLabel(alt)} does not. Switch to it in Settings, Web sources, and sign-ins are picked up with no permission at all.`,
      suggestsAlternative: true,
      alternative: alt,
    };
  }
  return {
    title: "Safari needs Full Disk Access",
    body: "Turn Sauce Bunny on in the window that just opened. macOS will offer to quit and reopen the app; take it, then paste the link again.",
    suggestsAlternative: false,
    alternative: null,
  };
}

/** Said once, when access actually appears — so the loop closes instead of
 *  leaving someone to guess whether it worked. */
export const FDA_GRANTED = {
  title: "Safari sign-ins are on",
  body: "Full Disk Access is granted. Load the video again and your Safari session will be used.",
} as const;

/**
 * Whether the Safari cookie check belongs on screen at all.
 *
 * Cookies are read by ONE thing: yt-dlp, fetching a web source. The check used
 * to run on nothing but the setting - a mount effect keyed on
 * `defaults.ytCookiesBrowser === "safari"` - so anyone who had picked Safari
 * got "Safari needs Full Disk Access. Chrome does not..." pushed at them
 * during whatever they happened to be doing. It was reported arriving over a
 * LOCAL mp4, mid-playback, which is a permission prompt for a subsystem the
 * user was not using and could not have been about to use.
 *
 * `webSourceActive` is the web playback machine being out of `inactive`. A
 * local open never moves it, so a local file cannot raise this. Note that
 * `sourceKind` is NOT a usable gate here: it initialises to "youtube" before
 * any source exists at all.
 *
 * Covered by the unit tests below and NOT by an end-to-end one. An e2e was
 * written and deleted: with the gate removed the notice fires at mount, on the
 * home view, where no toast host is rendered - so it is never seen, the
 * once-per-session ref is spent, and the test passes with the bug fully
 * present. Reproducing it faithfully needs the setting changed while a local
 * source is already open, which is a Settings-modal flow, not a seed. If you
 * add that test, break-test it by deleting the call site rather than the rule.
 */
export function shouldCheckSafariFda(i: {
  cookieBrowser: string;
  webSourceActive: boolean;
}): boolean {
  if (i.cookieBrowser !== "safari") return false;
  return i.webSourceActive;
}
