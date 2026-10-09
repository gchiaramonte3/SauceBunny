//! The Transcript Editor's undo log: every state an edit has ever been in,
//! kept on disk, as a tree.
//!
//! Undo moves the head to the parent state, redo to the child you last came
//! from, and a change made after an undo starts a sibling branch instead of
//! discarding the undone steps (vim's undo tree, not a stack). Any state can
//! be jumped to and pinned with a name; rapid repeats of one action coalesce.
//! The behaviour is the prototype's, pinned by
//! `design-system/transcript-editor-history.test.ts`; this is its durable form.
//!
//! Storage: one SQLite file in `app_data_dir()`, never in `~/Documents`. A live
//! SQLite file has `-wal`/`-shm` side files, and iCloud eviction of Documents
//! has already broken a git packfile, a DMG and the transcript scan on this
//! project. The readable copy of an edit goes to Documents separately.
//!
//! Each state stores a JSON Patch from its parent, and every 100th state down
//! a branch (and the root) also stores the whole document. Reaching any state
//! is "nearest checkpoint, then at most 99 patches"; 100,000 steps of a 5 KB
//! edit cost a few tens of MB instead of the 500 MB a snapshot per step would.
use crate::edit_doc::EditDocument;
use crate::AppError;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::path::Path;

pub const LOG_SCHEMA_VERSION: i64 = 1;
/// Repeats of one grouped action inside this window are one undo step.
pub const COALESCE_MS: i64 = 500;
const CHECKPOINT_EVERY: i64 = 100;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditSummary {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    #[ts(type = "number")]
    pub head: i64,
    #[ts(type = "number")]
    pub states: i64,
    /// What the String Outs list shows of it, read from its head: the
    /// sequences it is cut from, how long it plays, and its bites (clips
    /// that play a source, gaps not counted). Empty when the head cannot
    /// be read, which the list survives.
    pub sources: Vec<String>,
    #[ts(type = "number")]
    pub duration_frames: i64,
    pub bites: u32,
    /// Each bite's length in frames, in record order, for the list's strip
    /// that draws the cut to scale. The first `STRIP_BITES` only: the strip
    /// is a thumbnail, and a cut of thousands of bites must not ride along.
    #[ts(type = "Array<number>")]
    pub bite_frames: Vec<i64>,
    pub edit_rate: Option<crate::edit_doc::EditRate>,
}

/// How many bites the list's strip is told about.
const STRIP_BITES: usize = 64;

/// What the list shows of one head document, read from its JSON without
/// building the whole document.
struct Details { sources: Vec<String>, frames: i64, bites: u32, bite_frames: Vec<i64>, edit_rate: Option<crate::edit_doc::EditRate> }

fn details(document: &Value) -> Details {
    let sources = document["sources"].as_array().into_iter().flatten().filter_map(|source| source["name"].as_str().map(str::to_string)).collect();
    let (mut frames, mut bites, mut bite_frames) = (0i64, 0u32, Vec::new());
    for segment in document["segments"].as_array().into_iter().flatten() {
        match segment["kind"].as_str() {
            Some("source") => {
                let length = (segment["out_frame"].as_i64().unwrap_or(0) - segment["in_frame"].as_i64().unwrap_or(0)).max(0);
                frames += length;
                bites += 1;
                if bite_frames.len() < STRIP_BITES { bite_frames.push(length); }
            }
            Some("gap") => frames += segment["frames"].as_i64().unwrap_or(0).max(0),
            _ => {}
        }
    }
    Details { sources, frames, bites, bite_frames, edit_rate: serde_json::from_value(document["edit_rate"].clone()).ok() }
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditState {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number | null")]
    pub parent: Option<i64>,
    pub label: String,
    #[ts(type = "number")]
    pub at: i64,
    pub pinned: Option<String>,
}

/// The head after a change of state, with the document it holds.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditHead {
    #[ts(type = "number")]
    pub state: i64,
    pub label: String,
    pub document: EditDocument,
    /// The label undo would take back, or null at the first state.
    pub undo: Option<String>,
    /// The label redo would bring back, or null when nothing is ahead.
    pub redo: Option<String>,
}

/// Every state of one edit plus the redo preference per state, which is all
/// the History panel needs to draw the done line, the steps ahead and the
/// branches (the drawing logic is shared with the prototype).
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditHistory {
    #[ts(type = "number")]
    pub head: i64,
    pub states: Vec<EditState>,
    /// Pairs of [parent, child]: the child redo returns to from that parent.
    #[ts(type = "Array<[number, number]>")]
    pub next: Vec<(i64, i64)>,
}

pub struct EditLog {
    db: Connection,
    /// The last document this log read or wrote, by state. A commit diffs
    /// against the head, and building the head meant replaying up to 99
    /// patches from its checkpoint, twice per commit (once to diff, once to
    /// answer). Only the app's own writable log keeps it: a reader in another
    /// process (the MCP server) cannot know the writer has moved on.
    last: RefCell<Option<(i64, Value)>>,
    remembers: bool,
}

/// A step's patch, matched by segment id rather than by position.
/// `json_patch::diff` compares arrays element by element, so one clip inserted
/// near the start of a long string out stored a replacement for every segment
/// after it, and every later commit replayed them all. The segments' common
/// head and tail (by id) are kept; what lies between is removed and added, and
/// a kept segment whose content changed gets its own small diff.
fn step_patch(base: &Value, next: &Value) -> Result<String, AppError> {
    let (Some(old), Some(new)) = (base.get("segments").and_then(Value::as_array), next.get("segments").and_then(Value::as_array)) else {
        return Ok(serde_json::to_string(&json_patch::diff(base, next))?);
    };
    let without_segments = |document: &Value| {
        let mut document = document.clone();
        if let Some(map) = document.as_object_mut() { map.remove("segments"); }
        document
    };
    let ops_of = |patch: json_patch::Patch| -> Result<Vec<Value>, AppError> {
        Ok(serde_json::to_value(patch)?.as_array().cloned().unwrap_or_default())
    };
    let mut ops = ops_of(json_patch::diff(&without_segments(base), &without_segments(next)))?;
    let id = |segment: &Value| segment.get("id").and_then(Value::as_str).map(str::to_owned);
    let same = |a: &Value, b: &Value| id(a).is_some() && id(a) == id(b);
    let mut head = 0;
    while head < old.len() && head < new.len() && same(&old[head], &new[head]) { head += 1; }
    let mut tail = 0;
    while tail < old.len() - head && tail < new.len() - head && same(&old[old.len() - 1 - tail], &new[new.len() - 1 - tail]) { tail += 1; }
    // A kept segment's own changes, under its index at the time they apply.
    let within = |index: usize, a: &Value, b: &Value, ops: &mut Vec<Value>| -> Result<(), AppError> {
        if a == b { return Ok(()); }
        for mut op in ops_of(json_patch::diff(a, b))? {
            for key in ["path", "from"] {
                if let Some(path) = op.get(key).and_then(Value::as_str) { op[key] = Value::String(format!("/segments/{index}{path}")); }
            }
            ops.push(op);
        }
        Ok(())
    };
    for index in 0..head { within(index, &old[index], &new[index], &mut ops)?; }
    for index in (head..old.len() - tail).rev() { ops.push(json!({ "op": "remove", "path": format!("/segments/{index}") })); }
    for (index, segment) in new.iter().enumerate().take(new.len() - tail).skip(head) { ops.push(json!({ "op": "add", "path": format!("/segments/{index}"), "value": segment })); }
    for step in 0..tail { within(new.len() - tail + step, &old[old.len() - tail + step], &new[new.len() - tail + step], &mut ops)?; }
    Ok(serde_json::to_string(&ops)?)
}

struct Row {
    edit: String,
    parent: Option<i64>,
    depth: i64,
    label: String,
    at: i64,
    group: Option<String>,
    pinned: Option<String>,
}

fn store_error(error: rusqlite::Error) -> AppError {
    AppError::Io(format!("The edit history could not be read or written: {error}"))
}

fn not_found() -> AppError {
    AppError::NotFound("That edit is not in the history.".into())
}

impl EditLog {
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path).map_err(store_error)?;
        Self::init(db)
    }

    /// The history for a reader outside the app (the MCP server): read-only,
    /// so it never takes the write lock the app's commits need, and never runs
    /// `init`, which creates tables and writes the schema version. WAL lets it
    /// read while the app writes. A history from a newer app is refused.
    pub fn open_read_only(path: &Path) -> Result<Self, AppError> {
        let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX)
            .map_err(store_error)?;
        db.busy_timeout(std::time::Duration::from_millis(500)).map_err(store_error)?;
        let found: Option<String> = db.query_row("SELECT value FROM meta WHERE key='schema_version'", [], |row| row.get(0))
            .optional().map_err(store_error)?;
        if found.and_then(|version| version.parse::<i64>().ok()).is_some_and(|version| version > LOG_SCHEMA_VERSION) {
            return Err(AppError::Invalid("The edit history was written by a newer version of Sauce Bunny. Update the app to read it.".into()));
        }
        Ok(Self { db, last: RefCell::new(None), remembers: false })
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self, AppError> {
        Self::init(Connection::open_in_memory().map_err(store_error)?)
    }

    fn init(db: Connection) -> Result<Self, AppError> {
        // FULL, not NORMAL: at editing rates its cost is invisible, and it is
        // the difference between losing the last step and losing none.
        db.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS edits(id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL, head INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS states(id INTEGER PRIMARY KEY AUTOINCREMENT, edit_id TEXT NOT NULL REFERENCES edits(id),
               parent INTEGER REFERENCES states(id), depth INTEGER NOT NULL, label TEXT NOT NULL, at INTEGER NOT NULL,
               grp TEXT, pinned TEXT, patch TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS states_edit ON states(edit_id, id);
             CREATE INDEX IF NOT EXISTS states_parent ON states(parent);
             CREATE TABLE IF NOT EXISTS checkpoints(state_id INTEGER PRIMARY KEY REFERENCES states(id), document TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS redo(edit_id TEXT NOT NULL, parent INTEGER NOT NULL, child INTEGER NOT NULL,
               PRIMARY KEY(edit_id, parent));",
        )
        .map_err(store_error)?;
        let found: Option<String> = db
            .query_row("SELECT value FROM meta WHERE key='schema_version'", [], |row| row.get(0))
            .optional()
            .map_err(store_error)?;
        match found.and_then(|version| version.parse::<i64>().ok()) {
            Some(version) if version > LOG_SCHEMA_VERSION => {
                return Err(AppError::Invalid(
                    "The edit history was written by a newer version of Sauce Bunny. Update the app to open it.".into(),
                ))
            }
            Some(_) => {}
            None => {
                db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?1)", params![LOG_SCHEMA_VERSION.to_string()])
                    .map_err(store_error)?;
            }
        }
        let integrity: String = db.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(store_error)?;
        if integrity != "ok" {
            return Err(AppError::Io(format!("The edit history failed its integrity check: {integrity}")));
        }
        Ok(Self { db, last: RefCell::new(None), remembers: true })
    }

    pub fn list(&self) -> Result<Vec<EditSummary>, AppError> {
        let mut statement = self
            .db
            .prepare(
                "SELECT e.id, e.title, e.created_at, e.updated_at, e.head, (SELECT COUNT(*) FROM states s WHERE s.edit_id = e.id)
                 FROM edits e ORDER BY e.updated_at DESC",
            )
            .map_err(store_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok(EditSummary { id: row.get(0)?, title: row.get(1)?, created_at: row.get(2)?, updated_at: row.get(3)?, head: row.get(4)?, states: row.get(5)?,
                    sources: Vec::new(), duration_frames: 0, bites: 0, bite_frames: Vec::new(), edit_rate: None })
            })
            .map_err(store_error)?;
        let mut summaries = rows.collect::<Result<Vec<_>, _>>().map_err(store_error)?;
        drop(statement);
        for summary in &mut summaries {
            if let Ok(document) = self.value_at(summary.head) {
                let found = details(&document);
                (summary.sources, summary.duration_frames, summary.bites, summary.bite_frames, summary.edit_rate) = (found.sources, found.frames, found.bites, found.bite_frames, found.edit_rate);
            }
        }
        Ok(summaries)
    }

    pub fn create(&mut self, id: &str, document: &EditDocument, now: i64) -> Result<EditHead, AppError> {
        document.validate()?;
        let whole = serde_json::to_string(document)?;
        let tx = self.db.transaction().map_err(store_error)?;
        tx.execute("INSERT INTO edits(id, title, created_at, updated_at, head) VALUES(?1, ?2, ?3, ?3, 0)", params![id, document.title, now])
            .map_err(store_error)?;
        tx.execute("INSERT INTO states(edit_id, parent, depth, label, at, patch) VALUES(?1, NULL, 0, 'Opened', ?2, '[]')", params![id, now])
            .map_err(store_error)?;
        let state = tx.last_insert_rowid();
        tx.execute("INSERT INTO checkpoints(state_id, document) VALUES(?1, ?2)", params![state, whole]).map_err(store_error)?;
        tx.execute("UPDATE edits SET head = ?1 WHERE id = ?2", params![state, id]).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        self.head(id)
    }

    fn head_id(&self, id: &str) -> Result<i64, AppError> {
        self.db
            .query_row("SELECT head FROM edits WHERE id = ?1", params![id], |row| row.get(0))
            .optional()
            .map_err(store_error)?
            .ok_or_else(not_found)
    }

    fn row(&self, state: i64) -> Result<Row, AppError> {
        self.db
            .query_row("SELECT edit_id, parent, depth, label, at, grp, pinned FROM states WHERE id = ?1", params![state], |row| {
                Ok(Row { edit: row.get(0)?, parent: row.get(1)?, depth: row.get(2)?, label: row.get(3)?, at: row.get(4)?, group: row.get(5)?, pinned: row.get(6)? })
            })
            .optional()
            .map_err(store_error)?
            .ok_or_else(not_found)
    }

    /// The document at any state: the nearest checkpoint, then patches forward.
    pub fn document_at(&self, state: i64) -> Result<EditDocument, AppError> {
        Ok(serde_json::from_value(self.value_at(state)?)?)
    }

    fn remember(&self, state: i64, document: &Value) {
        if self.remembers { *self.last.borrow_mut() = Some((state, document.clone())); }
    }

    fn value_at(&self, state: i64) -> Result<Value, AppError> {
        if let Some((known, document)) = self.last.borrow().as_ref() {
            if *known == state { return Ok(document.clone()); }
        }
        let mut chain = Vec::new();
        let mut at = Some(state);
        let base = loop {
            let current = at.ok_or_else(|| AppError::Internal("An edit state has no checkpoint above it.".into()))?;
            let checkpoint: Option<String> = self
                .db
                .query_row("SELECT document FROM checkpoints WHERE state_id = ?1", params![current], |row| row.get(0))
                .optional()
                .map_err(store_error)?;
            if let Some(document) = checkpoint {
                break document;
            }
            let (patch, parent): (String, Option<i64>) = self
                .db
                .query_row("SELECT patch, parent FROM states WHERE id = ?1", params![current], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()
                .map_err(store_error)?
                .ok_or_else(not_found)?;
            chain.push(patch);
            at = parent;
        };
        let mut value: Value = serde_json::from_str(&base)?;
        for patch in chain.iter().rev() {
            let patch: json_patch::Patch = serde_json::from_str(patch)?;
            json_patch::patch(&mut value, &patch).map_err(|error| AppError::Internal(format!("An edit step could not be replayed: {error}")))?;
        }
        self.remember(state, &value);
        Ok(value)
    }

    fn redo_target(&self, id: &str, state: i64) -> Result<Option<i64>, AppError> {
        let remembered: Option<i64> = self
            .db
            .query_row("SELECT child FROM redo WHERE edit_id = ?1 AND parent = ?2", params![id, state], |row| row.get(0))
            .optional()
            .map_err(store_error)?;
        if remembered.is_some() {
            return Ok(remembered);
        }
        self.db
            .query_row("SELECT id FROM states WHERE parent = ?1 ORDER BY id DESC LIMIT 1", params![state], |row| row.get(0))
            .optional()
            .map_err(store_error)
    }

    pub fn head(&self, id: &str) -> Result<EditHead, AppError> {
        let state = self.head_id(id)?;
        let row = self.row(state)?;
        let redo = match self.redo_target(id, state)? {
            Some(child) => Some(self.row(child)?.label),
            None => None,
        };
        Ok(EditHead { state, undo: row.parent.map(|_| row.label.clone()), label: row.label, redo, document: self.document_at(state)? })
    }

    fn set_head(&mut self, id: &str, state: i64, now: i64) -> Result<(), AppError> {
        self.db.execute("UPDATE edits SET head = ?1, updated_at = ?2 WHERE id = ?3", params![state, now, id]).map_err(store_error)?;
        Ok(())
    }

    /// Record a new state after the head. `group` coalesces rapid repeats of
    /// one action; a pinned state or one with children is never coalesced into.
    pub fn commit(&mut self, id: &str, label: &str, group: Option<&str>, document: &EditDocument, now: i64) -> Result<EditHead, AppError> {
        document.validate()?;
        let head = self.head_id(id)?;
        let Row { parent, depth, at, group: grp, pinned, .. } = self.row(head)?;
        let has_children: bool = self
            .db
            .query_row("SELECT EXISTS(SELECT 1 FROM states WHERE parent = ?1)", params![head], |row| row.get(0))
            .map_err(store_error)?;
        let next = serde_json::to_value(document)?;
        let coalesce = group.is_some() && grp.as_deref() == group && now - at < COALESCE_MS && !has_children && pinned.is_none() && parent.is_some();
        if coalesce {
            let base = self.value_at(parent.unwrap_or(head))?;
            let patch = step_patch(&base, &next)?;
            let tx = self.db.transaction().map_err(store_error)?;
            tx.execute("UPDATE states SET patch = ?1, at = ?2 WHERE id = ?3", params![patch, now, head]).map_err(store_error)?;
            tx.execute("UPDATE checkpoints SET document = ?1 WHERE state_id = ?2", params![serde_json::to_string(document)?, head]).map_err(store_error)?;
            tx.execute("UPDATE edits SET updated_at = ?1, title = ?2 WHERE id = ?3", params![now, document.title, id]).map_err(store_error)?;
            tx.commit().map_err(store_error)?;
            self.remember(head, &next);
            return self.head(id);
        }
        let base = self.value_at(head)?;
        if base == next {
            return self.head(id);
        }
        let patch = step_patch(&base, &next)?;
        let depth = depth + 1;
        let tx = self.db.transaction().map_err(store_error)?;
        tx.execute(
            "INSERT INTO states(edit_id, parent, depth, label, at, grp, patch) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, head, depth, label, now, group, patch],
        )
        .map_err(store_error)?;
        let state = tx.last_insert_rowid();
        if depth % CHECKPOINT_EVERY == 0 {
            tx.execute("INSERT INTO checkpoints(state_id, document) VALUES(?1, ?2)", params![state, serde_json::to_string(document)?]).map_err(store_error)?;
        }
        tx.execute("INSERT OR REPLACE INTO redo(edit_id, parent, child) VALUES(?1, ?2, ?3)", params![id, head, state]).map_err(store_error)?;
        tx.execute("UPDATE edits SET head = ?1, updated_at = ?2, title = ?3 WHERE id = ?4", params![state, now, document.title, id]).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        self.remember(state, &next);
        self.head(id)
    }

    pub fn undo(&mut self, id: &str, now: i64) -> Result<EditHead, AppError> {
        let head = self.head_id(id)?;
        if let Some(parent) = self.row(head)?.parent {
            self.db
                .execute("INSERT OR REPLACE INTO redo(edit_id, parent, child) VALUES(?1, ?2, ?3)", params![id, parent, head])
                .map_err(store_error)?;
            self.set_head(id, parent, now)?;
        }
        self.head(id)
    }

    pub fn redo(&mut self, id: &str, now: i64) -> Result<EditHead, AppError> {
        let head = self.head_id(id)?;
        if let Some(child) = self.redo_target(id, head)? {
            self.set_head(id, child, now)?;
        }
        self.head(id)
    }

    /// Move the head anywhere. Nothing is recorded or lost; redo then retraces
    /// the path jumped along.
    pub fn jump(&mut self, id: &str, state: i64, now: i64) -> Result<EditHead, AppError> {
        let row = self.row(state)?;
        if row.edit != id {
            return Err(not_found());
        }
        let mut path = vec![state];
        let mut at = row.parent;
        while let Some(parent) = at {
            path.push(parent);
            at = self.row(parent)?.parent;
        }
        let tx = self.db.transaction().map_err(store_error)?;
        for pair in path.windows(2) {
            tx.execute("INSERT OR REPLACE INTO redo(edit_id, parent, child) VALUES(?1, ?2, ?3)", params![id, pair[1], pair[0]]).map_err(store_error)?;
        }
        tx.commit().map_err(store_error)?;
        self.set_head(id, state, now)?;
        self.head(id)
    }

    pub fn pin(&mut self, id: &str, state: i64, name: Option<&str>) -> Result<(), AppError> {
        let name = name.map(str::trim).filter(|name| !name.is_empty()).map(|name| name.chars().take(200).collect::<String>());
        let changed = self.db.execute("UPDATE states SET pinned = ?1 WHERE id = ?2 AND edit_id = ?3", params![name, state, id]).map_err(store_error)?;
        if changed == 0 {
            return Err(not_found());
        }
        Ok(())
    }

    pub fn history(&self, id: &str) -> Result<EditHistory, AppError> {
        let head = self.head_id(id)?;
        let mut statement = self.db.prepare("SELECT id, parent, label, at, pinned FROM states WHERE edit_id = ?1 ORDER BY id").map_err(store_error)?;
        let states = statement
            .query_map(params![id], |row| Ok(EditState { id: row.get(0)?, parent: row.get(1)?, label: row.get(2)?, at: row.get(3)?, pinned: row.get(4)? }))
            .map_err(store_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(store_error)?;
        let mut statement = self.db.prepare("SELECT parent, child FROM redo WHERE edit_id = ?1").map_err(store_error)?;
        let next = statement
            .query_map(params![id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(store_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(store_error)?;
        Ok(EditHistory { head, states, next })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit_doc::{EditDocument, EditMarker, EditRate, EditSegment, EditSource, EditTrack, EditTrackKind, EDIT_SCHEMA_VERSION};

    fn doc(frames: &[i64]) -> EditDocument {
        EditDocument {
            schema_version: EDIT_SCHEMA_VERSION,
            title: "Edit".into(),
            edit_rate: EditRate { numerator: 24, denominator: 1 },
            start_timecode_frames: 0,
            sources: vec![EditSource { id: "s".into(), name: "S".into(), document_id: "d".into() }],
            tracks: vec![EditTrack { id: "t".into(), name: "T".into(), kind: EditTrackKind::Sound, source_tracks: Default::default(), featured: None }],
            segments: frames.iter().enumerate()
                .map(|(index, frame)| EditSegment::Source { id: format!("seg{index}"), source: "s".into(), in_frame: index as i64 * 1000, out_frame: index as i64 * 1000 + frame, tracks: None, overrides: None, layers: None, cuts: None })
                .collect(),
            mutes: vec![],
            markers: vec![],
        }
    }

    fn log() -> EditLog {
        EditLog::in_memory().unwrap_or_else(|error| panic!("{error}"))
    }

    fn ok<T>(result: Result<T, AppError>) -> T {
        result.unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn undo_and_redo_walk_the_steps_and_stop_at_the_ends() {
        let mut log = log();
        ok(log.create("e", &doc(&[10]), 0));
        ok(log.commit("e", "a", None, &doc(&[10, 20]), 1_000));
        ok(log.commit("e", "b", None, &doc(&[10, 20, 30]), 2_000));
        let head = ok(log.undo("e", 3_000));
        assert_eq!(head.document, doc(&[10, 20]));
        assert_eq!(head.undo.as_deref(), Some("a"));
        assert_eq!(head.redo.as_deref(), Some("b"));
        ok(log.undo("e", 3_100));
        let first = ok(log.undo("e", 3_200));
        assert_eq!(first.document, doc(&[10]));
        assert_eq!(first.undo, None);
        assert_eq!(ok(log.redo("e", 4_000)).document, doc(&[10, 20]));
    }

    #[test]
    fn a_change_after_undo_branches_and_keeps_the_undone_steps() {
        let mut log = log();
        ok(log.create("e", &doc(&[10]), 0));
        ok(log.commit("e", "a", None, &doc(&[10, 20]), 1_000));
        let b = ok(log.commit("e", "b", None, &doc(&[10, 20, 30]), 2_000)).state;
        ok(log.undo("e", 3_000));
        ok(log.undo("e", 3_100));
        let d = ok(log.commit("e", "d", None, &doc(&[99]), 4_000));
        assert_eq!(d.document, doc(&[99]));
        assert_eq!(ok(log.history("e")).states.len(), 4);
        let back = ok(log.jump("e", b, 5_000));
        assert_eq!(back.document, doc(&[10, 20, 30]));
        // Undo then redo retraces the branch jumped along, not the newest.
        ok(log.undo("e", 6_000));
        assert_eq!(ok(log.redo("e", 6_100)).state, b);
    }

    #[test]
    fn repeats_of_one_group_coalesce_inside_the_window_only() {
        let mut log = log();
        ok(log.create("e", &doc(&[10]), 0));
        ok(log.commit("e", "Move", Some("move"), &doc(&[11]), 100));
        ok(log.commit("e", "Move", Some("move"), &doc(&[12]), 100 + COALESCE_MS - 1));
        assert_eq!(ok(log.history("e")).states.len(), 2);
        assert_eq!(ok(log.head("e")).document, doc(&[12]));
        assert_eq!(ok(log.undo("e", 2_000)).document, doc(&[10]));
        ok(log.redo("e", 2_100));
        ok(log.commit("e", "Move", Some("move"), &doc(&[13]), 5_000));
        assert_eq!(ok(log.history("e")).states.len(), 3);
    }

    #[test]
    fn a_pinned_state_is_never_coalesced_into() {
        let mut log = log();
        ok(log.create("e", &doc(&[10]), 0));
        let state = ok(log.commit("e", "Move", Some("move"), &doc(&[11]), 100)).state;
        ok(log.pin("e", state, Some("  Client cut v2 ")));
        ok(log.commit("e", "Move", Some("move"), &doc(&[12]), 150));
        let history = ok(log.history("e"));
        assert_eq!(history.states.len(), 3);
        assert_eq!(history.states[1].pinned.as_deref(), Some("Client cut v2"));
        ok(log.pin("e", state, Some(" ")));
        assert_eq!(ok(log.history("e")).states[1].pinned, None);
    }

    #[test]
    fn a_clip_inserted_near_the_start_stores_a_small_patch_that_replays_exactly() {
        let mut log = log();
        let base = doc(&vec![10; 1000]);
        ok(log.create("e", &base, 0));
        // A new clip at the second place, and the first one trimmed: everything after keeps its id.
        let mut next = base.clone();
        next.segments.insert(1, EditSegment::Source { id: "new".into(), source: "s".into(), in_frame: 5, out_frame: 9, tracks: None, overrides: None, layers: None, cuts: None });
        if let EditSegment::Source { out_frame, .. } = &mut next.segments[0] { *out_frame = 4; }
        let head = ok(log.commit("e", "Insert", None, &next, 1_000));
        let patch: String = log.db.query_row("SELECT patch FROM states WHERE id = ?1", params![head.state], |row| row.get(0)).unwrap_or_default();
        // Two operations: the trim and the insert. Matched by position it was a replacement for all thousand.
        assert_eq!(serde_json::from_str::<Vec<Value>>(&patch).unwrap_or_default().len(), 2, "{patch}");
        // Replayed from the stored patch, not the remembered head.
        log.last.replace(None);
        assert_eq!(ok(log.document_at(head.state)), next);
        // And removing a run in the middle, with a kept segment changed after it, replays too.
        let mut later = next.clone();
        later.segments.drain(400..600);
        if let EditSegment::Source { tracks, .. } = &mut later.segments[400] { *tracks = Some(vec!["t".into()]); }
        let head = ok(log.commit("e", "Extract", None, &later, 2_000));
        log.last.replace(None);
        assert_eq!(ok(log.document_at(head.state)), later);
        assert_eq!(ok(log.undo("e", 3_000)).document, next);
    }

    #[test]
    fn thousands_of_steps_replay_exactly_through_checkpoints() {
        let mut log = log();
        ok(log.create("e", &doc(&[1]), 0));
        let mut expected = vec![1];
        for step in 1..=450 {
            expected.push(step);
            let mut next = doc(&expected);
            next.markers.push(EditMarker { id: format!("m{step}"), frame: 0, track: None, name: format!("{step}"), comment: String::new(), color: "Red".into() });
            next.markers.retain(|marker| marker.id != format!("m{}", step - 1));
            ok(log.commit("e", "Step", None, &next, step * 1_000));
        }
        let head = ok(log.head("e"));
        assert_eq!(head.document.segments.len(), 451);
        assert_eq!(head.document.markers.len(), 1);
        for _ in 0..450 {
            ok(log.undo("e", 1_000_000));
        }
        assert_eq!(ok(log.head("e")).document, doc(&[1]));
        let checkpoints: i64 = log.db.query_row("SELECT COUNT(*) FROM checkpoints", [], |row| row.get(0)).unwrap_or(0);
        assert_eq!(checkpoints, 5);
    }

    #[test]
    fn refuses_an_invalid_edit_and_a_newer_log() {
        let mut log = log();
        let mut bad = doc(&[10]);
        bad.segments = vec![EditSegment::Gap { id: "g".into(), frames: 0 }];
        assert!(log.create("e", &bad, 0).is_err());
        ok(log.create("e", &doc(&[10]), 0));
        assert!(log.commit("e", "x", None, &bad, 1).is_err());
        assert!(log.head("missing").is_err());
        log.db.execute("UPDATE meta SET value = '99' WHERE key = 'schema_version'", []).unwrap_or(0);
        let db = std::mem::replace(&mut log.db, Connection::open_in_memory().unwrap_or_else(|error| panic!("{error}")));
        assert!(EditLog::init(db).is_err());
    }

    #[test]
    fn an_unchanged_document_records_no_step() {
        let mut log = log();
        ok(log.create("e", &doc(&[10]), 0));
        ok(log.commit("e", "noop", None, &doc(&[10]), 1_000));
        assert_eq!(ok(log.history("e")).states.len(), 1);
        assert_eq!(ok(log.list()).len(), 1);
    }

    #[test]
    fn the_list_says_what_each_is_cut_from_how_long_it_plays_and_its_bites_at_its_head() {
        let mut log = log();
        ok(log.create("e", &doc(&[48, 24]), 0));
        let mut longer = doc(&[48, 24, 96]);
        longer.segments.push(EditSegment::Gap { id: "g".into(), frames: 12 });
        ok(log.commit("e", "add", None, &longer, 1_000));
        let listed = ok(log.list());
        let summary = &listed[0];
        assert_eq!((summary.sources.clone(), summary.duration_frames, summary.bites), (vec!["S".to_string()], 48 + 24 + 96 + 12, 3));
        assert_eq!(summary.bite_frames, vec![48, 24, 96], "the strip draws one bar per bite, to scale, in record order");
        assert_eq!(summary.edit_rate.as_ref().map(|rate| (rate.numerator, rate.denominator)), Some((24, 1)));
        // Undone, the list reads the head it went back to.
        ok(log.undo("e", 2_000));
        assert_eq!(ok(log.list())[0].bites, 2);
    }
}
