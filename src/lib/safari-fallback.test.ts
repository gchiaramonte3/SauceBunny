import { describe, expect, it } from "vitest";
import { browserLabel, safariGuidance, shouldCheckSafariFda } from "./safari-fallback";

/**
 * The Safari cookie prompt used to be a dead end: it asked for a system-wide
 * permission, told the user to retry in a way that does not reliably work, and
 * carried no button because this app's toasts cannot have one.
 */
describe("guidance when Safari has no Full Disk Access", () => {
  it("steers to a browser that needs NO permission when one is signed in", () => {
    // Strictly better than granting an app access to every file on the Mac.
    const g = safariGuidance(["chrome"]);
    expect(g.suggestsAlternative).toBe(true);
    expect(g.alternative).toBe("chrome");
    expect(g.body).toContain("Chrome");
    expect(g.body).not.toMatch(/quit and reopen/i);
  });

  it("never suggests a browser that is not on the machine", () => {
    // The Settings picker already learned this: an uninstalled browser sat in
    // the control looking as valid as the rest and failed at every fetch.
    const g = safariGuidance([]);
    expect(g.suggestsAlternative).toBe(false);
    expect(g.alternative).toBeNull();
  });

  it("tells the truth about the relaunch when there is no alternative", () => {
    // macOS does not grant Full Disk Access to a running process; it offers to
    // quit and reopen. "Load the video again" sent people back to the same
    // failure and made the app look broken twice.
    const g = safariGuidance([]);
    expect(g.body).toMatch(/quit and reopen/i);
    expect(g.body).toMatch(/paste the link again/i);
  });

  it("prefers Chrome, then Brave, then Firefox, then Edge", () => {
    expect(safariGuidance(["edge", "chrome"]).alternative).toBe("chrome");
    expect(safariGuidance(["firefox", "brave"]).alternative).toBe("brave");
    expect(safariGuidance(["edge", "firefox"]).alternative).toBe("firefox");
    expect(safariGuidance(["edge"]).alternative).toBe("edge");
  });

  it("ignores safari itself as an alternative to safari", () => {
    const g = safariGuidance(["safari"]);
    expect(g.suggestsAlternative).toBe(false);
  });

  it("names browsers the way their makers do", () => {
    expect(browserLabel("chrome")).toBe("Chrome");
    expect(browserLabel("edge")).toBe("Edge");
    expect(browserLabel("brave")).toBe("Brave");
    expect(browserLabel("none")).toBe("your default browser");
  });

  it("keeps the instruction short enough to follow from memory", () => {
    // A toast here cannot carry a button, so every word is followed by recall.
    for (const ready of [["chrome"], []]) {
      expect(safariGuidance(ready).body.length, JSON.stringify(ready)).toBeLessThan(190);
    }
  });
});

describe("when the Safari cookie check may appear at all", () => {
  /**
   * Reported with a screenshot of "Safari needs Full Disk Access / Chrome does
   * not..." sitting over a LOCAL mp4 that was mid-playback: "I should not be
   * getting the Safari message when I'm just running a localized video."
   *
   * The check ran on a mount effect keyed only on the SETTING, so it had no
   * relationship to whether anything was fetching cookies. Cookies are read by
   * one thing - yt-dlp, fetching a web source.
   */
  it("does not appear for a local file, whatever the cookie setting says", () => {
    expect(shouldCheckSafariFda({ cookieBrowser: "safari", webSourceActive: false })).toBe(false);
  });

  it("appears once a web source is actually in play", () => {
    expect(shouldCheckSafariFda({ cookieBrowser: "safari", webSourceActive: true })).toBe(true);
  });

  it("never appears for a browser that needs no permission", () => {
    // Chrome, Brave, Firefox and Edge keep their cookies where the app can
    // already read them; there is nothing to grant.
    for (const b of ["chrome", "brave", "firefox", "edge", "none"]) {
      expect(shouldCheckSafariFda({ cookieBrowser: b, webSourceActive: true }), b).toBe(false);
    }
  });
});
