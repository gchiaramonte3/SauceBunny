//! Typed error surface for Tauri invoke handlers.
//!
//! Replaces the legacy `Result<T, String>` pattern (where the frontend
//! had to string-match on error contents — brittle). Now handlers return
//! `Result<T, AppError>`; `AppError` serializes as a discriminated union
//! the frontend can `switch (e.kind)` on. The shape is exported to
//! `src/bindings/AppError.ts` via ts-rs (r49 infrastructure).
//!
//! See CLAUDE.md refactor priority #4 (r50). Migration is incremental
//! — pre-existing commands still return `Result<T, String>`; convert
//! them opportunistically when you touch them, OR in a bulk r51 sweep.
//!
//! ## Adding a new variant
//!
//!   1. Add the variant to `AppError` below.
//!   2. Add a `Display` arm so the JS bridge has a readable fallback.
//!   3. Re-run `cargo test --lib` from `src-tauri/` to regenerate the
//!      TS binding. The frontend will get the new shape automatically.
//!
//! ## Pattern: handlers
//!
//! ```rust,no_run
//! #[tauri::command]
//! pub fn foo() -> Result<String, AppError> {
//!     std::fs::read_to_string("x")?;          // io::Error → AppError via From
//!     Err(AppError::Invalid("bad input".into()))
//! }
//! ```
//!
//! ## Pattern: frontend
//!
//! ```ts
//! try {
//!   await invoke("foo");
//! } catch (e) {
//!   const err = e as AppError;
//!   if (err.kind === "NotFound") { ... }
//!   else { toast.error(formatError(err)); }
//! }
//! ```

use serde::Serialize;

/// Discriminated union of every error a Tauri command can return.
///
/// `#[serde(tag = "kind", content = "data")]` produces the canonical
/// TypeScript discriminated-union shape — `{ kind: "...", data: ... }`.
/// Variants without payload serialize as `{ kind: "..." }` (no `data`
/// key), which ts-rs reflects as `{ kind: "Cancelled" }` etc.
#[derive(Debug, Serialize, ts_rs::TS)]
#[serde(tag = "kind", content = "data")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AppError {
    /// Bad input — user-facing validation error (empty filename,
    /// malformed timecode, unsupported format, etc.). The string is
    /// displayed verbatim.
    Invalid(String),
    /// Resource doesn't exist on disk or in the cache.
    NotFound(String),
    /// User explicitly cancelled the operation via `cancel_job`.
    Cancelled,
    /// Bundled sidecar binary is missing — the install is broken.
    /// Almost always means the dev forgot to run `npm run build:diarizer`
    /// or the .app wasn't built with the sidecar packaged.
    SidecarMissing { name: String },
    /// Sidecar process ran to completion with a non-zero exit code.
    /// `tail` is the last ~400 chars of stderr (often the actionable
    /// line — yt-dlp/ffmpeg put the real error at the END of a long
    /// warning preamble).
    SidecarFailed {
        name: String,
        exit_code: Option<i32>,
        tail: String,
    },
    /// YouTube is returning the bot-check page. User needs to sign in
    /// to one of the supported browsers (`cookies-from-browser`).
    YouTubeAuthRequired,
    /// Network failure (DNS, connect, timeout, body). The wrapped
    /// string is the underlying error; suitable for display in a toast.
    Network(String),
    /// Filesystem I/O failure not covered by NotFound (permission,
    /// disk full, etc).
    Io(String),
    /// Catch-all for "this should never happen but did." Should be
    /// rare; if you reach for `Internal` ask whether a more specific
    /// variant is warranted instead.
    Internal(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(msg) => write!(f, "{msg}"),
            Self::NotFound(msg) => write!(f, "Not found: {msg}"),
            Self::Cancelled => write!(f, "Cancelled"),
            Self::SidecarMissing { name } => write!(f, "Sidecar `{name}` is missing"),
            Self::SidecarFailed { name, exit_code, tail } => {
                if let Some(code) = exit_code {
                    write!(f, "Sidecar `{name}` failed (exit {code}): {tail}")
                } else {
                    write!(f, "Sidecar `{name}` failed: {tail}")
                }
            }
            Self::YouTubeAuthRequired => write!(
                f,
                "YouTube is asking for sign-in. Choose your browser in Settings → Source so we can use its cookies.",
            ),
            Self::Network(msg) => write!(f, "Network error: {msg}"),
            Self::Io(msg) => write!(f, "I/O error: {msg}"),
            Self::Internal(msg) => write!(f, "Internal error: {msg}"),
        }
    }
}

impl std::error::Error for AppError {}

// ── From impls so `?` works without ceremony ────────────────────────

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind;
        match e.kind() {
            ErrorKind::NotFound => Self::NotFound(e.to_string()),
            _ => Self::Io(e.to_string()),
        }
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        Self::Network(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::Internal(format!("JSON error: {e}"))
    }
}

// String → AppError defaults to `Invalid` (NOT `Internal`) so the
// legacy `Result<T, String>` UX is preserved exactly: `formatError`
// renders `Invalid` with no prefix, `Internal` with "Internal error: ".
// Code that wants the "this is unexpected" prefix should call
// `AppError::internal(s)` explicitly. (r51 audit: blanket Internal
// mapping introduced unwanted "Internal error:" prefixes on every
// user-facing yt-dlp / filename / mark-position error message.)
impl From<String> for AppError {
    fn from(s: String) -> Self {
        Self::Invalid(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        Self::Invalid(s.to_string())
    }
}

// Tauri's `.map_err(|e| e.to_string())` was the universal escape hatch
// in the old String-error world. Provide a parallel helper so handlers
// can keep their flow with minimal change during migration.
impl AppError {
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::Invalid(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }
    pub fn sidecar_missing(name: impl Into<String>) -> Self {
        Self::SidecarMissing { name: name.into() }
    }
}
