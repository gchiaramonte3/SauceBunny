//! `saucebunny://review/<code>` — a clicked link that opens a review.
//!
//! macOS routes the click through `application:openURLs:`, tao surfaces it and
//! Tauri delivers `RunEvent::Opened`. No plugin: `tauri-plugin-deep-link`
//! would be a fourth one, and CLAUDE.md gates that behind "explain what
//! existing capability is insufficient". Nothing is insufficient.
//!
//! **The cold-launch problem is why this module holds state.** Clicking a link
//! while the app is closed launches it, and the URL arrives before any webview
//! exists. Tauri events are dropped rather than queued for a listener that has
//! not registered yet, which CLAUDE.md records as the cause of the historical
//! "fresh panel rendered empty" bugs. So the URL is BUFFERED here and the
//! frontend also pulls on mount, which is the same request/response handshake
//! `panel:request-state` already uses. Emitting alone would work for a link
//! clicked while the app is running and silently do nothing otherwise, which
//! is the worse half of the two cases.
//!
//! **The link carries the code and nothing else.** No sender name, no cut
//! title. A link travels through Slack, clipboard managers, MDM logging and
//! crash reports, and a title is very often a client's name.

use crate::AppError;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// The one link waiting to be claimed. `None` once the frontend has taken it.
///
/// A single slot, not a queue: two links clicked before the UI is up means the
/// person changed their mind, and opening the first would be wrong.
#[derive(Default)]
pub struct PendingReviewLink(pub Mutex<Option<String>>);

/// The scheme's one path. `saucebunny://review/<code>`.
const REVIEW_HOST: &str = "review";

/// Pull the join code out of a `saucebunny://review/<code>` URL.
///
/// Returns `None` for anything else, including other hosts under the same
/// scheme, so adding `saucebunny://settings/...` later cannot accidentally be
/// read as a review link.
///
/// The code is NOT validated here beyond being non-empty: `parse_invite` and
/// the ticket parser are the authority on what a code is, they already accept
/// far messier input than a URL path, and duplicating their rules here would
/// give two places to disagree.
pub fn code_from_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("saucebunny://")?;
    // Both `saucebunny://review/CODE` and the host-less `saucebunny:///review/
    // CODE` some senders produce. Splitting on '/' handles either.
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    if parts.next()? != REVIEW_HOST {
        return None;
    }
    let code = parts.next()?.trim();
    // Anything after the code is ignored rather than rejected: a mail client
    // that appends a tracking segment should not break the link.
    if code.is_empty() { None } else { Some(code.to_string()) }
}

/// Called from the `RunEvent::Opened` arm. Buffers the code and announces it.
///
/// Both, deliberately. The emit serves a link clicked while the app is up; the
/// buffer serves a cold launch, where no listener exists yet.
pub fn remember_and_announce(app: &AppHandle, urls: &[String]) {
    let Some(code) = urls.iter().find_map(|u| code_from_url(u)) else { return };
    if let Some(state) = app.try_state::<PendingReviewLink>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(code.clone());
        }
    }
    // Named for the handler that receives it, which event-surface-contract
    // requires so a mis-wire is visible rather than merely broken.
    let _ = app.emit("deeplink:review", code);
}

/// Take the buffered code, if there is one, and clear the slot.
///
/// Taking rather than reading: a link should open once. Left in place it would
/// re-open every time the frontend remounted, which in this app happens on a
/// hot reload and on the panel window being created.
#[tauri::command]
pub fn take_pending_review_link(
    state: tauri::State<'_, PendingReviewLink>,
) -> Result<Option<String>, AppError> {
    let mut slot = state
        .0
        .lock()
        .map_err(|_| AppError::internal("The pending review link is unreadable"))?;
    Ok(slot.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_reads_a_review_link() {
        assert_eq!(code_from_url("saucebunny://review/SAUC-ABCDE"), Some("SAUC-ABCDE".into()));
    }

    #[test]
    fn it_accepts_the_host_less_form() {
        // Some senders normalise `scheme://host/path` to `scheme:///path`.
        assert_eq!(code_from_url("saucebunny:///review/SAUC-ABCDE"), Some("SAUC-ABCDE".into()));
    }

    #[test]
    fn it_ignores_a_trailing_segment() {
        // A mail client that appends its own tracking segment must not break
        // the link.
        assert_eq!(code_from_url("saucebunny://review/SAUC-ABCDE/x"), Some("SAUC-ABCDE".into()));
    }

    #[test]
    fn it_refuses_another_host_under_the_same_scheme() {
        // The reason the host is checked at all: adding saucebunny://settings
        // later must not be readable as a review link.
        assert_eq!(code_from_url("saucebunny://settings/ai"), None);
    }

    #[test]
    fn it_refuses_another_scheme() {
        assert_eq!(code_from_url("https://review/SAUC-ABCDE"), None);
        assert_eq!(code_from_url("file:///review/SAUC-ABCDE"), None);
    }

    #[test]
    fn it_refuses_an_empty_code() {
        assert_eq!(code_from_url("saucebunny://review/"), None);
        assert_eq!(code_from_url("saucebunny://review"), None);
        assert_eq!(code_from_url("saucebunny://"), None);
    }

    #[test]
    fn it_does_not_panic_on_junk() {
        for junk in ["", "saucebunny:", "://", "saucebunny://review//", "🐰"] {
            let _ = code_from_url(junk);
        }
    }
}
