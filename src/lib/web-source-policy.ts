/** Public YouTube loads do not require a browser cookie/permission probe. */
export function publicFirst(url: string): boolean {
  try { const h = new URL(url).hostname.toLowerCase(); return h === "youtu.be" || h === "youtube.com" || h.endsWith(".youtube.com"); }
  catch { return false; }
}

export function authenticationRetry(url: string, browser: string | undefined, message: string): boolean {
  return publicFirst(url) && !!browser && browser !== "none"
    && !/403|429|timeout|timed out|rate.limit|cancelled|permission/i.test(message)
    && /sign.in|login_required|age.restricted|private video|authentication is required/i.test(message);
}
