use std::path::{Path, PathBuf};

fn main() {
    build_optional_ndi();
    clear_stale_resource_files();
    tauri_build::build();
}

/// The SDK is developer-supplied, never copied into the public repository or
/// linked into the app. Packaging separately stages only the approved runtime.
fn build_optional_ndi() {
    println!("cargo:rustc-check-cfg=cfg(sauce_ndi)");
    println!("cargo:rerun-if-env-changed=SAUCE_NDI_SDK_DIR");
    println!("cargo:rerun-if-changed=native/ndi_bridge.mm");
    let Some(sdk) = std::env::var_os("SAUCE_NDI_SDK_DIR").map(PathBuf::from) else { return; };
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") { return; }
    assert!(sdk.join("include/Processing.NDI.Lib.h").is_file(), "SAUCE_NDI_SDK_DIR must point to the extracted NDI SDK for Apple");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let arch = if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") { "arm64" } else { "x86_64" };
    let result = std::process::Command::new("xcrun").args(["clang++", "-std=c++17", "-fobjc-arc", "-fblocks", "-O2", "-mmacosx-version-min=14.0", "-arch", arch, "-c", "native/ndi_bridge.mm", "-I"])
        .arg(sdk.join("include")).arg("-o").arg(out.join("ndi_bridge.o")).status().expect("Run Xcode clang++");
    assert!(result.success(), "Native NDI bridge compilation failed");
    let result = std::process::Command::new("xcrun").args(["libtool", "-static", "-o"]).arg(out.join("libsauce_ndi.a"))
        .arg(out.join("ndi_bridge.o")).status().expect("Run Xcode libtool");
    assert!(result.success(), "Native NDI bridge archive failed");
    println!("cargo:rustc-cfg=sauce_ndi");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=sauce_ndi");
    println!("cargo:rustc-link-lib=c++");
    for framework in ["AVFoundation", "AudioToolbox", "CoreMedia", "CoreVideo", "CoreImage", "CoreGraphics", "Foundation", "UniformTypeIdentifiers", "VideoToolbox"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    // Debug convenience only; release binaries never depend on a developer's
    // SDK path. The explicit packaging script supplies the licensed runtime.
    if std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo:rustc-env=SAUCE_NDI_DEV_RUNTIME={}", sdk.join("lib/macOS/libndi.dylib").display());
    }
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
