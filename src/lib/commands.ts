/**
 * Single source of truth for every action the app exposes.
 *
 * - The toolbar binds the most-common 4-6 actions to bevelled buttons.
 * - The keyboard handler in App.tsx binds the most-common shortcuts.
 * - The ⌘K command palette enumerates ALL of them with fuzzy search.
 * - The Settings → Shortcuts tab renders this same list as documentation.
 *
 * The intent: any new action gets one entry here and shows up in three
 * places at once with no further wiring. Keeps the toolbar tight while
 * making every capability discoverable.
 */

import type { Dispatch, SetStateAction } from "react";

export type CommandGroup =
  | "Source"
  | "Playback"
  | "Marks"
  | "Export"
  | "Queue"
  | "Transcript"
  | "View"
  | "App";

export type Command = {
  /** Stable id — used for React keys + future MRU ranking. */
  id: string;
  /** Short, human-readable verb phrase ("Export clip", "Mark in"). */
  label: string;
  /** Bucket header in the palette + settings list. */
  group: CommandGroup;
  /** Optional one-line hint shown below the label. */
  description?: string;
  /**
   * Display string for the keyboard shortcut (e.g. "⌘K", "⇧I"). Pure
   * cosmetic — the actual key binding lives in the keyboard handler.
   * Kept here so the palette and settings list don't drift from the
   * real bindings.
   */
  hotkey?: string;
  /**
   * Extra search terms not visible in the label. E.g. "Toggle queue"
   * might list `["clips", "drawer"]` so a search for "clips" still hits.
   */
  keywords?: string[];
  /** When true, the row renders dimmed and the run handler is skipped. */
  disabled?: boolean;
  /** Side-effecting handler invoked on Enter / click. */
  run: () => void;
};

/**
 * Everything `buildCommands` needs from App to assemble the registry. App owns
 * all the state + handlers; this keeps `buildCommands` a pure function (no Tauri
 * imports, no React state) so the registry is testable and lives next to its types.
 *
 * Values are flattened to primitives (e.g. `exportFolder`, `clipQueueLength`) so
 * this module stays decoupled from the app's larger types. The single
 * side-effecting command (the diarizer probe) is injected as `onProbeDiarizer`.
 */
export type CommandDeps = {
  // ── derived state ──
  url: string;
  hasSource: boolean;
  isPlaying: boolean;
  inFrames: number | null;
  outFrames: number | null;
  durationFrames: number;
  captionsOn: boolean;
  logsOpen: boolean;
  clipQueueLength: number;
  queueRunning: boolean;
  activeTranscriptPath: string | null;
  exportFolder: string | null;
  sourceKind: string;
  status: string;
  transcriptState: string;
  playbackPrepBusy: boolean;
  // ── handlers ──
  handleFetch: () => void;
  handleImportFile: () => void;
  handleClear: () => void;
  onPlayToggle: () => void;
  seekBySeconds: (s: number) => void;
  onStep: (dir: number) => void;
  onSeek: (frame: number) => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onClearMarks: () => void;
  onGotoIn: () => void;
  onGotoOut: () => void;
  handleExport: () => void;
  handleSnapshot: () => void;
  handleAddToQueue: () => void;
  handleExportQueue: () => void;
  handleQueueClearAll: () => void;
  handleImportTranscript: () => void;
  handleGenerateTranscript: () => void;
  handleDownloadCaptions: () => void;
  handleStop: () => void;
  onProbeDiarizer: () => void;
  // ── setters used directly in run handlers ──
  setQueueOpen: Dispatch<SetStateAction<boolean>>;
  setTranscriptArrivedTick: Dispatch<SetStateAction<number>>;
  setCaptionsOn: Dispatch<SetStateAction<boolean>>;
  setLogsOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
};

/**
 * Build the full command registry from App's current state + handlers. Pure:
 * given the same deps it returns the same list. App wraps this in a `useMemo`
 * with the matching dependency array, so memoization is unchanged from when this
 * lived inline. Disabled predicates mirror the toolbar/sidebar button gates so
 * the palette never offers an action that wouldn't work.
 */
export function buildCommands(d: CommandDeps): Command[] {
  return [
    // ── Source ───────────────────────────────────────────────────
    { id: "src.fetch", label: "Fetch URL", group: "Source",
      hotkey: "⌘↵", description: "Resolve the URL in the address bar",
      disabled: !d.url, run: () => d.handleFetch() },
    { id: "src.import", label: "Import local file…", group: "Source",
      description: "Pick a video or audio file from disk",
      run: () => d.handleImportFile() },
    { id: "src.clear", label: "Clear source", group: "Source",
      description: "Unload the current video", disabled: !d.hasSource,
      run: () => d.handleClear() },
    // ── Playback ────────────────────────────────────────────────
    { id: "play.toggle", label: d.isPlaying ? "Pause" : "Play",
      group: "Playback", hotkey: "Space", disabled: !d.hasSource,
      run: () => d.onPlayToggle() },
    { id: "play.back5",    label: "Back 5 seconds",    group: "Playback",
      hotkey: "J", disabled: !d.hasSource, run: () => d.seekBySeconds(-5) },
    { id: "play.fwd5",     label: "Forward 5 seconds", group: "Playback",
      hotkey: "L", disabled: !d.hasSource, run: () => d.seekBySeconds(5) },
    { id: "play.frameBack", label: "Step 1 frame back",    group: "Playback",
      hotkey: "←", disabled: !d.hasSource, run: () => d.onStep(-1) },
    { id: "play.frameFwd",  label: "Step 1 frame forward", group: "Playback",
      hotkey: "→", disabled: !d.hasSource, run: () => d.onStep(1) },
    { id: "play.toStart",  label: "Jump to start", group: "Playback",
      hotkey: "Home", disabled: !d.hasSource, run: () => d.onSeek(0) },
    { id: "play.toEnd",    label: "Jump to end",   group: "Playback",
      hotkey: "End",
      disabled: !d.hasSource,
      run: () => d.onSeek(Math.max(0, d.durationFrames - 1)) },
    // ── Marks ────────────────────────────────────────────────────
    { id: "mark.in",   label: "Mark in",  group: "Marks", hotkey: "I",
      disabled: !d.hasSource, run: () => d.onMarkIn() },
    { id: "mark.out",  label: "Mark out", group: "Marks", hotkey: "O",
      disabled: !d.hasSource, run: () => d.onMarkOut() },
    { id: "mark.clear", label: "Clear marks", group: "Marks", hotkey: "G",
      disabled: d.inFrames == null && d.outFrames == null,
      run: () => d.onClearMarks() },
    { id: "mark.gotoIn",  label: "Go to mark in",  group: "Marks", hotkey: "Q",
      disabled: d.inFrames == null, run: () => d.onGotoIn() },
    { id: "mark.gotoOut", label: "Go to mark out", group: "Marks", hotkey: "W",
      disabled: d.outFrames == null, run: () => d.onGotoOut() },
    // ── Export ──────────────────────────────────────────────────
    { id: "export.clip", label: "Export clip", group: "Export",
      hotkey: "⌥E",
      description: d.hasSource ? "Save the current selection" : "Load a source first",
      disabled: !d.hasSource || !d.exportFolder,
      run: () => d.handleExport() },
    { id: "export.snapshot", label: "Snapshot frame", group: "Export",
      description: "Save the current frame as a JPEG",
      disabled: !d.hasSource, run: () => d.handleSnapshot() },
    // ── Queue ───────────────────────────────────────────────────
    { id: "queue.add",    label: "Add selection to queue", group: "Queue",
      hotkey: "⌘⇧A",
      disabled: !d.hasSource || d.inFrames == null || d.outFrames == null,
      run: () => d.handleAddToQueue() },
    { id: "queue.toggle", label: "Toggle queue panel", group: "Queue",
      hotkey: "⌘⇧Q", keywords: ["clips", "drawer"],
      run: () => d.setQueueOpen((p) => !p) },
    { id: "queue.export", label: "Export all queued clips", group: "Queue",
      disabled: d.clipQueueLength === 0 || d.queueRunning || !d.exportFolder,
      run: () => d.handleExportQueue() },
    { id: "queue.clear",  label: "Clear queue", group: "Queue",
      disabled: d.clipQueueLength === 0 || d.queueRunning,
      run: () => d.handleQueueClearAll() },
    // ── Transcript ──────────────────────────────────────────────
    { id: "tx.import", label: "Import transcript from disk…", group: "Transcript",
      description: "Open a .srt or .vtt file from anywhere on disk",
      keywords: ["load", "open", "subtitle", "captions"],
      run: () => d.handleImportTranscript() },
    { id: "tx.open", label: "Open transcript panel", group: "Transcript",
      description: d.activeTranscriptPath
        ? `View ${d.activeTranscriptPath.split("/").pop()}`
        : "The panel opens but is empty until you generate a transcript",
      keywords: ["captions", "subtitles", "reader"],
      run: () => {
        d.setQueueOpen(true);
        // Bumping arrivedTick is what the drawer listens for to switch
        // to the Transcript tab; reuse it as our "show this tab now" lever.
        d.setTranscriptArrivedTick((n) => n + 1);
      } },
    { id: "tx.generate", label: "Generate transcript (Whisper)", group: "Transcript",
      disabled: !d.hasSource || !d.exportFolder,
      run: () => d.handleGenerateTranscript() },
    { id: "tx.download", label: "Download YouTube captions", group: "Transcript",
      description: "yt-dlp pulls the .srt file",
      disabled: !d.hasSource || d.sourceKind === "file" || !d.exportFolder,
      run: () => d.handleDownloadCaptions() },
    // ── Dev — diarizer smoke test ───────────────────────────────
    // B.1 scaffolding only: runs `saucebunny-diarize --version` via the
    // probe command and shows the result in a toast. Confirms the Swift
    // binary is built and reachable through the Tauri sidecar plumbing.
    { id: "tx.probe-diarizer", label: "Probe diarizer (dev)", group: "Transcript",
      description: "Smoke-test the saucebunny-diarize Swift sidecar",
      keywords: ["fluidaudio", "speakers", "swift"],
      run: () => d.onProbeDiarizer() },
    // ── View ────────────────────────────────────────────────────
    { id: "view.captions", label: d.captionsOn ? "Hide captions" : "Show captions",
      group: "View", disabled: !d.hasSource,
      run: () => d.setCaptionsOn((p) => !p) },
    { id: "view.logs", label: d.logsOpen ? "Collapse pipeline" : "Expand pipeline",
      group: "View", hotkey: "⌘\\",
      run: () => d.setLogsOpen((p) => !p) },
    // ── App ─────────────────────────────────────────────────────
    { id: "app.settings", label: "Open settings", group: "App", hotkey: "⌘,",
      run: () => d.setSettingsOpen(true) },
    { id: "app.palette", label: "Show command palette", group: "App", hotkey: "⌘K",
      run: () => d.setPaletteOpen(true) },
    { id: "app.stop", label: "Stop running operation", group: "App",
      description: "Cancel the in-flight export / transcript / prep",
      disabled: d.status !== "exporting" && d.transcriptState !== "running" && !d.playbackPrepBusy,
      run: () => d.handleStop() },
  ];
}

/**
 * Fuzzy-ish matcher tuned for command-palette use. Not as good as
 * Fuse.js but zero dependencies and good enough for ~25 commands.
 *
 * Score is the sum of:
 *  - exact-substring hit in label  (10)
 *  - exact-substring hit in keywords/group/description (5 each)
 *  - per-char in-order match in label (1 each, +2 if at word start)
 * Higher = better. Returns 0 (filtered out) when no chars match at all.
 */
export function scoreCommand(cmd: Command, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1; // empty query → show all, neutral order
  const label = cmd.label.toLowerCase();
  const haystack = `${label} ${cmd.group.toLowerCase()} ${(cmd.keywords ?? []).join(" ").toLowerCase()} ${(cmd.description ?? "").toLowerCase()}`;

  let score = 0;
  if (label.includes(q)) score += 10;
  if (haystack.includes(q)) score += 5;

  // Per-char in-order match against the label.
  let qi = 0;
  let prevWasSeparator = true;
  for (let i = 0; i < label.length && qi < q.length; i++) {
    const ch = label[i];
    if (ch === q[qi]) {
      score += prevWasSeparator ? 3 : 1;
      qi++;
    }
    prevWasSeparator = ch === " " || ch === "-" || ch === "_";
  }
  if (qi < q.length) return 0; // not all query chars matched in order
  return score;
}
