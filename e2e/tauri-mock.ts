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
  let nextCallbackId = 1;

  // Shaped responses for the commands the shell actually calls on boot /
  // first interaction. Anything not listed resolves to null — the app's
  // error paths tolerate that, and the smoke run watches for pageerrors.
  const table: Record<string, unknown> = {
    get_backend_build_id: expectedBuildId,
    get_cache_stats: { total_bytes: 0, entries: 0, files: [] },
    list_whisper_models: [],
    list_llm_models: [],
    list_audio_input_devices: [],
    get_downloaded_models: [],
  };

  // The event plugin's unlisten path calls this directly (event.js).
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, _id: number) => {},
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, _args?: unknown) => {
      if (cmd === "plugin:event|listen") return Promise.resolve(nextCallbackId++);
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
