//! Resolve the media URL of a page that only reveals it once JavaScript runs.
//!
//! WHY THIS EXISTS. yt-dlp's generic extractor reads the HTML a server returns
//! and scans it for media. A modern site returns an empty shell and fetches its
//! video from script, so there is nothing in that HTML and yt-dlp correctly
//! reports "Unsupported URL". Measured on one real page: zero media URLs in
//! 306 KB of served HTML, and a `stream.mux.com/<id>.m3u8` the moment a browser
//! actually ran it. Handed that URL, yt-dlp resolves the full ladder to 1080p.
//!
//! So: render the page in a webview and read what it REQUESTED.
//!
//! THE TRUST BOUNDARY, which is the whole design.
//!
//! This loads a page the user pasted, which is untrusted by definition. Two
//! things keep it contained, and neither is a promise in a comment:
//!
//!   1. The window label is `media-resolver`, and NO capability file lists it.
//!      Capabilities in this app are scoped per label (`default.json` grants
//!      only `main`, `panel.json` only `panel`), so this webview is granted
//!      exactly nothing: the page cannot invoke a command, read a file, or
//!      reach the asset protocol. Adding this label to a capability would undo
//!      that, which is why `sniff-isolation-contract` fails if anyone does.
//!   2. Results come back over a NAVIGATION, not over IPC. The injected script
//!      sets `location.href` to a private scheme; `on_navigation` reads the
//!      payload and returns false, so the navigation never happens. No IPC
//!      channel is opened to the page at all.
//!
//! The window is invisible, is destroyed on every exit path, and the whole
//! thing is bounded by a timeout so a page that never loads cannot leak one.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Private scheme the injected script uses to hand its findings back. Never
/// navigated to — `on_navigation` denies it after reading the payload.
const SNIFF_SCHEME: &str = "sbsniff://";
/// Give a page this long to load and start its video before giving up.
const SNIFF_TIMEOUT_MS: u64 = 12_000;
/// A page can request thousands of resources; this bounds the payload we accept
/// back off it so a hostile page cannot make us allocate without limit.
const MAX_PAYLOAD_BYTES: usize = 256 * 1024;

#[derive(serde::Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SniffResult {
    /// Every media-looking URL the page fetched, in the order observed. The
    /// frontend ranks them (see `lib/media-sniff.ts`) because the CHOICE
    /// between a canonical and a signed URL is a product decision, not a
    /// transport one.
    pub urls: Vec<String>,
    /// The page's own title, used to name the import when we have nothing else.
    pub title: Option<String>,
}

/// Poll the resource-timing list and report findings back over the private
/// scheme. Runs at document start, inside the page, with no host privileges.
fn sniff_script() -> String {
    format!(
        r#"(function () {{
  if (window.__sbSniffed) return; window.__sbSniffed = true;
  var RE = /\.(m3u8|mpd|mp4|webm|mov|m4v)(\?|#|$)/i;
  var sent = false;
  function collect() {{
    var out = [];
    try {{
      performance.getEntriesByType('resource').forEach(function (e) {{
        if (RE.test(e.name)) out.push(e.name);
      }});
      document.querySelectorAll('video').forEach(function (v) {{
        if (v.currentSrc) out.push(v.currentSrc);
        if (v.src) out.push(v.src);
        v.querySelectorAll('source').forEach(function (s) {{ if (s.src) out.push(s.src); }});
      }});
    }} catch (e) {{ /* a page can break anything; report what we have */ }}
    return out;
  }}
  function report(urls) {{
    if (sent) return; sent = true;
    try {{
      var payload = JSON.stringify({{ urls: urls, title: document.title || null }});
      location.href = '{scheme}' + encodeURIComponent(payload);
    }} catch (e) {{ /* nothing else we can do from in here */ }}
  }}
  // Report as soon as there IS something, so a fast page is not made to wait
  // out the timeout; otherwise report whatever we have when it expires.
  var t = setInterval(function () {{
    var u = collect();
    if (u.length) {{ clearInterval(t); report(u); }}
  }}, 250);
  setTimeout(function () {{ clearInterval(t); report(collect()); }}, {timeout});
}})();"#,
        scheme = SNIFF_SCHEME,
        timeout = SNIFF_TIMEOUT_MS - 1_500,
    )
}

/// Load `url` in an isolated hidden webview and return the media it fetched.
#[tauri::command]
pub async fn sniff_page_media(app: AppHandle, url: String) -> Result<SniffResult, crate::AppError> {
    // Only ever http(s). A file:// or custom-scheme "page" here would be us
    // pointing an unprivileged webview at local content for no benefit.
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(crate::AppError::invalid("Only http(s) pages can be resolved."));
    }
    let parsed = url.parse::<tauri::Url>()
        .map_err(|_| crate::AppError::invalid("That does not look like a URL."))?;

    // One resolve at a time; a stale one from a previous attempt is closed
    // rather than left invisible on screen.
    if let Some(old) = app.get_webview_window("media-resolver") {
        let _ = old.close();
    }

    let (tx, rx) = std::sync::mpsc::channel::<SniffResult>();
    let tx = std::sync::Mutex::new(Some(tx));

    let win = WebviewWindowBuilder::new(&app, "media-resolver", WebviewUrl::External(parsed))
        .title("Resolving…")
        .inner_size(1280.0, 720.0)
        .visible(false)
        .focused(false)
        .skip_taskbar(true)
        .initialization_script(sniff_script())
        .on_navigation(move |u| {
            let s = u.as_str();
            if let Some(raw) = s.strip_prefix(SNIFF_SCHEME) {
                if raw.len() <= MAX_PAYLOAD_BYTES {
                    if let Some(json) = percent_decode(raw) {
                        if let Ok(found) = serde_json::from_str::<SniffPayload>(&json) {
                            if let Ok(mut guard) = tx.lock() {
                                if let Some(sender) = guard.take() {
                                    let _ = sender.send(SniffResult {
                                        urls: found.urls,
                                        title: found.title,
                                    });
                                }
                            }
                        }
                    }
                }
                // DENY: the payload was the point, the navigation never is.
                return false;
            }
            true
        })
        .build()
        .map_err(|e| crate::AppError::internal(format!("resolver webview: {e}")))?;

    // Block on the channel off the UI thread, bounded, then always tear down.
    let out = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_millis(SNIFF_TIMEOUT_MS))
    })
    .await
    .map_err(|e| crate::AppError::internal(format!("resolver join: {e}")))?;

    let _ = win.close();

    out.map_err(|_| crate::AppError::not_found("No video was found on that page."))
}

/// Minimal percent-decoder for the one payload we accept back off the page.
///
/// Hand-rolled rather than a new crate: this decodes exactly one string, from
/// `encodeURIComponent`, and a dependency for fifteen lines is the kind of
/// thing this project's rules exist to refuse. Returns None on anything
/// malformed, so a truncated or hostile payload is dropped rather than
/// half-parsed.
pub(crate) fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' => {
                // Needs two more bytes, and both must be hex.
                if i + 2 >= b.len() {
                    return None;
                }
                let hi = (b[i + 1] as char).to_digit(16)?;
                let lo = (b[i + 2] as char).to_digit(16)?;
                out.push((hi * 16 + lo) as u8);
                i += 3;
            }
            // encodeURIComponent leaves + alone, so it is a literal here and
            // must NOT be turned into a space the way form encoding would.
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

#[derive(serde::Deserialize)]
struct SniffPayload {
    urls: Vec<String>,
    title: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::percent_decode;

    #[test]
    fn decodes_what_encodeuricomponent_produces() {
        // The exact shape the injected script sends.
        let json = r#"{"urls":["https://a/b.m3u8?x=1&y=2"],"title":"A & B"}"#;
        let encoded = json
            .replace('%', "%25").replace('"', "%22").replace(' ', "%20")
            .replace('&', "%26").replace('{', "%7B").replace('}', "%7D");
        assert_eq!(percent_decode(&encoded).unwrap(), json);
    }

    #[test]
    fn keeps_a_plus_as_a_plus() {
        // Form decoding turns + into a space; encodeURIComponent does not
        // encode +, so doing that would corrupt a signature or a base64 id.
        assert_eq!(percent_decode("a+b").unwrap(), "a+b");
    }

    #[test]
    fn refuses_a_truncated_or_bogus_escape() {
        // A hostile or cut-off payload must be dropped whole, never
        // half-parsed into something that looks like a URL.
        for bad in ["%", "%A", "%ZZ", "abc%4"] {
            assert!(percent_decode(bad).is_none(), "accepted {bad:?}");
        }
    }

    #[test]
    fn passes_ordinary_text_through() {
        assert_eq!(percent_decode("https://x/v.m3u8").unwrap(), "https://x/v.m3u8");
    }

    #[test]
    fn rejects_invalid_utf8_rather_than_lossy_converting() {
        // %FF is not valid UTF-8; a lossy convert would invent a replacement
        // character inside what is supposed to be a URL.
        assert!(percent_decode("%FF%FE").is_none());
    }
}
