/**
 * Browser-side Tauri IPC mock for the Playwright smoke run.
 *
 * tauri-driver has no macOS support (there is no WKWebView WebDriver), so the
 * smoke harness drives the Vite-served frontend in Chromium with the IPC layer
 * stubbed at the `window.__TAURI_INTERNALS__` seam — exactly the surface
 * `@tauri-apps/api` calls (core.js: invoke / transformCallback /
 * unregisterCallback / convertFileSrc). This proves the shell boots and the
 * chrome is wired; the native pipeline stays covered by cargo/swift tests.
 *
 * Injected via `page.addInitScript` BEFORE any app code runs. Keep it
 * dependency-free — it executes in the page, not in Node.
 */
export function tauriMockInit(expectedBuildId: string): void {
  const callbacks = new Map<number, (payload: unknown) => void>();
  // event name → handler callback ids, recorded from plugin:event|listen so
  // tests can push Tauri events (e.g. tauri://drag-*) into the app.
  const listeners = new Map<string, Set<number>>();
  let nextCallbackId = 1;

  // Shaped responses for the commands the shell actually calls on boot /
  // first interaction. Anything not listed resolves to null — the app's
  // error paths tolerate that, and the smoke run watches for pageerrors.
  //
  // The review store hydrates BEFORE first render (main.tsx): it derives its
  // Reviews dir from default_transcript_library_path, then reads index.json
  // via read_text_file_capped. Returning a real-looking path here exercises
  // that whole path; the null fallthrough for read_text_file_capped reads as
  // "no index yet" (fresh store), and ensure_dir_exists/write_bytes_to_path
  // null-resolve as success — boot never blocks on hydration.
  const table: Record<string, unknown> = {
    get_backend_build_id: expectedBuildId,
    get_cache_stats: { total_bytes: 0, entries: 0, files: [] },
    list_whisper_models: [],
    list_llm_models: [],
    list_audio_input_devices: [],
    get_downloaded_models: [],
    default_transcript_library_path: "/e2e-mock/Documents/Sauce Bunny/Transcripts",
  };

  // The event plugin's unlisten path calls this directly (event.js).
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, id: number) => { listeners.get(event)?.delete(id); },
  };

  // Test-only hook: emit a Tauri event into the app exactly the way the Rust
  // side would (the handler receives the { event, id, payload } envelope).
  (window as unknown as Record<string, unknown>).__TAURI_MOCK__ = {
    emitTauriEvent: (event: string, payload: unknown) => {
      for (const id of listeners.get(event) ?? []) {
        callbacks.get(id)?.({ event, id, payload });
      }
    },
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args?: unknown) => {
      if (cmd === "plugin:event|listen") {
        const a = args as { event: string; handler: number };
        let set = listeners.get(a.event);
        if (!set) { set = new Set(); listeners.set(a.event, set); }
        set.add(a.handler);
        // Resolves to the eventId that event.js later passes back to
        // unregisterListener — using the handler id keeps them in sync.
        return Promise.resolve(a.handler);
      }
      if (cmd === "plugin:event|unlisten") return Promise.resolve(null);
      if (cmd in table) return Promise.resolve(table[cmd]);
      return Promise.resolve(null);
    },
    transformCallback: (cb: (payload: unknown) => void, _once?: boolean) => {
      const id = nextCallbackId++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback: (id: number) => { callbacks.delete(id); },
    convertFileSrc: (p: string, protocol = "asset") => `${protocol}://localhost/${encodeURIComponent(p)}`,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
    plugins: {},
  };
}
