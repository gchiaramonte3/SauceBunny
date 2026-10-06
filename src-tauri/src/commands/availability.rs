//! Whether media the app refers to can be reached, without ever waiting on a
//! volume that does not answer (docs/RECONNECT-MEDIA-SPEC-2026-10-05.md).
//!
//! The states are what the person can do something about: a drive that is
//! not mounted is told to be connected, a folder that is not where it was is
//! offered Locate. Whether a drive is mounted comes from the kernel's mount
//! table (`getmntinfo`, `MNT_NOWAIT`), so an unmounted server is never
//! touched; anything else is one `metadata` call on a thread of its own with
//! a time limit, and a volume that misses it is not asked again until its
//! stuck call returns. That is the NEXIS freeze (asset_protocol.rs) applied
//! to the one check most likely to meet a dead mount.
use std::{collections::{HashMap, HashSet}, path::{Path, PathBuf}, sync::{mpsc, Mutex, OnceLock}, time::Duration};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use crate::AppError;

/// How long one volume gets to answer before it reads as not responding.
const VOLUME_LIMIT: Duration = Duration::from_secs(2);
/// A check is for what is on screen or in one store, never a whole disk.
const MAX_PATHS: usize = 2_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum MediaState { Online, DriveOffline, Missing, NotResponding, NoAccess }

#[derive(Clone, Debug, PartialEq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct MediaAvailability {
    pub path: String,
    pub state: MediaState,
    /// The drive's name for a path under /Volumes ("NEXIS"), to say which one to connect.
    pub volume: Option<String>,
    /// Whether an online path is a folder.
    pub folder: bool,
}

/// One mounted filesystem, as the kernel's table has it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Mount { pub on: String, pub kind: String, pub local: bool, pub from: String }

/// Every mount, from the kernel's cached table: never waits on a volume.
#[cfg(target_os = "macos")]
pub(crate) fn mounts() -> Vec<Mount> {
    let mut table: *mut libc::statfs = std::ptr::null_mut();
    // SAFETY: getmntinfo points `table` at a buffer it owns, holding `count` entries.
    let count = unsafe { libc::getmntinfo(&mut table, libc::MNT_NOWAIT) };
    if count <= 0 || table.is_null() { return Vec::new(); }
    // SAFETY: as above; the buffer stays valid until the next getmntinfo on this thread.
    let table = unsafe { std::slice::from_raw_parts(table, count as usize) };
    let text = |chars: &[libc::c_char]| unsafe { std::ffi::CStr::from_ptr(chars.as_ptr()) }.to_string_lossy().into_owned();
    table.iter().map(|mount| Mount { on: text(&mount.f_mntonname), kind: text(&mount.f_fstypename),
        local: mount.f_flags & libc::MNT_LOCAL as u32 != 0, from: text(&mount.f_mntfromname) }).collect()
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn mounts() -> Vec<Mount> { Vec::new() }

/// The drive a /Volumes path is on: "/Volumes/NEXIS/Show" → "NEXIS".
fn volume_name(path: &Path) -> Option<String> {
    let mut parts = path.components();
    parts.next(); // the root
    (parts.next()?.as_os_str() == "Volumes").then(|| parts.next().map(|name| name.as_os_str().to_string_lossy().into_owned())).flatten()
}

/// The mount a path is on: the longest mount point that contains it.
fn mount_of<'a>(path: &Path, points: &'a [String]) -> &'a str {
    points.iter().filter(|point| path.starts_with(point.as_str())).max_by_key(|point| point.len()).map_or("/", String::as_str)
}

/// Volumes whose last `metadata` has not come back yet. Asking again would
/// only add another stuck thread, so they read as not responding until it does.
fn stalled() -> &'static Mutex<HashSet<String>> {
    static STALLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    STALLED.get_or_init(Default::default)
}

enum Probe { Folder, File, Missing, NoAccess, NotResponding }

fn probe(path: PathBuf, volume: String) -> Probe {
    if stalled().lock().map(|set| set.contains(&volume)).unwrap_or(true) { return Probe::NotResponding; }
    let (answer, wait) = mpsc::channel();
    let watched = volume.clone();
    let spawned = std::thread::Builder::new().name("media-availability".into()).spawn(move || {
        let result = std::fs::metadata(&path);
        // A late answer clears the volume for the next check.
        if let Ok(mut set) = stalled().lock() { set.remove(&watched); }
        let _ = answer.send(result);
    });
    if spawned.is_err() { return Probe::NotResponding; }
    match wait.recv_timeout(VOLUME_LIMIT) {
        Ok(Ok(meta)) => if meta.is_dir() { Probe::Folder } else { Probe::File },
        Ok(Err(error)) => match error.kind() {
            std::io::ErrorKind::NotFound => Probe::Missing,
            std::io::ErrorKind::PermissionDenied => Probe::NoAccess,
            _ => Probe::NotResponding,
        },
        Err(_) => {
            if let Ok(mut set) = stalled().lock() { set.insert(volume); }
            Probe::NotResponding
        }
    }
}

/// The answer for each path, in order. Pure apart from `probe`, so the rules
/// (which drive, which state) are testable with any mount table.
fn classify(paths: &[String], points: &[String], mut probe: impl FnMut(PathBuf, String) -> Probe) -> Vec<MediaAvailability> {
    let mut dead: HashMap<String, bool> = HashMap::new();
    paths.iter().map(|text| {
        let path = PathBuf::from(text);
        let volume = volume_name(&path);
        let answer = |state, folder| MediaAvailability { path: text.clone(), state, volume: volume.clone(), folder };
        if !path.is_absolute() { return answer(MediaState::Missing, false); }
        if let Some(name) = &volume {
            if !points.iter().any(|point| Path::new(point) == Path::new("/Volumes").join(name)) {
                return answer(MediaState::DriveOffline, false);
            }
        }
        let mount = mount_of(&path, points).to_string();
        if dead.get(&mount).copied().unwrap_or(false) { return answer(MediaState::NotResponding, false); }
        match probe(path, mount.clone()) {
            Probe::Folder => answer(MediaState::Online, true),
            Probe::File => answer(MediaState::Online, false),
            Probe::Missing => answer(MediaState::Missing, false),
            Probe::NoAccess => answer(MediaState::NoAccess, false),
            Probe::NotResponding => { dead.insert(mount, true); answer(MediaState::NotResponding, false) }
        }
    }).collect()
}

/// Whether each path can be reached now. Never opens a file, never touches a
/// drive that is not mounted, and gives each volume two seconds.
#[tauri::command]
pub async fn media_availability(paths: Vec<String>) -> Result<Vec<MediaAvailability>, AppError> {
    if paths.len() > MAX_PATHS { return Err(AppError::invalid("Too many paths to check at once")); }
    tauri::async_runtime::spawn_blocking(move || {
        let points: Vec<String> = mounts().into_iter().map(|mount| mount.on).collect();
        classify(&paths, &points, probe)
    }).await.map_err(|e| AppError::internal(e.to_string()))
}

/// Tells the app when a drive mounts or unmounts, so offline roots come back
/// without a click. The mount table is read every three seconds; reading it
/// never waits on a volume.
pub fn watch_volumes(app: AppHandle) {
    let _ = std::thread::Builder::new().name("media-volumes".into()).spawn(move || {
        let names = || -> Vec<String> {
            let mut names: Vec<String> = mounts().into_iter().filter(|m| m.on.starts_with("/Volumes/")).map(|m| m.on).collect();
            names.sort();
            names
        };
        let mut last = names();
        loop {
            std::thread::sleep(Duration::from_secs(3));
            let now = names();
            if now != last {
                last = now;
                if app.emit("media:volumes-changed", ()).is_err() { return; }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn points() -> Vec<String> { ["/", "/System/Volumes/Data", "/Volumes/Studio SSD"].map(String::from).to_vec() }

    #[test]
    fn an_unmounted_drive_is_offline_without_being_touched() {
        let mut touched = Vec::new();
        let answers = classify(&["/Volumes/NEXIS/Show/Day 3".into(), "/Volumes/Studio SSD/Selects".into()], &points(), |path, _| {
            touched.push(path); Probe::Folder
        });
        assert_eq!((answers[0].state, answers[0].volume.as_deref()), (MediaState::DriveOffline, Some("NEXIS")));
        assert_eq!((answers[1].state, answers[1].folder), (MediaState::Online, true));
        assert_eq!(touched, vec![PathBuf::from("/Volumes/Studio SSD/Selects")], "the unmounted drive was touched");
    }

    #[test]
    fn a_volume_that_does_not_answer_is_asked_once_per_check() {
        let mut asked = 0;
        let paths: Vec<String> = (0..50).map(|n| format!("/Volumes/Studio SSD/clip-{n}.mov")).collect();
        let answers = classify(&paths, &points(), |_, volume| { asked += 1; assert_eq!(volume, "/Volumes/Studio SSD"); Probe::NotResponding });
        assert_eq!(asked, 1);
        assert!(answers.iter().all(|a| a.state == MediaState::NotResponding));
    }

    #[test]
    fn missing_local_paths_and_unreadable_ones_are_told_apart() {
        let answers = classify(&["/Users/editor/Desktop/Test".into(), "/Users/editor/Private".into(), "relative/path".into()], &points(),
            |path, volume| { assert_eq!(volume, "/"); if path.ends_with("Test") { Probe::Missing } else { Probe::NoAccess } });
        assert_eq!(answers.iter().map(|a| a.state).collect::<Vec<_>>(), [MediaState::Missing, MediaState::NoAccess, MediaState::Missing]);
    }

    #[test]
    fn names_the_drive_only_for_volumes_paths() {
        assert_eq!(volume_name(Path::new("/Volumes/NEXIS 1/Show")), Some("NEXIS 1".into()));
        assert_eq!(volume_name(Path::new("/Volumes")), None);
        assert_eq!(volume_name(Path::new("/Users/editor/Volumes/x")), None);
    }
}
