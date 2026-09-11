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
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
    grants: Vec<ReviewGrant>,
    /// When true, a connection with no grant is refused. Off by default: the
    /// lobby's join code is a different door, for people you are already in a
    /// call with, and turning this on by default would break live co-review
    /// for everyone who has never issued a link.
    invited_only: bool,
}

// Serialize read-modify-write transactions, including admission timestamps.
// Otherwise an arrival can overwrite a withdrawal with its older snapshot.
static GRANT_WRITES: Mutex<()> = Mutex::new(());

fn path(app: &AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::internal(format!("app_data_dir: {e}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal(format!("create app data dir: {e}")))?;
    Ok(dir.join("review-grants.json"))
}

fn read(p: &Path) -> Result<GrantFile, AppError> {
    let body = match std::fs::read_to_string(p) {
        Ok(body) => body,
        // Only an absent store is first-time setup. A dangling link is not.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !p.is_symlink() => {
            return Ok(GrantFile::default());
        }
        Err(e) => return Err(AppError::Io(format!(
            "Cannot read review invitation settings. New joins are blocked until access is restored: {e}"
        ))),
    };
    serde_json::from_str(&body).map_err(|_| AppError::invalid(
        "Review invitation settings are damaged. New joins are blocked. Restore review-grants.json from a backup; the file has not been changed."
    ))
}

fn write(p: &Path, file: &GrantFile) -> Result<(), AppError> {
    let body = serde_json::to_string_pretty(file)
        .map_err(|e| AppError::internal(format!("serialise grants: {e}")))?;
    // Atomic: a truncated grant file is a host that refuses everyone, and a
    // partial write during quit is exactly when that would happen.
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| AppError::internal(format!("write grants: {e}")))?;
    std::fs::rename(&tmp, p).map_err(|e| AppError::internal(format!("commit grants: {e}")))?;
    Ok(())
}

fn update(p: &Path, change: impl FnOnce(&mut GrantFile) -> Result<(), AppError>) -> Result<(), AppError> {
    let _guard = GRANT_WRITES.lock().map_err(|_| AppError::internal("Review invitation storage lock failed"))?;
    let mut file = read(p)?;
    change(&mut file)?;
    write(p, &file)
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
#[derive(Debug, PartialEq)]
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
pub fn admit(app: &AppHandle, presented: Option<&str>) -> Result<Admission, AppError> {
    admit_at(&path(app)?, presented)
}

fn admit_at(p: &Path, presented: Option<&str>) -> Result<Admission, AppError> {
    let _guard = GRANT_WRITES.lock().map_err(|_| AppError::internal("Review invitation storage lock failed"))?;
    let mut file = read(p)?;
    let admission = decide(&mut file, presented);
    if matches!(admission, Admission::Granted { .. }) {
        // Timestamp persistence is best-effort, not admission policy.
        if let Err(e) = write(p, &file) {
            log::warn!("Could not record review invitation arrival: {e}");
        }
    }
    Ok(admission)
}

fn decide(file: &mut GrantFile, presented: Option<&str>) -> Admission {
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

    update(&path(&app)?, |file| {
        file.grants.push(ReviewGrant {
            id: id.clone(),
            label: label.clone(),
            secret_hash: hash(&secret),
            created_at: now_ms(),
            last_seen_at: None,
            revoked: false,
        });
        Ok(())
    })?;
    Ok(NewGrant { id, label, secret })
}

/// Every link issued, without the secrets.
#[tauri::command]
pub fn list_review_grants(app: AppHandle) -> Result<Vec<GrantSummary>, AppError> {
    Ok(read(&path(&app)?)?
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
    update(&path(&app)?, |file| {
        let Some(g) = file.grants.iter_mut().find(|g| g.id == id) else {
            return Err(AppError::not_found("That link is already gone."));
        };
        g.revoked = true;
        Ok(())
    })?;
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
    Ok(read(&path(&app)?)?.invited_only)
}

/// Refuse anyone without a link. Off by default; see `GrantFile`.
#[tauri::command]
pub fn set_review_invited_only(app: AppHandle, on: bool) -> Result<(), AppError> {
    update(&path(&app)?, |file| {
        file.invited_only = on;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct StoreFixture(PathBuf);
    impl StoreFixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("review-grant-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> PathBuf { self.0.join("review-grants.json") }
    }
    impl Drop for StoreFixture {
        fn drop(&mut self) { std::fs::remove_dir_all(&self.0).unwrap(); }
    }

    #[test]
    fn only_an_absent_store_uses_first_time_defaults() {
        let store = StoreFixture::new();
        assert_eq!(admit_at(&store.path(), None).unwrap(), Admission::Ungranted);
        assert!(!store.path().exists(), "admission must not initialize storage");
        for invalid in ["{broken", "{}", r#"{"grants":[]}"#, r#"{"invited_only":false}"#] {
            std::fs::write(store.path(), invalid).unwrap();
            assert!(read(&store.path()).is_err());
            assert!(admit_at(&store.path(), None).is_err());
            assert!(admit_at(&store.path(), Some("known-or-unknown")).is_err());
            assert!(update(&store.path(), |f| { f.invited_only = false; Ok(()) }).is_err());
            assert_eq!(std::fs::read_to_string(store.path()).unwrap(), invalid);
        }
    }

    #[cfg(unix)]
    #[test]
    fn denied_permissions_and_dangling_links_are_not_first_time_setup() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let store = StoreFixture::new();
        let body = r#"{"grants":[],"invited_only":true}"#;
        std::fs::write(store.path(), body).unwrap();
        std::fs::set_permissions(store.path(), std::fs::Permissions::from_mode(0o000)).unwrap();
        let admission = admit_at(&store.path(), None);
        let mutation = update(&store.path(), |f| { f.invited_only = false; Ok(()) });
        std::fs::set_permissions(store.path(), std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(admission, Err(AppError::Io(_))));
        assert!(mutation.is_err());
        assert_eq!(std::fs::read_to_string(store.path()).unwrap(), body);
        let link = store.0.join("dangling.json");
        symlink(store.0.join("missing.json"), &link).unwrap();
        assert!(admit_at(&link, None).is_err());
    }

    #[test]
    fn admission_reads_current_policy_and_revocation_every_time() {
        let store = StoreFixture::new();
        update(&store.path(), |f| {
            f.grants.push(ReviewGrant {
                id: "grant".into(), label: "Host-chosen name".into(), secret_hash: hash("secret"),
                created_at: 1, last_seen_at: None, revoked: false,
            });
            Ok(())
        }).unwrap();
        assert_eq!(admit_at(&store.path(), None).unwrap(), Admission::Ungranted);
        update(&store.path(), |f| { f.invited_only = true; Ok(()) }).unwrap();
        assert_eq!(admit_at(&store.path(), None).unwrap(), Admission::Refused("this session is invite only"));
        assert_eq!(admit_at(&store.path(), Some("secret")).unwrap(), Admission::Granted {
            id: "grant".into(), label: "Host-chosen name".into(),
        });
        assert!(read(&store.path()).unwrap().grants[0].last_seen_at.is_some());
        update(&store.path(), |f| { f.grants[0].revoked = true; Ok(()) }).unwrap();
        assert_eq!(admit_at(&store.path(), Some("secret")).unwrap(), Admission::Refused("that link was withdrawn"));
        assert_eq!(admit_at(&store.path(), Some("unknown")).unwrap(), Admission::Refused("that link is not valid"));
    }

    #[test]
    fn simultaneous_updates_preserve_every_issued_grant() {
        let store = StoreFixture::new();
        std::thread::scope(|scope| {
            for id in 0..16 {
                let p = store.path();
                scope.spawn(move || update(&p, |f| {
                    f.grants.push(ReviewGrant {
                        id: id.to_string(), label: "Test".into(), secret_hash: hash(&id.to_string()),
                        created_at: 1, last_seen_at: None, revoked: false,
                    });
                    Ok(())
                }).unwrap());
            }
        });
        assert_eq!(read(&store.path()).unwrap().grants.len(), 16);
    }

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
