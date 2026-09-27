//! Invoke handlers for Transcript Editor edits: thin wrappers over
//! `crate::edit_log`, which holds the history and its rules.
//!
//! The history lives in `app_data_dir()/timelines.sqlite` (never iCloud-synced
//! Documents; see edit_log.rs). Every step also writes the current edit, as
//! readable JSON, to `~/Documents/Sauce Bunny/Edits/`: that copy is what a
//! person backs up, sends or opens elsewhere, and it is the one place an edit
//! survives the app's own data folder being wiped.
use crate::edit_doc::EditDocument;
use crate::edit_log::{EditHead, EditHistory, EditLog, EditSummary};
use crate::AppError;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

#[derive(Default)]
pub struct EditStore(Mutex<Option<EditLog>>);

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

fn with_log<T>(app: &AppHandle, store: &State<EditStore>, run: impl FnOnce(&mut EditLog) -> Result<T, AppError>) -> Result<T, AppError> {
    let mut guard = store.0.lock().map_err(|_| AppError::internal("The edit history is unavailable after an earlier failure. Restart Sauce Bunny."))?;
    if guard.is_none() {
        let dir = app.path().app_data_dir().map_err(|e| AppError::internal(format!("app_data_dir: {e}")))?;
        *guard = Some(EditLog::open(&dir.join("timelines.sqlite"))?);
    }
    match guard.as_mut() {
        Some(log) => run(log),
        None => Err(AppError::internal("The edit history could not be opened.")),
    }
}

fn valid_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(AppError::invalid("That edit id is not valid."));
    }
    Ok(())
}

/// A filesystem-safe, readable name: "Kitchen, first pass" -> "kitchen-first-pass".
fn slug(title: &str) -> String {
    let mut out = String::new();
    for c in title.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
        if out.chars().count() >= 60 {
            break;
        }
    }
    let trimmed = out.trim_end_matches('-');
    if trimmed.is_empty() { "edit".into() } else { trimmed.into() }
}

fn copy_path(app: &AppHandle, id: &str, title: &str) -> Result<PathBuf, AppError> {
    let dir = app.path().document_dir().map_err(|e| AppError::internal(format!("document_dir: {e}")))?.join("Sauce Bunny").join("Edits");
    std::fs::create_dir_all(&dir)?;
    let short: String = id.chars().take(8).collect();
    Ok(dir.join(format!("{}-{short}.json", slug(title))))
}

fn write_copy(path: &Path, document: &EditDocument) -> Result<(), AppError> {
    let body = serde_json::to_vec_pretty(document)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// The readable copy is written after the step is safely in the history; a
/// failure here is reported but never loses the step.
fn mirror(app: &AppHandle, id: &str, head: &EditHead) -> Result<(), AppError> {
    write_copy(&copy_path(app, id, &head.document.title)?, &head.document)
}

#[tauri::command]
pub fn edit_list(app: AppHandle, store: State<EditStore>) -> Result<Vec<EditSummary>, AppError> {
    with_log(&app, &store, |log| log.list())
}

#[tauri::command]
pub fn edit_create(app: AppHandle, store: State<EditStore>, id: String, document: EditDocument) -> Result<EditHead, AppError> {
    valid_id(&id)?;
    let head = with_log(&app, &store, |log| log.create(&id, &document, now_ms()))?;
    mirror(&app, &id, &head)?;
    Ok(head)
}

/// The document at an edit's head, for commands outside this file (export).
pub fn head_document(app: &AppHandle, id: &str) -> Result<EditDocument, AppError> {
    valid_id(id)?;
    let store = app.state::<EditStore>();
    with_log(app, &store, |log| log.head(id)).map(|head| head.document)
}

#[tauri::command]
pub fn edit_head(app: AppHandle, store: State<EditStore>, id: String) -> Result<EditHead, AppError> {
    valid_id(&id)?;
    with_log(&app, &store, |log| log.head(&id))
}

#[tauri::command]
pub fn edit_commit(app: AppHandle, store: State<EditStore>, id: String, label: String, group: Option<String>, document: EditDocument) -> Result<EditHead, AppError> {
    valid_id(&id)?;
    let label: String = label.trim().chars().take(120).collect();
    if label.is_empty() {
        return Err(AppError::invalid("A step needs a name."));
    }
    let head = with_log(&app, &store, |log| log.commit(&id, &label, group.as_deref(), &document, now_ms()))?;
    mirror(&app, &id, &head)?;
    Ok(head)
}

#[tauri::command]
pub fn edit_undo(app: AppHandle, store: State<EditStore>, id: String) -> Result<EditHead, AppError> {
    valid_id(&id)?;
    let head = with_log(&app, &store, |log| log.undo(&id, now_ms()))?;
    mirror(&app, &id, &head)?;
    Ok(head)
}

#[tauri::command]
pub fn edit_redo(app: AppHandle, store: State<EditStore>, id: String) -> Result<EditHead, AppError> {
    valid_id(&id)?;
    let head = with_log(&app, &store, |log| log.redo(&id, now_ms()))?;
    mirror(&app, &id, &head)?;
    Ok(head)
}

#[tauri::command]
pub fn edit_jump(app: AppHandle, store: State<EditStore>, id: String, state: i64) -> Result<EditHead, AppError> {
    valid_id(&id)?;
    let head = with_log(&app, &store, |log| log.jump(&id, state, now_ms()))?;
    mirror(&app, &id, &head)?;
    Ok(head)
}

#[tauri::command]
pub fn edit_pin(app: AppHandle, store: State<EditStore>, id: String, state: i64, name: Option<String>) -> Result<(), AppError> {
    valid_id(&id)?;
    with_log(&app, &store, |log| log.pin(&id, state, name.as_deref()))
}

#[tauri::command]
pub fn edit_history(app: AppHandle, store: State<EditStore>, id: String) -> Result<EditHistory, AppError> {
    valid_id(&id)?;
    with_log(&app, &store, |log| log.history(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_readable_and_safe() {
        assert_eq!(slug("Kitchen, first pass"), "kitchen-first-pass");
        assert_eq!(slug("../../etc"), "etc");
        assert_eq!(slug("  "), "edit");
        assert_eq!(slug("Café Ñ"), "café-ñ");
    }

    #[test]
    fn ids_are_restricted() {
        assert!(valid_id("abc-123").is_ok());
        assert!(valid_id("../x").is_err());
        assert!(valid_id("").is_err());
    }
}
