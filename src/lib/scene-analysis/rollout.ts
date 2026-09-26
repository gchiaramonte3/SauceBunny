/** Internal opt-in until the broader timing and packaged-WKWebView gates pass.
 * A deliberately built preview can expose the switch without modifying a
 * user's WebKit storage or enabling developer tools. Normal builds stay off.
 */
export function shotIntelligenceEnabled(): boolean {
  if (import.meta.env.VITE_SHOT_INTELLIGENCE_PREVIEW === "1") return true;
  try { return localStorage.getItem("saucebunny.shotIntelligence.preview") === "1"; }
  catch { return false; }
}
