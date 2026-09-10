/** Browser label only. Safari permission state belongs to Web sources Settings;
 * playback must never open privacy settings or infer auth from this selection. */
export function browserLabel(browser: string): string {
  return browser === "none" ? "your default browser" : browser.charAt(0).toUpperCase() + browser.slice(1);
}
