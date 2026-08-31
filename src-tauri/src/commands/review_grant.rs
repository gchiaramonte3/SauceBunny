//! Review links issued to a named person, and taken back from one.
//!
//! Before this, a join code was a bearer token with no identity and no way to
//! withdraw it. Three consequences, all of them things a host would be
//! surprised by:
//!
//!   · The code is a pure function of the endpoint key, which is now
//!     persisted, so every session a Mac ever hosts answers to the same
//!     string. A code shared in September silently admits its holder in
//!     November.
//!   · The only revocation was `reset_review_identity`, which invalidates
//!     EVERY code at once because they all name one key.
//!   · The roster name came from the peer's own `Hello`, filtered by a
//!     `clean_name` that defends exactly one reserved word. A stranger with a
//!     forwarded link joins as "Dana" and every note they leave is written to
//!     `Reviews/*.json` signed Dana, permanently. The relay's anti-spoofing
//!     stamp defends against forging ANOTHER member; it cannot defend against
//!     simply becoming them.
//!
//! A grant fixes all three: the link carries a per-recipient secret, the name
//! on their notes is the label the HOST typed, and one grant can be revoked
//! without touching the others.
//!
//! **Storage is `app_data_dir()`, never `~/Documents`.** The review docs live
//! under Documents, which is iCloud-synced for most people, and this file
//! holds secret hashes.
//!
//! **BLAKE3, not a password KDF.** The secret is 256 bits of `getrandom`, not
//! a human-chosen password, so there is nothing to brute-force and stretching
//! buys nothing. blake3 is already in the dependency graph; argon2 would walk
//! straight back into the r152 purge that cut 34 packages to avoid compiling
//! an image stack for a join code.
//!
//! **Deliberately NOT pinned to the first key that uses it.** Trust-on-first-use
//! would mean the colleague who opens the forwarded Slack message first
//! permanently locks out the person it was meant for, who then sees "link
//! revoked". That is strictly worse than a bearer token. A grant is a bearer
//! token with a name and an off switch, and the honest thing is to say so
//! rather than to pretend it is an identity.

use crate::AppError;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// One issued link.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGrant {
    /// Stable id, used to revoke.
    pub id: String,
    /// What the HOST called this person. This becomes their display name, so
    /// a recipient cannot choose how their notes are signed.
    pub label: String,
    /// BLAKE3 of the secret. The secret itself is shown once, at creation,
    /// and never stored: a store that can hand back a live link is a store
    /// that leaks every link if it is read.
    pub secret_hash: String,
    pub created_at: u64,
    /// Set when a connection last presented this grant, so a host can see
    /// which links have actually been used.
    #[serde(default)]
    pub last_seen_at: Option<u64>,
    /// Revoked grants are KEPT rather than deleted, so the list can say "you
    /// took this back" instead of quietly forgetting a person existed.
    #[serde(default)]
    pub revoked: bool,
}

/// What a grant looks like to the frontend. Same as `ReviewGrant` minus the
/// hash, which the webview has no use for and should not hold.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct GrantSummary {
    pub id: String,
    pub label: String,
    pub created_at: u64,
    pub last_seen_at: Option<u64>,
    pub revoked: bool,
}

/// Returned once, at creation. The secret is never readable again.
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NewGrant {
    pub id: String,
    pub label: String,
    /// The half that goes in the link.
    pub secret: String,
}

#[derive(Default, Serialize, Deserialize)]
struct GrantFile {
    #[serde(default)]
    grants: Vec<ReviewGrant>,
    /// When true, a connection with no grant is refused. Off by default: the
    /// lobby's join code is a different door, for people you are already in a
    /// call with, and turning this on by default would break live co-review
    /// for everyone who has never issued a link.
    #[serde(default)]
    invited_only: bool,
}

fn path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::internal(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal(format!("create app data dir: {e}")))?;
    Ok(dir.join("review-grants.json"))
}

fn read(app: &AppHandle) -> GrantFile {
    // A file we cannot read is treated as absent rather than as an error: the
    // alternative is refusing to host because a grant list is corrupt, and a
    // host with no grants is a working host.
    path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<GrantFile>(&s).ok())
        .unwrap_or_default()
}

fn write(app: &AppHandle, file: &GrantFile) -> Result<(), AppError> {
    let p = path(app)?;
    let body = serde_json::to_string_pretty(file)
        .map_err(|e| AppError::internal(format!("serialise grants: {e}")))?;
    // Atomic: a truncated grant file is a host that refuses everyone, and a
    // partial write during quit is exactly when that would happen.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| AppError::internal(format!("write grants: {e}")))?;
    std::fs::rename(&tmp, &p).map_err(|e| AppError::internal(format!("commit grants: {e}")))?;
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Hash a presented secret the same way creation did.
fn hash(secret: &str) -> String {
    blake3::hash(secret.as_bytes()).to_hex().to_string()
}

/// What the host decided about an incoming connection.
pub enum Admission {
    /// No grant presented. Today's behaviour, unless invited-only is on.
    Ungranted,
    /// Presented a live grant. The label REPLACES whatever name they claimed.
    Granted { id: String, label: String },
    /// Turn them away.
    Refused(&'static str),
}

/// Decide whether a connection may join, and under what name.
///
/// Constant-time comparison is deliberately NOT used. The secret is compared
/// as a hash of a 256-bit random value, and the thing an attacker would learn
/// from a timing difference is which of the host's own grant hashes matched
/// first — not the secret, which they would already have to possess to be
/// here. Guessing it is the 2^256 problem, which timing does not help.
pub fn admit(app: &AppHandle, presented: Option<&str>) -> Admission {
    let mut file = read(app);
    let Some(secret) = presented.map(str::trim).filter(|s| !s.is_empty()) else {
        return if file.invited_only {
            Admission::Refused("this session is invite only")
        } else {
            Admission::Ungranted
        };
    };
    let want = hash(secret);
    let Some(g) = file.grants.iter_mut().find(|g| g.secret_hash == want) else {
        return Admission::Refused("that link is not valid");
    };
    if g.revoked {
        return Admission::Refused("that link was withdrawn");
    }
    g.last_seen_at = Some(now_ms());
    let (id, label) = (g.id.clone(), g.label.clone());
    // Best-effort: failing to record a timestamp must not refuse someone.
    let _ = write(app, &file);
    Admission::Granted { id, label }
}

/// Issue a link for one person. The secret is returned once and never again.
#[tauri::command]
pub fn create_review_grant(app: AppHandle, label: String) -> Result<NewGrant, AppError> {
    let label = label.trim().chars().take(60).collect::<String>();
    if label.is_empty() {
        return Err(AppError::invalid("Give the link a name, so you know who has it."));
    }
    let mut raw = [0u8; 32];
    getrandom::getrandom(&mut raw)
        .map_err(|e| AppError::internal(format!("no randomness available: {e}")))?;
    let secret = hex::encode(raw);
    let id = hex::encode(&raw[..8]);

    let mut file = read(&app);
    file.grants.push(ReviewGrant {
        id: id.clone(),
        label: label.clone(),
        secret_hash: hash(&secret),
        created_at: now_ms(),
        last_seen_at: None,
        revoked: false,
    });
    write(&app, &file)?;
    Ok(NewGrant { id, label, secret })
}

/// Every link issued, without the secrets.
#[tauri::command]
pub fn list_review_grants(app: AppHandle) -> Result<Vec<GrantSummary>, AppError> {
    Ok(read(&app)
        .grants
        .into_iter()
        .map(|g| GrantSummary {
            id: g.id,
            label: g.label,
            created_at: g.created_at,
            last_seen_at: g.last_seen_at,
            revoked: g.revoked,
        })
        .collect())
}

/// Withdraw one link. The others keep working, which is the whole point.
///
/// Marks rather than deletes, so the list can say "withdrawn" instead of
/// forgetting the person. Returns how many live connections it closed.
#[tauri::command]
pub async fn revoke_review_grant(
    app: AppHandle,
    state: tauri::State<'_, crate::commands::SessionManager>,
    id: String,
) -> Result<usize, AppError> {
    {
        let mut file = read(&app);
        let Some(g) = file.grants.iter_mut().find(|g| g.id == id) else {
            return Err(AppError::not_found("That link is already gone."));
        };
        g.revoked = true;
        write(&app, &file)?;
    }
    // AND disconnect anyone holding it, right now. Marking alone made
    // revocation take effect at the NEXT join, so the person you had just
    // removed kept reading and commenting until they happened to leave. Doing
    // both in one command rather than two the caller must remember: a rule
    // like that is followed once and then forgotten.
    Ok(crate::commands::session::disconnect_grant(&app, &state, &id).await)
}

/// Whether a connection with no grant is turned away.
#[tauri::command]
pub fn review_invited_only(app: AppHandle) -> Result<bool, AppError> {
    Ok(read(&app).invited_only)
}

/// Refuse anyone without a link. Off by default; see `GrantFile`.
#[tauri::command]
pub fn set_review_invited_only(app: AppHandle, on: bool) -> Result<(), AppError> {
    let mut file = read(&app);
    file.invited_only = on;
    write(&app, &file)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_hashes_the_same_way_twice() {
        // The whole verification is "does this hash equal the stored one", so
        // an unstable hash is a host that refuses every link it ever issued.
        assert_eq!(hash("abc"), hash("abc"));
        assert_ne!(hash("abc"), hash("abd"));
    }

    #[test]
    fn the_hash_is_not_the_secret() {
        // What is stored must not be usable as what is presented.
        let secret = "0123456789abcdef";
        assert_ne!(hash(secret), secret);
        assert_eq!(hash(secret).len(), 64);
    }

    #[test]
    fn a_grant_summary_cannot_carry_the_hash() {
        // Compile-time, really: GrantSummary has no secret_hash field, so the
        // webview cannot be handed one by accident. This asserts the shape
        // stays that way by serialising a value and looking.
        let s = GrantSummary {
            id: "a".into(), label: "Dana".into(),
            created_at: 1, last_seen_at: None, revoked: false,
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("secretHash"), "the summary leaks the hash: {json}");
        assert!(!json.contains("secret"), "the summary leaks a secret-shaped field: {json}");
    }
}
