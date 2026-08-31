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

/// Pull the join code, and any grant secret, out of a review URL.
///
/// Returns `None` for anything else, including other hosts under the same
/// scheme, so adding `saucebunny://settings/...` later cannot accidentally be
/// read as a review link.
///
/// The code is NOT validated here beyond being non-empty: `parse_invite` and
/// the ticket parser are the authority on what a code is, they already accept
/// far messier input than a URL path, and duplicating their rules here would
/// give two places to disagree.
/// The code and, when the link was issued to a named person, their grant
/// secret: `saucebunny://review/<code>/<secret>`.
///
/// The secret rides in the PATH rather than a fragment or a query. A fragment
/// buys nothing here - LaunchServices is not HTTP, so there is no Referer to
/// leak to and the whole string is logged either way - and a query string
/// invites the sender name and cut title that must never be in a link.
pub fn parse_review_url(url: &str) -> Option<(String, Option<String>)> {
    let rest = url.strip_prefix("saucebunny://")?;
    // Both `saucebunny://review/CODE` and the host-less `saucebunny:///review/
    // CODE` some senders produce. Splitting on '/' handles either.
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    if parts.next()? != REVIEW_HOST {
        return None;
    }
    let code = parts.next()?.trim();
    if code.is_empty() {
        return None;
    }
    // Anything after the secret is ignored rather than rejected: a mail client
    // that appends a tracking segment should not break the link.
    let grant = parts.next().map(str::trim).filter(|g| !g.is_empty()).map(str::to_string);
    Some((code.to_string(), grant))
}

/// Called from the `RunEvent::Opened` arm. Buffers the code and announces it.
///
/// Both, deliberately. The emit serves a link clicked while the app is up; the
/// buffer serves a cold launch, where no listener exists yet.
pub fn remember_and_announce(app: &AppHandle, urls: &[String]) {
    let Some((code, grant)) = urls.iter().find_map(|u| parse_review_url(u)) else { return };
    // Buffered as one string so the pending slot stays a single value; the
    // frontend splits on the same separator the URL used.
    let code = match &grant { Some(g) => format!("{code}/{g}"), None => code };
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
        assert_eq!(parse_review_url("saucebunny://review/SAUC-ABCDE").map(|(c, _)| c), Some("SAUC-ABCDE".into()));
    }

    #[test]
    fn it_accepts_the_host_less_form() {
        // Some senders normalise `scheme://host/path` to `scheme:///path`.
        assert_eq!(parse_review_url("saucebunny:///review/SAUC-ABCDE").map(|(c, _)| c), Some("SAUC-ABCDE".into()));
    }

    #[test]
    fn it_reads_the_grant_secret_when_one_is_present() {
        assert_eq!(
            parse_review_url("saucebunny://review/SAUC-ABCDE/deadbeef"),
            Some(("SAUC-ABCDE".into(), Some("deadbeef".into()))),
        );
    }

    #[test]
    fn a_link_without_a_grant_has_none() {
        // The lobby's join code, pasted as a link. A different door, and it
        // must not be mistaken for a granted one.
        assert_eq!(
            parse_review_url("saucebunny://review/SAUC-ABCDE"),
            Some(("SAUC-ABCDE".into(), None)),
        );
    }

    #[test]
    fn it_ignores_a_trailing_segment() {
        // A mail client that appends its own tracking segment must not break
        // the link.
        assert_eq!(
            parse_review_url("saucebunny://review/SAUC-ABCDE/secret/tracking"),
            Some(("SAUC-ABCDE".into(), Some("secret".into()))),
        );
    }

    #[test]
    fn it_refuses_another_host_under_the_same_scheme() {
        // The reason the host is checked at all: adding saucebunny://settings
        // later must not be readable as a review link.
        assert_eq!(parse_review_url("saucebunny://settings/ai").map(|(c, _)| c), None);
    }

    #[test]
    fn it_refuses_another_scheme() {
        assert_eq!(parse_review_url("https://review/SAUC-ABCDE").map(|(c, _)| c), None);
        assert_eq!(parse_review_url("file:///review/SAUC-ABCDE").map(|(c, _)| c), None);
    }

    #[test]
    fn it_refuses_an_empty_code() {
        assert_eq!(parse_review_url("saucebunny://review/").map(|(c, _)| c), None);
        assert_eq!(parse_review_url("saucebunny://review").map(|(c, _)| c), None);
        assert_eq!(parse_review_url("saucebunny://").map(|(c, _)| c), None);
    }

    #[test]
    fn it_does_not_panic_on_junk() {
        for junk in ["", "saucebunny:", "://", "saucebunny://review//", "🐰"] {
            let _ = parse_review_url(junk);
        }
    }
}
