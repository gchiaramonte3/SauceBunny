// Test-only filesystem routing. All session send/receive, save/read, NDI,
// companion observations, and Tauri events still use the real native app.
export * from "../node_modules/@tauri-apps/api/core";
import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from "../node_modules/@tauri-apps/api/core";
declare const __MARKER_GUEST_ROOT__: string;

export function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  if (cmd === "default_transcript_library_path") {
    // Production stores derive Reviews/Screenings/Casts beside Transcripts.
    // A distinct bundle alone would NOT isolate those Documents stores.
    return Promise.resolve(`${__MARKER_GUEST_ROOT__}/Transcripts` as T);
  }
  if (cmd === "has_review_identity") return Promise.resolve(false as T);
  if (["review_code", "session_start", "reset_review_identity", "create_review_grant"].includes(cmd)) {
    return Promise.reject(new Error("This isolated test app is guest-only; hosting and host identity access are disabled."));
  }
  return nativeInvoke<T>(cmd, args, options);
}
