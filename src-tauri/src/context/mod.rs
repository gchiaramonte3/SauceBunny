//! The context layer: read-only answers about Sauce Bunny's sequences, the
//! people on them, their transcripts, the string outs cut from them, and the
//! Transcripts library, shaped for a model to read (names, Avid track labels,
//! timecodes, addresses) and written once for every door to it: the MCP
//! server (`crate::mcp`) now, and the in-app assistant's tool calls next.
//! See docs/AI-ACCESS-SPEC-2026-10-03.md.
//!
//! It reads the stores the app writes and never writes them: AAF Audio
//! documents (written atomically), the undo log (`timelines.sqlite`, opened
//! read-only, so the app's commits never wait on it) and the Transcripts
//! folder. What only the running app knows (the playhead, the selection,
//! what is open) is not here.
pub mod address;
mod files;
mod sequences;
mod string_outs;
pub mod timecode;
pub mod tools;

use crate::commands::aaf::model::AafDocument;
use crate::AppError;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub use address::Address;

/// Where the stores are. In the app these come from Tauri's path resolver;
/// the MCP server, which runs without Tauri, derives the same folders.
#[derive(Debug, Clone)]
pub struct Roots {
    /// `~/Documents/Sauce Bunny/Transcripts/Multitrack`, the AAF Audio documents.
    pub multitrack: PathBuf,
    /// `app_data_dir()/timelines.sqlite`, the string outs and their history.
    pub timelines: PathBuf,
    /// The Transcripts library root (`~/Documents/Sauce Bunny/Transcripts` unless moved).
    pub transcripts: PathBuf,
}

impl Roots {
    /// The default folders for this user, as the app lays them out on macOS
    /// (identifier `com.saucebunny.desktop`). A moved Transcripts library is
    /// recorded only in the app's WebView storage, so it is passed in.
    pub fn for_home(home: &std::path::Path, transcripts: Option<PathBuf>) -> Self {
        let documents = home.join("Documents").join("Sauce Bunny");
        Self {
            multitrack: documents.join("Transcripts").join("Multitrack"),
            timelines: home.join("Library").join("Application Support").join("com.saucebunny.desktop").join("timelines.sqlite"),
            transcripts: transcripts.unwrap_or_else(|| documents.join("Transcripts")),
        }
    }
}

/// One transcript line (a cue: what one mic heard as one sentence), the one
/// shape every tool returns a line in.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Line {
    pub line: String,
    pub who: String,
    pub track: String,
    pub tc_in: String,
    pub tc_out: String,
    pub text: String,
    /// The string outs that play this line, by address; omitted when none.
    #[serde(rename = "in", skip_serializing_if = "Vec::is_empty")]
    pub in_string_outs: Vec<String>,
    /// Bleed: this mic picked the line up, but it was spoken into this
    /// person's mic (the app's bleed resolver, accuracy spec phase 3). The
    /// same words are that person's line; omitted when the line is the mic
    /// owner's own, or when the mics were never measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bleed_from: Option<String>,
}

/// The stores, with AAF Audio documents kept parsed between calls (one can
/// run to hundreds of megabytes) until the file on disk changes.
pub struct Context {
    pub roots: Roots,
    documents: Mutex<HashMap<String, (std::time::SystemTime, Arc<AafDocument>)>>,
}

impl Context {
    pub fn new(roots: Roots) -> Self { Self { roots, documents: Mutex::new(HashMap::new()) } }

    /// An AAF Audio document by id, re-read only when its file has changed.
    /// The bleed resolver's answer for a document, from the app's cache in its
    /// support folder (beside `timelines.sqlite`), when it was computed from the
    /// document as it is now. A cache from an older document (new transcripts,
    /// so new cue ids) is ignored rather than trusted.
    pub fn ownership(&self, id: &str) -> Option<crate::commands::aaf::ownership::AafOwnership> {
        let app_data = self.roots.timelines.parent()?;
        let answer: crate::commands::aaf::ownership::AafOwnership = crate::commands::aaf::store::read_json(&crate::commands::aaf::ownership::cache_file(app_data, id)).ok()?;
        let document = std::fs::metadata(self.roots.multitrack.join(format!("{id}.json"))).ok()?;
        let stamp = crate::commands::aaf::store::modified_ms(&document).to_string();
        (answer.stamp.split(':').next() == Some(stamp.as_str())).then_some(answer)
    }

    /// The editor's Hide bleed switch. Off (the default), search returns a
    /// bleed copy, still marked `bleed_from`, because the label may be wrong
    /// and a line left out is one nobody knows to look for.
    pub fn hides_bleed(&self) -> bool {
        self.roots.timelines.parent().is_some_and(crate::commands::aaf::ownership::hides_bleed)
    }

    pub fn document(&self, id: &str) -> Result<Arc<AafDocument>, AppError> {
        let path = self.roots.multitrack.join(format!("{id}.json"));
        let modified = std::fs::metadata(&path).and_then(|meta| meta.modified())
            .map_err(|_| AppError::not_found(format!("No AAF Audio sequence {id}. list_sequences names them all.")))?;
        if let Some((when, document)) = self.documents.lock().ok().and_then(|cache| cache.get(id).cloned()) {
            if when == modified { return Ok(document); }
        }
        let document = Arc::new(crate::commands::aaf::store::load(&self.roots.multitrack, id)?);
        if let Ok(mut cache) = self.documents.lock() { cache.insert(id.to_string(), (modified, document.clone())); }
        Ok(document)
    }
}

/// How to find one of several things a model may name by id, address or name.
pub(crate) fn pick<'a, T>(items: &'a [T], wanted: &str, id: impl Fn(&T) -> &str, name: impl Fn(&T) -> &str, kind: &str) -> Result<&'a T, AppError> {
    let key = wanted.trim();
    if let Some(found) = items.iter().find(|item| id(item) == key) { return Ok(found); }
    let lower = key.to_lowercase();
    let exact: Vec<&T> = items.iter().filter(|item| name(item).to_lowercase() == lower).collect();
    if exact.len() == 1 { return Ok(exact[0]); }
    let partial: Vec<&T> = items.iter().filter(|item| name(item).to_lowercase().contains(&lower)).collect();
    match (exact.len(), partial.len()) {
        (0, 1) => Ok(partial[0]),
        (0, 0) => Err(AppError::not_found(format!("No {kind} called \"{key}\". The {kind}s are: {}.", list_names(items.iter().map(&name))))),
        _ => Err(AppError::invalid(format!("\"{key}\" could be more than one {kind}: {}. Use one of their addresses.",
            list_names(if exact.len() > 1 { exact.into_iter().map(&name).collect::<Vec<_>>() } else { partial.into_iter().map(&name).collect() }.into_iter())))),
    }
}

fn list_names<'a>(names: impl Iterator<Item = &'a str>) -> String {
    let all: Vec<&str> = names.collect();
    let shown = all.iter().take(20).map(|name| format!("\"{name}\"")).collect::<Vec<_>>().join(", ");
    if all.len() > 20 { format!("{shown} and {} more", all.len() - 20) } else { shown }
}

#[cfg(test)]
pub(crate) mod tests;
