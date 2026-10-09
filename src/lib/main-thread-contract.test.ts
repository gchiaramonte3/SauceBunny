import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * No NEW command runs on the main thread.
 *
 * A `#[tauri::command]` that is a plain `fn` runs on the app's MAIN thread,
 * the one that draws the window. Give it a path on Avid NEXIS during the
 * working day and a single `exists()` can take seconds; a read the volume
 * never answers leaves the thread in an uninterruptible kernel wait, and the
 * app freezes past Force Quit. That is what editors reported, and the worst
 * of it was not even a command: Tauri's own `asset://` handler read every
 * playing clip there (see asset_protocol.rs and asset-scope-contract).
 *
 * So a new command is `async fn`, or `#[tauri::command(async)]` when tests
 * call it as a plain function (Tauri then runs it on a thread pool). The
 * commands below stay on the main thread because they touch nothing a
 * network volume can hold up: settings, app data, child processes they
 * signal. NOT the Keychain: a Keychain read waits on a person whenever macOS
 * asks first (a re-signed or rebuilt binary, a locked login keychain), and on
 * the main thread that froze the window for the whole dialog - 86 s on
 * String Outs' open. Those commands now run on the blocking pool
 * (cloud_ai.rs `keychain`). Shrink-only: an entry made async must leave the
 * list, so the list cannot quietly become a licence.
 */

const ROOT = resolve(__dirname, "../..");

const MAIN_THREAD = new Set([
  "av_permission_status", "bleed_hidden", "cancel_job", "cloud_chat_cancel", "cookie_browser_ready", "create_review_grant",
  "default_export_path", "default_transcript_library_path", "delete_llm_model", "delete_parakeet_model",
  "delete_voiceprints", "delete_whisper_model", "dictate_stop", "edit_commit", "edit_create", "edit_head", "edit_history",
  "edit_jump", "edit_list", "edit_pin", "edit_redo", "edit_undo", "full_disk_access_status", "get_backend_build_id",
  "get_stream_failure", "get_stream_proxy_base", "list_llm_models",
  "list_review_grants", "list_whisper_models", "llm_server_status", "mcp_setup", "ndi_remote_source", "ndi_status",
  "ndi_timing_probe_read", "ndi_timing_probe_start", "ndi_timing_probe_stop", "obs_audio_acceptance_cancel",
  "obs_audio_acceptance_read", "obs_audio_acceptance_start", "obs_broadcast_start", "obs_broadcast_status",
  "obs_broadcast_stop", "open_external_url", "open_full_disk_access", "open_privacy_pane",
  "open_youtube_signin", "parakeet_model_downloaded", "peer_media_register_remote", "peer_media_unregister",
  "premiere_bridge_status", "premiere_bridge_stop", "premiere_enqueue_note", "premiere_marker_notes", "read_clipboard_text",
  "read_config", "review_invited_only", "safari_fda_status", "screen_capture_access",
  "session_cancel_fetch", "set_bleed_hidden", "set_clear_cache_on_quit", "set_review_invited_only",
  "start_screen_share", "stop_llm_server", "stop_screen_share", "take_pending_review_link",
  "video_set_foreground_busy", "voiceprints_summary",
]);

function rustFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) rustFiles(full, out);
    else if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

/** Every command, and whether it runs on the main thread. Attributes and comments between the macro and the fn are skipped. */
function commands() {
  const found: { name: string; main: boolean; file: string }[] = [];
  const pattern = /#\[tauri::command(\([^)]*\))?\]((?:\s*(?:\/\/[^\n]*|#\[[^\]]*\]))*)\s*pub\s+(async\s+)?fn\s+(\w+)/g;
  for (const file of rustFiles(resolve(ROOT, "src-tauri/src"))) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      const main = !match[3] && !(match[1] ?? "").includes("async");
      found.push({ name: match[4], main, file: file.slice(ROOT.length + 1) });
    }
  }
  return found;
}

describe("main-thread commands", () => {
  const all = commands();

  it("parses the command surface", () => {
    // A parser that matches nothing certifies everything.
    expect(all.length, "parsed almost no #[tauri::command] fns: the pattern broke").toBeGreaterThan(200);
    expect(all.filter((command) => command.main).length).toBeGreaterThan(50);
  });

  it("adds no command to the main thread", () => {
    const added = all.filter((command) => command.main && !MAIN_THREAD.has(command.name)).map((command) => `${command.file}: ${command.name}`);
    expect(added, "These commands run on the main thread. Make them `async fn`, or mark them `#[tauri::command(async)]`, "
      + "so a slow disk (Avid NEXIS) cannot freeze the window.").toEqual([]);
  });

  it("lists only commands that are still on the main thread", () => {
    const main = new Set(all.filter((command) => command.main).map((command) => command.name));
    const stale = [...MAIN_THREAD].filter((name) => !main.has(name));
    expect(stale, "These left the main thread (or were removed): take them off MAIN_THREAD.").toEqual([]);
  });
});
