import { describe, expect, it } from "vitest";
import { browserLabel, safariGuidance } from "./safari-fallback";

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
