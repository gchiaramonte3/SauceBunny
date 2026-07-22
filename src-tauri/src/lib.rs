mod commands;
mod error;
// Support for the nightly real-sidecar smoke tests (`cargo test --lib
// nightly_ -- --ignored`) — compiled only under cfg(test), never shipped.
#[cfg(test)]
mod nightly;
mod stream_proxy;
pub use error::AppError;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Emitter, Manager};

// ── Native menu bar ──────────────────────────────────────────────────
//
// macOS-style menubar. We keep the bulk of the heavy lifting in JS
// (the UI already has toolbar buttons + ⌘K palette for everything),
// but native menu items are the discoverable surface that macOS users
// look for first — and a few of them (Open URL Bar, Import Transcript)
// give us shortcuts that don't otherwise exist.
//
// Menu items use accelerators with `CmdOrCtrl` so the same code reads
// correctly if we ever ship Linux/Windows. Clicks emit `menu:<id>`
// events on the window so the React layer can wire them like any
// other Tauri event — see App.tsx for the listener.

fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    // App submenu (macOS auto-uses the first submenu as the "Sauce
    // Bunny" menu next to the apple). PredefinedMenuItem gives us
    // standard items like About / Quit / Hide with native behavior.
    let app_menu = Submenu::with_items(
        app,
        "Sauce Bunny",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "open_settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "open_url_bar",      "Open URL Bar",        true, Some("CmdOrCtrl+L"))?,
            &MenuItem::with_id(app, "import_local",      "Import Local File…",  true, Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "import_transcript", "Import Transcript…",  true, Some("CmdOrCtrl+Shift+T"))?,
            &MenuItem::with_id(app, "reveal_library",    "Reveal Transcript Library", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &MenuItem::with_id(app, "toggle_pipeline", "Toggle Pipeline Log", true, Some("CmdOrCtrl+\\"))?,
            &MenuItem::with_id(app, "toggle_queue",    "Toggle Side Panel",   true, Some("CmdOrCtrl+Shift+Q"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "check_updates", "Check for Updates…",  true, None::<&str>)?,
            &MenuItem::with_id(app, "report_bug",    "Report a Bug…",       true, None::<&str>)?,
            &MenuItem::with_id(app, "open_repo",     "Open GitHub Repo…",   true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "show_command_palette", "Command Palette…", true, Some("CmdOrCtrl+K"))?,
        ],
    )?;

    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::JobRegistry::default())
        .manage(commands::LlmServer::default())
        .manage(commands::SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::fetch_metadata,
            commands::create_clip,
            commands::download_captions,
            commands::save_thumbnail,
            commands::list_whisper_models,
            commands::download_whisper_model,
            commands::delete_whisper_model,
            commands::parakeet_model_downloaded,
            commands::download_parakeet_model,
            commands::delete_parakeet_model,
            commands::dictate_start,
            commands::dictate_native_start,
            commands::dictate_stop,
            commands::list_audio_input_devices,
            commands::generate_transcript,
            commands::list_llm_models,
            commands::download_llm_model,
            commands::delete_llm_model,
            commands::start_llm_server,
            commands::stop_llm_server,
            commands::llm_server_status,
            commands::probe_local_file,
            commands::get_file_size,
            commands::read_file_range,
            commands::probe_media_info,
            commands::prepare_local_for_playback,
            commands::extract_local_frame,
            commands::generate_local_thumbnail,
            commands::scan_library_folder,
            commands::scan_transcript_library,
            commands::transcribe_local_file,
            commands::transcribe_prepared_wav,
            commands::re_diarize_transcript,
            commands::extract_frame,
            commands::get_direct_stream_url,
            commands::download_web_preview,
            commands::download_audio_track,
            commands::cancel_job,
            commands::reveal_in_finder,
            commands::open_privacy_pane,
            commands::av_permission_status,
            commands::write_bytes_to_path,
            commands::screen_capture_access,
            commands::list_displays,
            commands::list_share_sources,
            commands::start_screen_share,
            commands::stop_screen_share,
            commands::new_job_id,
            commands::read_text_file_capped,
            commands::probe_diarizer,
            commands::prepare_diarizer_models,
            commands::ensure_dir_exists,
            commands::default_transcript_library_path,
            commands::cleanup_stale_cache,
            commands::get_cache_stats,
            commands::clear_all_cache,
            commands::clear_cache_category,
            commands::get_warm_start,
            commands::get_backend_build_id,
            commands::get_stream_proxy_base,
            commands::ytdlp_version,
            commands::update_ytdlp,
            commands::reset_ytdlp,
            commands::open_youtube_signin,
            commands::open_full_disk_access,
            commands::safari_fda_status,
            commands::latest_release,
            commands::open_panel_window,
            commands::close_panel_window,
            commands::session_start,
            commands::session_join,
            commands::session_leave,
            commands::session_broadcast,
            commands::session_send,
        ])
        .setup(|app| {
            // Fit the main window to the screen at launch. The static conf
            // default (1400×900) reads cramped on large displays and would
            // overflow small ones — so size to ~85%×90% of the monitor,
            // clamped to sane bounds, and center. Best-effort: any failure
            // leaves the conf default in place.
            if let Some(win) = app.get_webview_window("main") {
                if let Ok(Some(monitor)) = win.current_monitor() {
                    let m = monitor.size().to_logical::<f64>(monitor.scale_factor());
                    let w = (m.width * 0.85).clamp(1100.0, 2100.0);
                    let h = (m.height * 0.90).clamp(700.0, 1300.0);
                    let _ = win.set_size(tauri::LogicalSize::new(w, h));
                    let _ = win.center();
                }
            }

            // Repair sidecar execute bits BEFORE anything can spawn one.
            // iCloud eviction/restore strips +x, and a non-executable
            // sidecar dies at spawn with EACCES. Cheap (a handful of
            // stat calls), synchronous on purpose.
            let repaired = commands::ensure_sidecars_executable(app.handle());
            if repaired > 0 {
                eprintln!("[startup] repaired {repaired} sidecar execute bit(s)");
            }

            // Start the loopback media proxy (r58). WKWebView's <video>
            // can't stream googlevideo URLs directly or via custom URI
            // schemes; it CAN stream from http://127.0.0.1. See
            // stream_proxy.rs for the full rationale. Non-fatal if it
            // fails to bind — the app falls back to the download path.
            match stream_proxy::start() {
                // Don't log the base — it carries the per-session capability token.
                Ok(_) => eprintln!("[startup] media proxy listening (loopback, token-gated)"),
                Err(e) => eprintln!("[startup] media proxy failed to start: {e}"),
            }

            // Build + install the native menu bar.
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;
            // Fan menu clicks out as `menu:<id>` window events. The React
            // layer subscribes via the standard `listen()` API so menu
            // items, toolbar buttons, and palette commands all flow
            // through the same handler functions.
            app.on_menu_event(|app, event| {
                let id = event.id().0.as_str();
                // Web/static URLs that don't need React in the loop —
                // open them directly via the system browser.
                let opened_in_browser: Option<&str> = match id {
                    "report_bug" => Some("https://github.com/gchiaramonte3/SauceBunny/issues/new/choose"),
                    "open_repo" => Some("https://github.com/gchiaramonte3/SauceBunny/releases"),
                    _ => None,
                };
                if let Some(url) = opened_in_browser {
                    let _ = std::process::Command::new("open").arg(url).spawn();
                    return;
                }
                // Everything else: emit to the focused window for React
                // to handle. The event name is `menu:<id>` so the JS
                // dispatch table is a one-liner.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit(&format!("menu:{}", id), ());
                }
            });

            // Sweep stale `saucebunny-*` artifacts (playback prep, audio raw,
            // whisper wavs) older than 24h so the app_cache_dir() doesn't
            // grow without bound across sessions. Failures here are
            // non-fatal — worst case the user's cache is a bit larger.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                match commands::cleanup_stale_cache(handle) {
                    Ok(n) if n > 0 => eprintln!("[startup] swept {} stale cache files", n),
                    Ok(_) => {}
                    Err(e) => eprintln!("[startup] cache sweep failed: {e}"),
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Kill the resident llama-server on quit — it holds a multi-GB
            // model in memory and would otherwise survive as an orphan.
            if let tauri::RunEvent::Exit = event {
                app.state::<commands::LlmServer>().shutdown();
                // Every OTHER sidecar too. Nothing drained the JobRegistry on
                // exit, so an in-flight yt-dlp/ffmpeg/whisper outlived the app
                // (three orphaned yt-dlp+ffmpeg pairs were found still pulling
                // the same download half an hour after their app instance had
                // quit, starving the next launch of bandwidth).
                let registry = app.state::<commands::JobRegistry>();
                let mut killed = 0usize;
                for id in registry.active_ids() {
                    if let Some(child) = registry.take(&id) {
                        if child.kill().is_ok() { killed += 1; }
                    }
                }
                if killed > 0 {
                    eprintln!("[shutdown] killed {killed} in-flight sidecar job(s)");
                }
            }
        });
}
