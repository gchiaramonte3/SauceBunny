//! A local copy of the AAF for the parser to read.
//!
//! pyaaf2 reads a compound file in 4 KiB sectors, seeking between them, with
//! an 8 KiB buffer and a 2 MiB sector cache. On a local disk that is nothing;
//! on NEXIS or any SMB share every sector is a network round trip, and an
//! import opens the file twice (the sequence list, then the inspect). One
//! sequential read of the whole file is a small fraction of that cost, so the
//! parser reads a copy in the cache and the document still names the original.
//!
//! The copy keeps the original's modification time, so its fingerprint
//! (size, mtime and the head and tail bytes) is the original's, and every
//! existing "the AAF changed" check still holds. If the filesystem cannot
//! carry the time across exactly, the copy is not used and the parser reads
//! in place as before. It lives at the top of `scratch/`, and since it carries
//! the original's (older) time the startup sweep clears it on a later launch.
use super::{diagnostics, process, store};
use crate::AppError;
use sha2::{Digest, Sha256};
use std::{io::{Read, Write}, path::{Path, PathBuf}, time::Instant};
use tauri::{AppHandle, Manager};

/// Past this the file carries embedded media, the parser only reads its
/// metadata, and copying every byte would cost more than it saves.
const LARGEST_COPIED: u64 = 4 << 30;
const CHUNK: usize = 8 << 20;

/// The path the parser should read: a verified local copy, or the original.
pub async fn for_parser(app: &AppHandle, job: &str, source: &Path) -> Result<PathBuf, AppError> {
    let (app2, job2, source2) = (app.clone(), job.to_owned(), source.to_owned());
    let started = Instant::now();
    let copied = tauri::async_runtime::spawn_blocking(move || copy(&app2, &job2, &source2)).await
        .map_err(|e| AppError::internal(e.to_string()))??;
    Ok(match copied {
        Some((path, bytes, reused)) => {
            diagnostics::log(app, job, "ok", "aaf-local", &format!("{} the AAF locally · {:.1} MB · {} ms",
                if reused { "Reused a copy of" } else { "Copied" }, bytes as f64 / 1e6, started.elapsed().as_millis()));
            path
        }
        None => source.to_owned(),
    })
}

fn copy(app: &AppHandle, job: &str, source: &Path) -> Result<Option<(PathBuf, u64, bool)>, AppError> {
    let metadata = std::fs::metadata(source)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > LARGEST_COPIED { return Ok(None); }
    let identity = store::source_fingerprint(source)?;
    let cache = app.path().app_cache_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let dir = crate::commands::system::scratch_dir(&cache);
    let name = format!("aaf-read-{:x}.aaf", Sha256::digest(format!("{}\0{identity}", source.to_string_lossy()).as_bytes()));
    let target = dir.join(&name);
    if store::source_fingerprint(&target).is_ok_and(|copy| copy == identity) {
        return Ok(Some((target, metadata.len(), true)));
    }
    let partial = dir.join(format!("{name}.{}.partial", std::process::id()));
    let result = write_copy(app, job, source, &partial, &target, &identity, &metadata);
    match result {
        Ok(true) => Ok(Some((target, metadata.len(), false))),
        Ok(false) => { let _ = std::fs::remove_file(&partial); Ok(None) }
        Err(AppError::Cancelled) => { let _ = std::fs::remove_file(&partial); Err(AppError::Cancelled) }
        // A full disk or an unwritable cache is no reason to fail an import
        // that can still read the original in place.
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            diagnostics::log(app, job, "warn", "aaf-local", &format!("Reading the AAF in place: {error}"));
            Ok(None)
        }
    }
}

fn write_copy(app: &AppHandle, job: &str, source: &Path, partial: &Path, target: &Path, identity: &str, metadata: &std::fs::Metadata) -> Result<bool, AppError> {
    let mut from = std::fs::File::open(source)?;
    let mut to = std::fs::File::create(partial)?;
    let mut buffer = vec![0_u8; CHUNK];
    loop {
        process::check_cancelled(app, job)?;
        let read = from.read(&mut buffer)?;
        if read == 0 { break; }
        to.write_all(&buffer[..read])?;
    }
    to.set_modified(metadata.modified()?)?;
    to.sync_all()?;
    drop(to);
    // The copy must BE the original: same fingerprint, and the original
    // unchanged while it was read.
    let same = store::source_fingerprint(partial)? == identity && store::source_fingerprint(source)? == identity;
    if same { std::fs::rename(partial, target)?; }
    Ok(same)
}
