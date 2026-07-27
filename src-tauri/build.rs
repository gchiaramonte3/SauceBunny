use std::path::{Path, PathBuf};

fn main() {
    clear_stale_resource_files();
    tauri_build::build();
}

/// Delete a leftover `licenses` FILE sitting where a DIRECTORY now belongs.
///
/// `bundle.resources` is keyed by DESTINATION. It used to map three different
/// license files onto the single key `licenses`, which silently collapsed them
/// into one file — the MIT LICENSE and the GPLv3 text that bundled ffmpeg
/// requires shipped in no build at all. Fixing that gave each file its own
/// destination under a `licenses/` directory.
///
/// The fix is correct and it is also a trap, because Tauri's build script
/// copies resources into the profile directory and does not reconcile a file
/// with a directory of the same name. So:
///
///   * a clean clone works;
///   * ANY checkout built before the fix — every existing contributor, and CI
///     whenever it restores a cargo cache — dies with
///     `File exists (os error 17)` and a build log naming no file, no path
///     and no cause.
///
/// That is exactly how the nightly workflow broke: its cargo cache still held
/// the pre-fix artifact. Reproduced deliberately by recreating the file and
/// watching `cargo check` fail the same way.
///
/// Doing this in build.rs rather than documenting a manual `rm` is the point.
/// A cleanup step someone has to know about is a cleanup step that does not
/// happen, and the failure it prevents is unreadable.
fn clear_stale_resource_files() {
    // OUT_DIR is <target>/<profile>/build/<pkg>-<hash>/out, so the profile
    // directory — where resources are staged — is three levels up.
    let Some(profile_dir) = std::env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .and_then(|out| out.ancestors().nth(3).map(Path::to_path_buf))
    else {
        return;
    };

    // Only ever removes a FILE. If it is already a directory this is a no-op,
    // so a directory of real staged resources is never touched.
    let stale = profile_dir.join("licenses");
    if stale.is_file() {
        match std::fs::remove_file(&stale) {
            Ok(()) => println!(
                "cargo:warning=removed a stale `licenses` file at {} \
                 (it predates the split into licenses/<name>; see build.rs)",
                stale.display()
            ),
            Err(e) => println!(
                "cargo:warning=could not remove the stale `licenses` file at {}: {e}. \
                 Delete it by hand — the build is about to fail with \
                 `File exists (os error 17)`.",
                stale.display()
            ),
        }
    }
}
