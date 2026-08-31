//! The co-review endpoint's long-lived identity.
//!
//! Every `session_start` used to bind an endpoint with no secret key, and
//! iroh's own documentation says what that means: "If not set, a new secret
//! key will be generated." So the host's EndpointId — the thing a join code
//! ultimately names — was different on every launch, and a code shared on
//! Monday was undialable on Tuesday for a reason nobody could see.
//!
//! The key lives in the macOS **Keychain**, following `cloud_ai.rs` exactly,
//! with ONE deliberate difference from the TURN password next door: there is
//! no getter. The TURN credential has to reach JS because the
//! RTCPeerConnection is built in the webview; this key is used at
//! `Endpoint::builder` in Rust and nowhere else, so exposing it over IPC
//! would be a pure regression against what the AI keys already achieve.
//!
//! **A Keychain that says no does not stop you hosting.** Today a session
//! works with no Keychain involvement at all, and a first-run prompt the user
//! dismisses must not turn into "you cannot start a session". So the loader
//! never fails: it falls back to a generated key and reports that the identity
//! is not durable, which is precisely the behaviour that shipped before this
//! module existed. Callers that promise someone a lasting link are expected to
//! check `durable` rather than assume it.

use crate::AppError;
use iroh::SecretKey;

/// Keychain service. Deliberately NOT `cloud_ai.rs`'s `…desktop.ai`: a
/// network identity and a third-party API key are different secrets with
/// different lifetimes, and clearing one must never reach the other.
const KEYCHAIN_SERVICE: &str = "com.saucebunny.desktop.session";

/// The single account under that service. Named for what it is rather than
/// "key", so a human reading Keychain Access can tell what it does.
const HOST_ACCOUNT: &str = "host-endpoint";

fn entry() -> Result<keyring::Entry, AppError> {
    keyring::Entry::new(KEYCHAIN_SERVICE, HOST_ACCOUNT)
        .map_err(|e| AppError::internal(format!("Keychain unavailable: {e}")))
}

/// Read the stored key, minting and saving one on first run.
///
/// Infallible by design — see the module note. A stored value that no longer
/// parses is treated as absent and replaced, because a key we cannot read is
/// indistinguishable from no key and refusing to host over it helps nobody.
///
/// It returns the key and NOT whether the key is durable, because that
/// question already has an answer the UI can ask for: `has_review_identity`
/// reads the store directly and is false in every case this function falls
/// back — Keychain unavailable, read refused, or the write that would have
/// saved a fresh key failing. One source of truth beats two that can disagree.
pub fn load_or_create_host_key() -> SecretKey {
    let Ok(entry) = entry() else { return SecretKey::generate() };

    match entry.get_password() {
        Ok(stored) => {
            // `SecretKey: FromStr` accepts base32 or hex; we write hex.
            if let Ok(secret) = stored.parse::<SecretKey>() {
                return secret;
            }
            // Unreadable: fall through and overwrite rather than wedge.
        }
        Err(keyring::Error::NoEntry) => {}
        Err(_) => return SecretKey::generate(),
    }

    let secret = SecretKey::generate();
    // A failed write costs durability, not the session: the code minted this
    // run simply dies at quit, exactly as it did before this module existed.
    let _ = entry.set_password(&hex::encode(secret.to_bytes()));
    secret
}

/// Whether a durable identity exists, so the UI can say whether a code it is
/// about to hand someone will still work tomorrow.
#[tauri::command]
pub fn has_review_identity() -> Result<bool, AppError> {
    match entry()?.get_password() {
        Ok(v) => Ok(v.parse::<SecretKey>().is_ok()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(AppError::internal(format!("Couldn't read the review identity: {e}"))),
    }
}

/// Forget the identity. Absent is success (idempotent), matching
/// `delete_api_key`.
///
/// This is the coarse revocation story and it is worth being plain about:
/// it invalidates EVERY outstanding code at once, because they all name the
/// same key. Per-recipient revocation is a later phase and needs a grant
/// record to revoke against. A session already running keeps the key it bound
/// with; the next one mints a new identity.
#[tauri::command]
pub fn reset_review_identity() -> Result<(), AppError> {
    match entry()?.delete_password() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::internal(format!("Couldn't reset the review identity: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The round trip the Keychain actually performs. Encoding is hex and
    /// parsing goes through `FromStr`, so if either side changed this fails
    /// rather than silently minting a fresh identity on every launch — which
    /// is the failure this whole module exists to end, and which looks
    /// identical to working.
    #[test]
    fn a_key_survives_the_encoding_the_keychain_stores() {
        let original = SecretKey::generate();
        let encoded = hex::encode(original.to_bytes());
        let recovered: SecretKey = encoded.parse().expect("hex should parse back");
        assert_eq!(
            original.public(),
            recovered.public(),
            "the round trip changed the identity, so every link would break",
        );
    }

    /// A stored value we cannot parse must not be mistaken for a usable key.
    #[test]
    fn a_mangled_stored_value_does_not_parse() {
        assert!("not-a-key".parse::<SecretKey>().is_err());
        // Right alphabet, wrong length: the case a truncated write produces.
        assert!(hex::encode([7u8; 16]).parse::<SecretKey>().is_err());
    }

    /// Two generated keys differ. Guards the fallback path: if `generate()`
    /// were ever stubbed, every install would share one identity.
    #[test]
    fn generated_keys_are_distinct() {
        assert_ne!(SecretKey::generate().public(), SecretKey::generate().public());
    }
}
