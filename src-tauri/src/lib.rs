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
            // The cheat sheet is generated from the live binding table, so it
            // is always correct — and it was reachable only by already knowing
            // the chord, which is the one group of users who do not need it.
            &MenuItem::with_id(app, "show_shortcuts", "Keyboard Shortcuts…", true, Some("CmdOrCtrl+/"))?,
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

// ── Make the framework's own failures audible ────────────────────────
//
// Tauri reports protocol and scope failures through the `log` facade. The one
// that matters here is "asset protocol not configured to allow the path: …"
// from tauri::protocol::asset, which answers a denied read with 403 and an
// EMPTY body. With no logger installed those records were dropped, so a scope
// miss surfaced only as a black video or a broken thumbnail - the exact silent
// shape that made the r150 CSP bug take three reports to find. The asset scope
// is not allowed to fail that quietly.
//
// stderr only: no file, no network, no telemetry. Visible in `tauri dev` and
// when the app binary is launched from a terminal. WARN is limited to the
// framework crates so an app-wide dependency (iroh, quinn, rustls) cannot
// flood the terminal; ERROR is let through from everywhere, because an error
// nobody sees is how this class of bug happens.
struct StderrLog;

impl log::Log for StderrLog {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        match meta.level() {
            log::Level::Error => true,
            log::Level::Warn => {
                let t = meta.target();
                t.starts_with("tauri") || t.starts_with("wry") || t.starts_with("tao")
            }
            _ => false,
        }
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}: {}", record.level(), record.target(), record.args());
        }
    }

    fn flush(&self) {}
}

static STDERR_LOG: StderrLog = StderrLog;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Best effort: a second call (tests, a plugin that got there first) is a
    // no-op rather than a panic.
    let _ = log::set_logger(&STDERR_LOG).map(|()| log::set_max_level(log::LevelFilter::Warn));
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
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
            commands::llm_server_status,
            commands::set_api_key,
            commands::delete_api_key,
            commands::has_api_key,
            commands::cloud_chat,
            commands::cloud_chat_cancel,
            commands::set_turn_password,
            commands::get_turn_password,
            commands::probe_local_file,
            commands::get_file_size,
            commands::read_file_range,
            commands::probe_media_info,
            commands::prepare_local_for_playback,
            commands::extract_local_frame,
            commands::generate_local_thumbnail,
            commands::lookup_local_thumbnail,
            commands::save_poster_to_cache,
            commands::scan_library_folder,
            commands::scan_transcript_library,
            commands::rename_transcript,
            commands::sniff_page_media,
            commands::create_transcript_folder,
            commands::default_export_path,
            commands::list_transcript_folders,
            commands::rename_transcript_folder,
            commands::delete_transcript_folder,
            commands::move_transcript_to_folder,
            commands::save_transcript_analysis,
            commands::transcribe_local_file,
            commands::stage_prepared_wav,
            commands::transcribe_prepared_wav,
            commands::re_diarize_transcript,
            commands::extract_frame,
            commands::get_direct_stream_url,
            commands::download_web_preview,
            commands::download_audio_track,
            commands::cancel_job,
            commands::open_external_url,
            commands::read_clipboard_text,
            commands::reveal_in_finder,
            commands::move_to_trash,
            commands::open_privacy_pane,
            commands::av_permission_status,
            commands::set_clear_cache_on_quit,
            commands::enforce_media_cache_cap,
            commands::write_text_to_path,
            commands::write_raw_to_path,
            commands::screen_capture_access,
            commands::list_share_sources,
            commands::start_screen_share,
            commands::stop_screen_share,
            commands::read_text_file_capped,
            commands::read_transcripts_bulk,
            commands::rename_path,
            commands::read_finder_tags,
            commands::set_finder_tags,
            commands::probe_diarizer,
            commands::prepare_diarizer_models,
            commands::ensure_dir_exists,
            commands::default_transcript_library_path,
            commands::get_cache_stats,
            commands::clear_all_cache,
            commands::clear_cache_category,
            commands::get_warm_start,
            commands::frames_dir_path,
            commands::list_frames,
            commands::create_frames_folder,
            commands::list_frames_folders,
            commands::move_frame_to_folder,
            commands::delete_frame,
            commands::list_cached_web,
            commands::forget_cached_web,
            commands::get_backend_build_id,
            commands::get_stream_proxy_base,
            commands::peer_media_register,
            commands::peer_media_register_remote,
            commands::peer_media_unregister,
            commands::ytdlp_version,
            commands::update_ytdlp,
            commands::reset_ytdlp,
            commands::open_youtube_signin,
            commands::open_full_disk_access,
            commands::safari_fda_status,
            commands::cookie_browser_ready,
            commands::latest_release,
            commands::open_panel_window,
            commands::close_panel_window,
            commands::session_start,
            commands::session_join,
            commands::session_leave,
            commands::session_broadcast,
            commands::session_send,
            commands::session_offer_file,
            commands::session_clear_offer,
            commands::session_fetch_file,
            commands::session_cancel_fetch,
        ])
        .setup(|app| {
            // Window geometry: the user's, if they have expressed one.
            //
            // This used to re-fit to ~85%x90% of the monitor and re-center on
            // EVERY launch, so a window someone had sized and placed came back
            // wrong every morning — while the inner chrome (drawer width,
            // sidebar, view, sort, filters, poster choices) persisted nine
            // different ways. Only the outermost thing forgot.
            //
            // The screen-fit is still exactly right for a FIRST launch, where
            // the conf default reads cramped on a large display and overflows
            // a small one. So it stays, as the fallback.
            if let Some(win) = app.get_webview_window("main") {
                let restored = commands::restore_window_frame(&win);
                if !restored {
                    if let Ok(Some(monitor)) = win.current_monitor() {
                        let m = monitor.size().to_logical::<f64>(monitor.scale_factor());
                        let w = (m.width * 0.85).clamp(1100.0, 2100.0);
                        let h = (m.height * 0.90).clamp(700.0, 1300.0);
                        let _ = win.set_size(tauri::LogicalSize::new(w, h));
                        let _ = win.center();
                    }
                }
                commands::watch_window_frame(&win);
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
                // Layout migration FIRST: the sweep's scratch pass reads the
                // new directory, and an old install has nothing there until
                // this has run.
                if let Ok(cache) = handle.path().app_cache_dir() {
                    let moved = commands::migrate_cache_layout(&cache);
                    if moved > 0 {
                        eprintln!("[startup] tidied {moved} cache entries into the new layout");
                    }
                }
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
                // Clear-on-quit (Settings -> Cache). The marker FILE is the
                // pref: this runs after the webview and its storage are gone.
                if let Ok(data) = app.path().app_data_dir() {
                    if data.join(commands::CLEAR_ON_QUIT_FLAG).is_file() {
                        if let Ok(cache) = app.path().app_cache_dir() {
                            let media = cache.join("saucebunny-media");
                            if media.is_dir() && std::fs::remove_dir_all(&media).is_ok() {
                                eprintln!("[shutdown] cleared the media cache (clear-on-quit)");
                            }
                        }
                    }
                }
            }
        });
}
