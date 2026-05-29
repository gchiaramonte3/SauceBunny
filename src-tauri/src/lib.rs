mod commands;
mod error;
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
        .invoke_handler(tauri::generate_handler![
            commands::fetch_metadata,
            commands::create_clip,
            commands::download_captions,
            commands::save_thumbnail,
            commands::list_whisper_models,
            commands::download_whisper_model,
            commands::delete_whisper_model,
            commands::generate_transcript,
            commands::probe_local_file,
            commands::prepare_local_for_playback,
            commands::extract_local_frame,
            commands::generate_local_thumbnail,
            commands::transcribe_local_file,
            commands::transcribe_prepared_wav,
            commands::extract_frame,
            commands::get_direct_stream_url,
            commands::download_web_preview,
            commands::cancel_job,
            commands::reveal_in_finder,
            commands::write_bytes_to_path,
            commands::new_job_id,
            commands::read_text_file_capped,
            commands::probe_diarizer,
            commands::run_diarizer,
            commands::prepare_diarizer_models,
            commands::ensure_dir_exists,
            commands::default_transcript_library_path,
            commands::cleanup_stale_cache,
            commands::get_cache_stats,
            commands::clear_all_cache,
            commands::get_backend_build_id,
            commands::get_stream_proxy_base,
            commands::open_panel_window,
            commands::close_panel_window,
        ])
        .setup(|app| {
            // Start the loopback media proxy (r58). WKWebView's <video>
            // can't stream googlevideo URLs directly or via custom URI
            // schemes; it CAN stream from http://127.0.0.1. See
            // stream_proxy.rs for the full rationale. Non-fatal if it
            // fails to bind — the app falls back to the download path.
            match stream_proxy::start() {
                Ok(base) => eprintln!("[startup] media proxy listening on {base}"),
                Err(e) => eprintln!("[startup] media proxy failed to start: {e}"),
            }

            // Build + install the native menu bar.
            let menu = build_menu(&app.handle())?;
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
                    "report_bug" => Some("https://github.com/saucebunny/saucebunny/issues/new/choose"),
                    "open_repo" | "check_updates" => Some("https://github.com/saucebunny/saucebunny/releases"),
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
