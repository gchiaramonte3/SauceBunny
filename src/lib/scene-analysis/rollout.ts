/** Internal opt-in until the broader timing and packaged-WKWebView gates pass. */
export function shotIntelligenceEnabled(): boolean {
  try { return localStorage.getItem("saucebunny.shotIntelligence.preview") === "1"; }
  catch { return false; }
}
