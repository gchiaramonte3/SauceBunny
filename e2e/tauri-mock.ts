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
  // first interaction. Function values are called with the invoke args
  // (return a value, a promise, or throw/reject an AppError-shaped object);
  // anything not listed resolves to null — the app's error paths tolerate
  // that, and the smoke run watches for pageerrors.
  //
  // The review store hydrates BEFORE first render (main.tsx): it derives its
  // Reviews dir from default_transcript_library_path, then reads index.json
  // via read_text_file_capped. Returning a real-looking path here exercises
  // that whole path; the null fallthrough for read_text_file_capped reads as
  // "no index yet" (fresh store), and ensure_dir_exists/write_text_to_path
  // (like every other unlisted write command) null-resolve as success — boot
  // never blocks on hydration.
  /**
   * OPT-IN file contents, for specs that need a real transcript on screen.
   *
   * A spec seeds `localStorage["e2e.files"]` with a `{ path: contents }` map
   * before boot; `read_text_file_capped` then serves those paths and falls
   * through to null for everything else. Absent by default, so the 105 specs
   * that predate this see byte-identical behaviour — the review store still
   * hydrates as "no index yet", and the transcript tab still shows its empty
   * state.
   *
   * This exists because the transcript viewer is the largest component in the
   * app and had NO behavioural coverage: it renders twice at once (reader +
   * drawer keep-alive), which is a whole-app property no component test can
   * reach, and the reason it went untested was purely that the mock could not
   * put a transcript on screen.
   */
  const seededFiles = (): Record<string, string> => {
    try { return JSON.parse(localStorage.getItem("e2e.files") ?? "{}"); }
    catch { return {}; }
  };

  const emptyCacheCategory = { file_count: 0, bytes_total: 0 };
  const table: Record<string, unknown> = {
    read_text_file_capped: (args: Record<string, unknown>) => {
      const path = String((args as { path?: string }).path ?? "");
      const hit = seededFiles()[path];
      // `undefined` (not null) so an unseeded path keeps the historical
      // fallthrough exactly: the app reads it as "no file", never as "".
      return hit === undefined ? null : hit;
    },
    get_backend_build_id: expectedBuildId,
    get_cache_stats: {
      file_count: 0,
      bytes_total: 0,
      path: "/e2e-mock/Caches/com.saucebunny.app",
      downloads: emptyCacheCategory,
      audio: emptyCacheCategory,
      meta: emptyCacheCategory,
      thumbnails: emptyCacheCategory,
      scratch: emptyCacheCategory,
    },
    clear_all_cache: 0,
    clear_cache_category: 0,
    // Warm-boot probe (r112): the smoke run never loads a real web source,
    // so a cold-boot shape keeps any fetch path on the normal route.
    get_warm_start: { metadata: null, metadata_stale: true, stream: null, cached_copy: null },
    // Two-source reset spec: per-URL titles so filename seeding is
    // observable. The stream resolver rejects benignly (caught by the web
    // machine as a fetch failure) — metadata hydrate still runs, which is
    // all the filename/title assertions need.
    fetch_metadata: (args: Record<string, unknown>) => {
      const url = String((args as { url?: string }).url ?? "");
      const which = url.includes("bbbb") ? "B" : "A";
      return {
        title: `Source ${which} title`,
        webpage_url: url,
        uploader: "e2e",
        duration: 120,
        fps: 30,
        width: 1920,
        height: 1080,
        has_subs: false,
        thumbnail: null,
        extractor: "youtube",
        view_count: null,
        upload_date: null,
      };
    },
    get_direct_stream_url: () => Promise.reject(new Error("e2e: no stream")),
    download_audio_track: () => Promise.reject(new Error("e2e: no audio")),
    // One DOWNLOADED model, not an empty list. Empty meant the whole model
    // region of Settings rendered nothing, so every sweep that walks visible
    // controls (contrast, target-size, accessible-names, focus-visible) was
    // blind to the rows holding "Use as default" and the armed Delete — the
    // most consequential button in Settings. Shapes match the ts-rs bindings.
    list_whisper_models: [
      { id: "small", name: "Small", size_bytes: 488_000_000, url: "https://example/small.bin", downloaded: true, path: "/e2e-mock/whisper/small.bin" },
      { id: "large-v3", name: "Large v3", size_bytes: 3_100_000_000, url: "https://example/large.bin", downloaded: false, path: null },
    ],
    list_llm_models: [],
    list_audio_input_devices: [],
    get_downloaded_models: [],
    default_transcript_library_path: "/e2e-mock/Documents/Sauce Bunny/Transcripts",
    // Library thumbnails: a 0-byte "file" makes mediabunny bail cleanly
    // (extractFrameAsBlob → null) without ever range-reading, and the null
    // fallthrough for generate_local_thumbnail lands every card on its
    // placeholder — no decode work, no unhandled rejections.
    get_file_size: 0,
    // The Library browser's detail panel + card menu "Reveal in Finder".
    reveal_in_finder: null,
    // Library scan (LibraryView) — a small deterministic tree derived from
    // the requested root: two files + one subfolder with one file. Roots
    // containing "missing" reject with a typed AppError, exercising the
    // fail-loud inline error row.
    scan_library_folder: (args: unknown) => {
      const path = String((args as { path?: unknown } | undefined)?.path ?? "");
      if (path.includes("missing")) {
        return Promise.reject({ kind: "NotFound", data: path });
      }
      const mkItem = (dir: string, name: string, kind: string, size: number) => ({
        name, path: `${dir}/${name}`, size_bytes: size, modified_ms: 1749000000000, kind,
      });
      return {
        name: path.split("/").pop() || path,
        path,
        folders: [{
          name: "Interviews",
          path: `${path}/Interviews`,
          folders: [],
          items: [mkItem(`${path}/Interviews`, "intro.mp4", "video", 1048576)],
        }],
        items: [
          mkItem(path, "clip-a.mp4", "video", 2097152),
          mkItem(path, "voice-memo.m4a", "audio", 512000),
        ],
      };
    },
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
      if (cmd in table) {
        const v = table[cmd];
        // Promise.resolve().then flattens returned promises AND turns a
        // synchronous throw into a rejection — matching real invoke.
        return typeof v === "function"
          ? Promise.resolve().then(() => (v as (a: unknown) => unknown)(args))
          : Promise.resolve(v);
      }
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

  // ── navigator.mediaDevices mock (green-room onboarding smoke) ──────
  // Chromium in CI has no camera; the lobby's device flow runs against a
  // canvas-fed video track + an oscillator audio track. Two fake devices
  // per kind so the selects render real options. Seed
  // localStorage["e2e.avGranted"] = "1" to simulate a prior TCC grant
  // (drives the returning-user READY fast path via permissions.query).
  const fakeDevice = (kind: MediaDeviceKind, id: string, label: string) =>
    ({ kind, deviceId: id, groupId: "g0", label, toJSON: () => ({}) }) as MediaDeviceInfo;
  const makeStream = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160; canvas.height = 90;
    const draw = canvas.getContext("2d");
    if (draw) { draw.fillStyle = "#345"; draw.fillRect(0, 0, 160, 90); }
    const stream: MediaStream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(5);
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      const at = dest.stream.getAudioTracks()[0];
      if (at) stream.addTrack(at);
    } catch { /* audio optional in the smoke run */ }
    return stream;
  };
  const grantedFlag = () => { try { return localStorage.getItem("e2e.avGranted") === "1"; } catch { return false; } };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [
        fakeDevice("videoinput", "cam-a", grantedFlag() ? "Studio Display Camera" : ""),
        fakeDevice("videoinput", "cam-b", grantedFlag() ? "Continuity Camera" : ""),
        fakeDevice("audioinput", "mic-a", grantedFlag() ? "MacBook Pro Microphone" : ""),
        fakeDevice("audioinput", "mic-b", grantedFlag() ? "External Mic" : ""),
      ],
      getUserMedia: async () => {
        try { localStorage.setItem("e2e.avGranted", "1"); } catch { /* ignore */ }
        return makeStream();
      },
      addEventListener: () => { /* devicechange unused in the mock */ },
      removeEventListener: () => { /* symmetric no-op */ },
    },
  });
  const realQuery = navigator.permissions?.query?.bind(navigator.permissions);
  if (navigator.permissions) {
    Object.defineProperty(navigator.permissions, "query", {
      configurable: true,
      value: async (desc: { name: string }) => {
        if (desc.name === "camera" || desc.name === "microphone") {
          return { state: grantedFlag() ? "granted" : "prompt" } as PermissionStatus;
        }
        return realQuery ? realQuery(desc as PermissionDescriptor) : ({ state: "prompt" } as PermissionStatus);
      },
    });
  }
}
