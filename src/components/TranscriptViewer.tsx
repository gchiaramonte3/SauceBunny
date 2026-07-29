import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { IconReveal, IconAlert, IconChevronDown, IconInfo, IconTranscript } from "./Icons";
import { parseSrt, groupIntoTurns, serializeCues, fmtTime, type Turn } from "../lib/srt";
import { speakerStats } from "../lib/speaker-stats";
import { subscribePlayhead, getPlayheadFrames, playheadFramesToSeconds } from "../lib/playhead-store";
import { secondsToTc } from "../lib/timecode";
import { transcriptToAvidTxt } from "../lib/markers";
import { fpsToRateKey, DEFAULT_MARKER_SETTINGS } from "../lib/marker-time";
import { isValidSourceTc } from "../lib/library";
import { appUndo } from "../lib/undo";
import { UndoRedoButtons } from "./UndoRedoButtons";
import { formatError } from "../lib/error-format";
import { scrollBehavior } from "../lib/motion";
import {
  clearHistory,
  getHistory,
  removeEntry,
  type TranscriptHistoryEntry,
} from "../lib/transcript-history";
import { RenamePopover, type RenameState, type ReassignChoice } from "./transcript/RenamePopover";
import { SpeakerRosterModal } from "./transcript/SpeakerRosterModal";
import { SpeakerColorPicker } from "./SpeakerColorPicker";
import { HistoryPopover } from "./transcript/HistoryPopover";
import { InsightsPopover } from "./transcript/InsightsPopover";
import { TranscriptSearchBar, type SearchMode } from "./transcript/SearchBar";
import { CueEditor } from "./transcript/CueEditor";
import { CueSelectionMenu } from "./transcript/CueSelectionMenu";
import { NewSpeakerSheet } from "./transcript/NewSpeakerSheet";
import { SpeakerGroups } from "./transcript/SpeakerGroups";
import { KindGlyph } from "./transcript/KindGlyph";
import { KIND_LABEL, kindTag, NON_SPEECH_COLOR, speakerKind, type SpeechKind } from "../lib/speech-kind";
import { newSpeakerTag, paintCueRange, selectionToCueRange } from "./transcript/cue-selection";
import {
  escapeHtml,
  highlightMatch,
  humanizeSpeakerTag,
  resolveAliasChain,
  speakerColor,
  speakerTextColor,
  SPEAKERS_CHANGED_EVENT,
  loadSpeakerOverrides,
  retagCues,
  cueKey,
  type SpeakerOverrides,
} from "./transcript/helpers";

type Props = {
  /**
   * Absolute path on disk to the SRT/VTT file. When null, we render the
   * empty state. When changed, we reload + reparse.
   */
  path: string | null;
  /** Bumped by App on every transcript arrival. Regenerate / Fix-timing
   *  overwrite the SAME path, so this is what forces a re-read of the file
   *  when only its contents changed. Optional: the popped-out panel omits it. */
  reloadToken?: number;
  /**
   * True while this viewer should track the live playhead (a source is
   * loaded AND the tab is visible). The viewer subscribes to the playhead
   * store itself — no per-frame prop — driving the karaoke highlight at the
   * full tick rate. While false the highlight + autoscroll freeze, then snap
   * to the current position when it flips back on.
   */
  playheadActive: boolean;
  /** Click-to-seek callback. Called with seconds — the App converts to frames. */
  onSeek: (seconds: number) => void;
  /**
   * Origin tag — preserved as a prop because future features (e.g. a
   * "regenerate" button that should only show when the source was
   * Whisper, not a downloaded caption) need to discriminate. The header
   * no longer renders an origin badge — user feedback was that it added
   * noise without information they cared about — but the value is still
   * threaded through so we don't have to re-plumb it later.
   */
  origin: "captions" | "whisper" | "unknown";
  /** Dismiss the current transcript view (App clears activeTranscript). */
  onClearTranscript: () => void;
  /** App's undo/redo, so the toolbar buttons behave exactly like ⌘Z — same
   *  toast, same draft-first fallback. Omitted (in the popped-out panel, which
   *  has no App around it) the buttons drive the shared stack directly. */
  onUndo?: () => void;
  onRedo?: () => void;
  /** Open a past transcript from history. */
  onLoadFromHistory: (entry: TranscriptHistoryEntry) => void;
  /**
   * Re-run the transcript pipeline against the current source with
   * the current Settings (model, detect-speakers, expected-speakers).
   * Useful when an auto-loaded prior transcript was generated before
   * a fix/setting that the user now wants applied — they don't have
   * to hunt back to the Sidebar for the Generate button.
   */
  onRegenerate: () => void;
  /** Re-run ONLY speaker diarization on the current transcript (no Whisper
   *  re-run) — fast on long sources. Optional: omitted on the pop-out panel. */
  onRedetectSpeakers?: () => void;
  /** True when re-detecting speakers is possible (a transcript + a source). */
  canRedetect?: boolean;
  /** Open a .srt / .vtt from disk into the viewer (and add to history). */
  onImportTranscript: () => void;
  /**
   * True when a transcript is currently being generated. Used to grey
   * out the Regenerate button so the user can't queue two runs.
   */
  regenerateBusy: boolean;
  /**
   * True when there's a loaded source we COULD regenerate against.
   * False right after the source is cleared but a transcript is still
   * visible — in that case the button hides rather than failing.
   */
  canRegenerate: boolean;
  /**
   * Frame rate of the loaded source, so the per-turn timestamps render in
   * the same SMPTE HH:MM:SS:FF the player/transport show. Falls back to 30
   * when no source is loaded (an imported transcript with no video).
   */
  fps?: number;
  /** Source start timecode (HH:MM:SS:FF) for the Avid marker export — the
   *  burn-in origin every marker is offset from. Undefined → a 0-based origin
   *  ("00:00:00:00"), i.e. markers at raw time-from-start-of-source. */
  startTimecode?: string;
  /** Persist the source's start timecode (or clear it with null). When omitted,
   *  the "Set source start timecode…" tool is hidden (no source to key it to). */
  onSetSourceTimecode?: (tc: string | null) => void;
  /** Capture the frame on screen as a cast member's face. Absent in the panel
   *  window, which has no player. */
  onGrabFace?: () => Promise<string | null>;
  /** r84: source kind — the "fix caption timing" banner only applies to web
   *  sources (YouTube auto-caption ASR timing is the loose case). */
  sourceKind?: "youtube" | "file";
  /** r84: re-time the loose YouTube captions with Whisper (full range, reusing
   *  the cached audio). When omitted (e.g. the popped-out panel), the banner
   *  is hidden rather than showing a dead button. */
  onFixCaptionTiming?: () => void;
  /**
   * True when a media source is loaded. Gates the empty-state's primary
   * "Generate transcript" button (which fires the SAME handler as the
   * sidebar's Generate) — without a source it's disabled with a hint.
   * Distinct from `canRegenerate`, which also requires a downloaded model;
   * clicking Generate with no model bounces to Settings → Transcription,
   * which is more helpful than a dead button.
   */
  hasSource?: boolean;
  /**
   * Inline cue editing rewrote the SRT/VTT file in place. App bumps the
   * arrived tick so every other reader of the same file (on-video captions,
   * AI summary, timeline speaker lanes) re-reads. Optional: in the popped-out
   * panel it routes over the panel action bus.
   */
  onTranscriptEdited?: () => void;
};

// ── Speaker overrides ─────────────────────────────────────────────
// Four layers, resolved in this order (later wins):
//   1. aliases:  tag → tag    "these two are the same person"
//   2. global:   tag → name   "rename SPEAKER_00 → Tom everywhere"
//   3. turnTag:  ti  → tag    "this one turn belongs to that OTHER speaker"
//   4. turn:     ti  → name   "this one turn is actually …" (free text)
//
// displayNameFor() walks the alias chain first (so a merged speaker
// resolves to its target tag), then applies the global rename on the
// resolved tag, then the per-turn override. Color is also keyed on
// the resolved tag so merged speakers share a colour — a turnTag
// reassignment resolves to the TARGET tag, so the turn takes the
// target speaker's name AND colour (and follows later renames of it).
//
// All layers persist together in localStorage keyed by path.
/**
 * The shape lives in transcript/helpers.tsx and is imported, not restated.
 *
 * This file used to declare its own structurally-identical `Overrides` type,
 * which is precisely how a new key goes missing in one of two copies — and it
 * did: adding `cueTag` to the shared shape produced four type errors here and
 * nowhere else. `editOverrides` was already typed against the shared one.
 */
const EMPTY: SpeakerOverrides = { global: {}, turn: {}, aliases: {}, colors: {}, turnTag: {}, cueTag: {}, icons: {} };

/** Sibling backup path for a rewrite of a user-supplied transcript:
 *  `/a/b/foo.vtt` → `/a/b/foo.orig.vtt`. */
function backupPathFor(p: string): string {
  const m = p.match(/^(.*)(\.[^./]+)$/);
  return m ? `${m[1]}.orig${m[2]}` : `${p}.orig`;
}

/** VTT content parseSrt skips (NOTE/STYLE/REGION blocks) or ignores (cue
 *  settings after the arrow timestamp) — serializeCues therefore cannot
 *  write it back, so an in-place rewrite drops it. Cheap detection on the
 *  raw text; used only to warn, never to block. */
const VTT_DROPPED_RE = /^\s*(?:NOTE\b|STYLE\b|REGION\b)|-->\s*[\d:.,]+[ \t]+\S/m;

/**
 * Read-only transcript reader for the right-docked panel.
 *
 * Round 31 adds:
 *  - Drop the origin badge (was visual noise).
 *  - Download dropdown: TXT, MD, SRT-original, PDF (via print dialog).
 *  - Click / right-click a speaker chip → inline rename popover that
 *    can rename a single tag everywhere it appears OR a single turn.
 *  - Speaker-name overrides persist per transcript path via localStorage.
 *
 * The speaker overrides architecture is forward-compatible with
 * Feature B (real diarization): today there's one speaker (tag === null,
 * displayed as "Speaker"); tomorrow there will be SPEAKER_00, SPEAKER_01,
 * etc. The rename UI works identically in both worlds.
 */
export function TranscriptViewer({
  path, reloadToken, playheadActive, onSeek, origin,
  onClearTranscript, onLoadFromHistory, onUndo, onRedo,
  onRegenerate, regenerateBusy, canRegenerate, fps = 30, startTimecode, onSetSourceTimecode, onGrabFace,
  onRedetectSpeakers, canRedetect,
  onImportTranscript, sourceKind, onFixCaptionTiming,
  hasSource = false, onTranscriptEdited,
}: Props) {
  const [raw, setRaw] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  /** Non-zero while a follow-scroll we issued is still settling, so onScroll
   *  doesn't mistake it for the user scrolling away and turn follow off. */
  const programmaticScrollRef = useRef(0);
  const programmaticScrollTimer = useRef(0);

  // ── Speaker overrides ───────────────────────────────────────────
  // (Type + layer semantics documented at module scope, above the component.)
  const storageKey = path ? `saucebunny.speakerNames.${path}` : null;
  const [overrides, setOverrides] = useState<SpeakerOverrides>(EMPTY);

  // Load overrides when the path changes.
  useEffect(() => {
    // One loader, shared with every other consumer. This used to be a
    // hand-rolled shape-clamp, and a second copy of it lived thirty lines
    // below — so a new key had to be added in three places and was added in
    // one. `loadSpeakerOverrides` already does the clamping, already handles
    // a corrupt entry, and is what the caption overlay and the AI surfaces
    // read through.
    setOverrides(loadSpeakerOverrides(path));
  }, [storageKey, path]);

  // Re-read when an EXTERNAL writer changes this path's overrides: the
  // App-level fingerprint bridge seeding names from a prior transcript of the
  // same source (r134), or a sibling window's rename. Read-only + compare-
  // guarded, so it never loops on the panel's own writes (which fire this same
  // event) and never trips the persist stale-write guard below.
  useEffect(() => {
    if (!storageKey) return;
    const onExternal = (e: Event) => {
      const p = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (p && p !== path) return;
      let next: SpeakerOverrides = EMPTY;
      try {
        const raw = localStorage.getItem(storageKey);
        if (raw) {
          next = loadSpeakerOverrides(path);
        }
      } catch { return; }
      setOverrides((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    window.addEventListener(SPEAKERS_CHANGED_EVENT, onExternal);
    return () => window.removeEventListener(SPEAKERS_CHANGED_EVENT, onExternal);
  }, [storageKey, path]);

  // The storageKey the persist effect last ran against. CRITICAL: on the render
  // where the key CHANGES (source swap, or the popped-out window mounting and
  // receiving its path), `overrides` still holds the OLD value while the load
  // effect above repopulates it this same commit. Persisting here would write
  // that stale (usually empty) value — and because both app windows share
  // localStorage, that empties out a sibling window's saved speaker names (the
  // "pop out → close → names reset" bug). So we skip the write on the
  // key-change render and only persist real edits made against a loaded key.
  const persistKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!storageKey) { persistKeyRef.current = storageKey; return; }
    if (persistKeyRef.current !== storageKey) { persistKeyRef.current = storageKey; return; }
    const empty = Object.keys(overrides.global).length === 0
               && Object.keys(overrides.turn).length === 0
               && Object.keys(overrides.aliases).length === 0
               && Object.keys(overrides.colors).length === 0
               && Object.keys(overrides.turnTag).length === 0;
    if (empty) {
      localStorage.removeItem(storageKey);
    } else {
      try { localStorage.setItem(storageKey, JSON.stringify(overrides)); } catch { /* quota */ }
    }
    // Tell live consumers (the on-video caption overlay) to re-read, so a
    // rename shows up on the video immediately. Two buses, one name:
    //   - window CustomEvent: synchronous same-window fast path (the native
    //     `storage` event doesn't fire in the tab that wrote it);
    //   - Tauri event: crosses webviews, so a rename made in the popped-out
    //     panel updates main's caption overlay without polling.
    window.dispatchEvent(new CustomEvent(SPEAKERS_CHANGED_EVENT, { detail: { path } }));
    void emit(SPEAKERS_CHANGED_EVENT, { path });
  }, [storageKey, overrides, path]);

  /**
   * Walk the alias chain to find the canonical tag a speaker should
   * be displayed as. Capped at 8 hops as a paranoia limit against
   * cycles (we also reject cycles at write time, but defensive depth
   * is cheap and protects against corrupted localStorage).
   *
   * Takes the alias map as input so it can be reused mid-update
   * inside setOverrides(prev => ...) blocks against an in-progress
   * next.aliases. Pure function — no closure over component state.
   */
  const resolveAlias = useCallback((tag: string | null): string | null => {
    return resolveAliasChain(tag, overrides.aliases);
  }, [overrides.aliases]);

  // ── The undoable seam for every speaker edit ─────────────────────
  //
  // Renaming, merging, recolouring, reassigning a turn and "reset all" were
  // all bare setOverrides calls with no way back. Merge was the worst of them:
  // its own comment called it "fully reversible (delete the alias)", which is
  // true of the DATA MODEL and false of the UI — nothing in the tree ever
  // deleted an alias, and it fired from a bare <select> onChange, so one
  // mis-click silently welded two speakers together for good. "Reset all"
  // discarded every name in one press.
  //
  // Everything now goes through here, which computes the next value, skips a
  // no-op, and records the before/after pair on the app-wide stack the marks
  // and review comments already use. Undo restores a whole snapshot rather
  // than inverting each operation: these maps are small, and a snapshot cannot
  // drift out of sync with the operation the way a hand-written inverse can.
  const overridesRef = useRef(overrides);
  useEffect(() => { overridesRef.current = overrides; }, [overrides]);
  const editOverrides = useCallback(
    (label: string, update: (prev: SpeakerOverrides) => SpeakerOverrides) => {
      // Computed OUTSIDE the state updater on purpose. Pushing an undo entry
      // from inside one would double-push under StrictMode's deliberate
      // double-invoke — the same trap that once made a seek fire twice.
      const prev = overridesRef.current;
      const next = update(prev);
      if (next === prev) return;
      overridesRef.current = next;
      setOverrides(next);
      appUndo.push({
        label,
        undo: () => { overridesRef.current = prev; setOverrides(prev); },
        redo: () => { overridesRef.current = next; setOverrides(next); },
      });
    },
    [],
  );

  // ── Load the file whenever the path changes ──────────────────────
  // `reloadToken` is also a dep: Regenerate / Fix-timing overwrite the SAME
  // .srt path, so a path-only key would keep showing the old transcript after
  // a "Transcript ready" — the user would wait through a whole Whisper run and
  // see nothing change. App bumps the token on every transcript arrival.
  useEffect(() => {
    let cancelled = false;
    if (!path) {
      setRaw(null);
      setLoadErr(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadErr(null);
    (async () => {
      try {
        const text = await invoke<string>("read_text_file_capped", { path, maxBytes: 8 * 1024 * 1024 });
        if (cancelled) return;
        setRaw(text);
      } catch (e) {
        if (cancelled) return;
        setLoadErr(e ? formatError(e) : "Failed to read transcript");
        setRaw(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path, reloadToken]);

  // ── Parse + group whenever the raw text changes ──────────────────
  // retagCues sits between parse and group, which is the entire splitting
  // mechanism: a reassigned run of cues stops matching its neighbours'
  // speaker, so groupIntoTurns starts a new turn at each boundary. There is
  // no turn-splitting code anywhere, and there does not need to be.
  const turns: Turn[] = useMemo(() => {
    if (!raw) return [];
    try { return groupIntoTurns(retagCues(parseSrt(raw), overrides)); } catch { return []; }
  }, [raw, overrides]);

  const flatCues = useMemo(
    () => turns.flatMap((t, ti) => t.cues.map((c, ci) => ({ cue: c, turnIdx: ti, cueIdx: ci }))),
    [turns],
  );

  // ── Active row from playhead ─────────────────────────────────────
  // Click-to-jump seeks to cue.start, but App floors seconds→frames, landing
  // the playhead up to one frame BEFORE the cue begins. Without tolerance the
  // search then reads `playhead < cue.start` and snaps to the PREVIOUS cue —
  // at a turn boundary that's the prior speaker's last line ("click 'Know',
  // highlights 'Let's roll it.'"). Snap a playhead within one frame of a cue's
  // start up to that cue so the clicked chunk is the one selected.
  //
  // Subscribe to the DERIVED INDEX, not to raw seconds. Seconds change on every
  // store notification (rAF-driven for local files, so 30-60/sec), but the only
  // thing this component takes from the playhead is this integer, which changes
  // about once per cue. Subscribing at seconds granularity re-rendered the whole
  // unvirtualized turn/cue tree tens of times a second to produce a value that
  // was identical almost every time. useSyncExternalStore compares the snapshot,
  // so an unchanged index now re-renders nothing at all.
  // Which cue owns the panel's single tab stop.
  //
  // The one at the playhead by default, so Tab lands on the line being heard —
  // the line someone reaching for the keyboard wants to correct. Clicking or
  // focusing another cue moves it there, and it stays until the user moves it
  // again, so Tab-away-and-back returns to where they were working rather than
  // snapping to wherever playback has drifted.
  const [focusedCue, setFocusedCue] = useState<number | null>(null);
  // True while a left-button drag is in flight over the transcript body, so
  // the per-cue hover lift can stand down and let the browser's selection
  // highlight be the feedback. Cleared on the window, not the element: a drag
  // routinely ends outside the cue it started in, and often outside the panel.
  const [selecting, setSelecting] = useState(false);
  useEffect(() => {
    if (!selecting) return;
    const done = () => setSelecting(false);
    window.addEventListener("pointerup", done);
    window.addEventListener("pointercancel", done);
    return () => {
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
    };
  }, [selecting]);
  const activeCueIdx = useSyncExternalStore(
    subscribePlayhead,
    useCallback(() => {
      if (!playheadActive || flatCues.length === 0) return -1;
      const seconds = playheadFramesToSeconds(getPlayheadFrames(), fps);
      const eps = 1 / Math.max(1, Math.round(fps)); // one frame, in seconds
      let lo = 0, hi = flatCues.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const c = flatCues[mid].cue;
        if (seconds < c.start - eps) hi = mid - 1;
        else if (seconds > c.end) lo = mid + 1;
        else return mid;
      }
      return Math.max(-1, hi);
    }, [playheadActive, flatCues, fps]),
  );
  const tabbableCueIdx = focusedCue ?? (activeCueIdx >= 0 ? activeCueIdx : 0);

  useEffect(() => {
    if (!autoScroll || activeCueIdx < 0 || !scrollRef.current) return;
    const scroller = scrollRef.current;
    const el = scroller.querySelector<HTMLElement>(`[data-cue-idx="${activeCueIdx}"]`);
    if (!el) return;
    // Follow-scroll exists for PLAYBACK walking the highlight out of view —
    // never for clicks. A cue that is already visible (you just clicked it,
    // or it advanced within the viewport) must not move the scroll position;
    // recentering on every active-cue change made the panel lurch on every
    // word/speaker click. When the highlight does leave the viewport,
    // "nearest" nudges it back in at the closest edge instead of yanking it
    // to center.
    const sRect = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pad = 8;
    const visible = r.top >= sRect.top + pad && r.bottom <= sRect.bottom - pad;
    if (visible) return;
    // When the highlight leaves the viewport (playback walks it off the bottom,
    // or a seek jumps it above), don't nudge it to the nearest EDGE — that
    // pinned the active line to the very bottom with no upcoming words visible.
    // Place it ~28% down instead, teleprompter-style, so the lines coming next
    // fill the space below and the panel doesn't re-scroll on every cue.
    const target = scroller.scrollTop + (r.top - sRect.top) - scroller.clientHeight * 0.28;
    // Mark this as OUR scroll. It lands in the same element's onScroll, and a
    // big catch-up jump (the panel was hidden, or playback ran on while the
    // highlight was off-screen) looks exactly like a user flick — which would
    // switch follow off, and nothing switches it back on for the rest of the
    // session. Smooth scrolling emits many intermediate events, so the flag is
    // held until the scroll settles rather than cleared after one.
    programmaticScrollRef.current += 1;
    window.clearTimeout(programmaticScrollTimer.current);
    programmaticScrollTimer.current = window.setTimeout(() => {
      programmaticScrollRef.current = 0;
    }, 700);
    scroller.scrollTo({ top: Math.max(0, target), behavior: scrollBehavior() });
  }, [activeCueIdx, autoScroll]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const top = e.currentTarget.scrollTop;
    const delta = Math.abs(top - lastScrollTop.current);
    lastScrollTop.current = top;
    if (programmaticScrollRef.current > 0) return; // our own catch-up scroll
    if (delta > 80) setAutoScroll(false);
  }

  // True when at least one turn carries a real (non-null) speaker tag. When so,
  // a turn the diarizer left UNassigned (null tag) reads "Unknown speaker"
  // instead of a bare "Speaker" that looks like a numbered peer. For a fully
  // un-diarized transcript this is false → plain "Speaker" (and chips are hidden).
  const hasIdentifiedSpeakers = useMemo(
    () => turns.some((t) => resolveAlias(t.speaker) != null),
    [turns, resolveAlias],
  );

  // ── Speaker display name resolution ──────────────────────────────
  // Hoisted above the search block (r43) so `matches` in speaker mode
  // can call it. The full block (rename + merge + roster) still lives
  // further down — only the resolver itself moves up.

  /**
   * The tag a turn should be TREATED as: a turnTag reassignment ("this one
   * turn belongs to that other speaker") wins over the turn's original tag;
   * either way the alias chain resolves it to its canonical form. Both the
   * display name AND the chip colour key off this, so a reassigned turn
   * looks exactly like the target speaker.
   */
  /**
   * One-time migration of the old per-TURN reassignments into per-cue ones.
   *
   * `turnTag` was keyed by turn index, and turn indices are derived — changing
   * one speaker renumbers every turn after it — so the old data was fragile
   * even where it worked, and it could never reach the captions, the AI
   * surfaces or the timeline lanes at all. Cue start times are stable across
   * a re-detect, so this converts each stored turn index to the start times of
   * the cues it currently covers.
   *
   * Runs only once the transcript is parsed, because the turn-to-cue mapping
   * only exists then. Written WITHOUT an undo entry on purpose: this is not
   * something the user did, and offering to undo it would offer to restore a
   * shape nothing reads any more.
   *
   * `turn` (per-turn free-text renames) is deliberately left alone. It sets a
   * display NAME for one turn, which has no cue-level equivalent, so folding
   * it in would change its meaning rather than move it.
   */
  useEffect(() => {
    const stale = Object.keys(overrides.turnTag);
    if (stale.length === 0 || turns.length === 0) return;
    const cueTag = { ...overrides.cueTag };
    for (const key of stale) {
      const turn = turns[Number(key)];
      if (!turn) continue; // the transcript changed under it; drop rather than guess
      const tag = overrides.turnTag[key];
      for (const c of turn.cues) cueTag[cueKey(c.start)] = tag;
    }
    setOverrides((prev) => ({ ...prev, cueTag, turnTag: {} }));
  }, [turns, overrides.turnTag, overrides.cueTag]);

  const effectiveTagFor = useCallback((_turnIdx: number, originalTag: string | null): string | null => {
    // Reassignment now lives on the CUE and is applied by `retagCues` before
    // grouping, so by the time a turn exists its `speaker` is already the
    // effective one. This survives only as the alias-resolution step.
    return resolveAlias(originalTag);
  }, [resolveAlias]);

  const displayNameFor = useCallback((turnIdx: number, originalTag: string | null): string => {
    const turnOverride = overrides.turn[String(turnIdx)];
    if (turnOverride) return turnOverride;
    const resolved = effectiveTagFor(turnIdx, originalTag);
    const tagKey = resolved ?? "__NULL__";
    const globalOverride = overrides.global[tagKey];
    if (globalOverride) return globalOverride;
    // Humanize the model-emitted tag for display. SPEAKER_00 → Speaker 1
    // (1-indexed, since humans don't say "speaker zero"). Custom tags
    // (already-renamed, or non-diarized null) pass through unchanged. A
    // null tag amid real speakers → "Unknown speaker" (the diarizer skipped it).
    return humanizeSpeakerTag(resolved, { unknownWhenNull: hasIdentifiedSpeakers });
  }, [overrides, effectiveTagFor, hasIdentifiedSpeakers]);

  // ── Search ──────────────────────────────────────────────────────
  // Two modes today:
  //   "text"     — substring match against cue body (the default,
  //                same behaviour as r29+).
  //   "speakers" — substring match against the resolved display name
  //                of each turn's speaker. Matches push the FIRST cue
  //                index of the matching turn so the existing
  //                scroll-into-view + onSeek pipeline reuses unchanged.
  //
  // We persist the mode per-session (no localStorage) so it resets to
  // "text" when the app restarts — search is a transient activity and
  // a sticky mode would surprise users who searched for a speaker once
  // and forget to flip back. (SearchMode + the row UI live in
  // ./transcript/SearchBar.tsx; the match state stays here, feeding the
  // karaoke memos below.)
  const [searchMode, setSearchMode] = useState<SearchMode>("text");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    const out: number[] = [];
    if (searchMode === "speakers") {
      // Walk turns; remember the cumulative cue index of each turn's
      // first cue so a match jumps to the same row a click-on-cue would.
      let cueIdx = 0;
      for (let ti = 0; ti < turns.length; ti++) {
        const name = displayNameFor(ti, turns[ti].speaker).toLowerCase();
        if (name.includes(q)) out.push(cueIdx);
        cueIdx += turns[ti].cues.length;
      }
    } else {
      for (let i = 0; i < flatCues.length; i++) {
        if (flatCues[i].cue.text.toLowerCase().includes(q)) out.push(i);
      }
    }
    return out;
  }, [query, flatCues, turns, displayNameFor, searchMode]);
  const [matchCursor, setMatchCursor] = useState(0);
  // Reset cursor whenever the query OR mode changes — otherwise an
  // out-of-range cursor briefly points past the new match set.
  useEffect(() => { setMatchCursor(0); }, [query, searchMode]);

  // ── Karaoke-body precomputes (perf) ──────────────────────────────
  // The turns.map render runs once per ACTIVE-CUE CHANGE (roughly once a cue),
  // not per playhead tick — activeCueIdx is a useSyncExternalStore snapshot, so
  // a tick that lands inside the same cue re-renders nothing. These precomputes
  // exist to keep that boundary render cheap.
  // Hoist the O(turns²) cue-offset scan, the per-turn name/alias resolution,
  // and the search-match lookup out of that hot loop so a tick only re-marks
  // the active cue instead of recomputing all bookkeeping. Keyed so a rename
  // (which changes the displayNameFor / resolveAlias callbacks) still refreshes.
  const cueStartIndices = useMemo(() => {
    const out: number[] = [];
    let sum = 0;
    for (const t of turns) { out.push(sum); sum += t.cues.length; }
    return out;
  }, [turns]);
  const turnMeta = useMemo(
    () => turns.map((t, ti) => ({ displayName: displayNameFor(ti, t.speaker), resolvedTag: effectiveTagFor(ti, t.speaker) })),
    [turns, displayNameFor, effectiveTagFor],
  );
  const matchSet = useMemo(() => new Set(matches), [matches]);

  // Jump = SCROLL the match into view, never seek. Cycling results is a
  // reading activity — moving the playhead on every ↩ would restart audio
  // at each hit (and fight the karaoke autoscroll, hence the pause of
  // follow-mode). Clicking the cue is the explicit "take me there" action.
  const jumpToMatch = useCallback((delta: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (matchCursor + delta + matches.length) % matches.length;
    setMatchCursor(next);
    const cueIdx = matches[next];
    setAutoScroll(false);
    scrollRef.current?.querySelector<HTMLElement>(`[data-cue-idx="${cueIdx}"]`)
      ?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, [matches, matchCursor]);

  // ── ⌘F — focus the transcript search ─────────────────────────────
  // The rebindable-shortcut registry (lib/keybindings.ts) has no notion of
  // tab scope — its per-tab precedent (the Review range hotkeys) registers
  // handlers with App, which only works in the MAIN window and would need
  // new plumbing through QueueDrawer + the panel bus. So this follows the
  // ⌘G listener below instead: a window-scope listener owned by the viewer,
  // gated on the transcript tab actually being VISIBLE — the drawer keeps
  // hidden tabs mounted ([hidden] keep-alive wrappers) and the closed drawer
  // is aria-hidden, so both are checked. Anywhere else ⌘F stays untouched.
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== "f") return;
      const root = wrapRef.current;
      if (!root || root.closest("[hidden]") || root.closest('[aria-hidden="true"]')) return;
      // A modal dialog (Settings, palette, shortcut sheet) traps focus — don't
      // yank it to the search input behind the scrim.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Cmd+G / Cmd+Shift+G — Avid-style "find next / previous" ──────
  // Wired at window scope so the user can cycle through results
  // without focus-tabbing back to the search input. Only active when
  // there's a non-empty query (so an idle Cmd+G doesn't steal Chrome's
  // default find-again in dev tools or feel like a no-op in the wild).
  useEffect(() => {
    if (matches.length === 0) return;
    function onKey(e: KeyboardEvent) {
      // Ignore plain "g" keystrokes inside the rename / search
      // inputs — handled by their own onKeyDown handlers, and we
      // don't want to interfere with normal typing.
      if (!e.metaKey || e.key.toLowerCase() !== "g") return;
      // Same visibility gate as ⌘F above. This component is mounted twice (the
      // reader and the drawer), so without it a ⌘G advanced the HIDDEN
      // instance's cursor and turned its auto-scroll off, which nothing turns
      // back on — the karaoke follow silently stopped working.
      const root = wrapRef.current;
      if (!root || root.closest("[hidden]") || root.closest('[aria-hidden="true"]')) return;
      // Same modal gate as ⌘F above — cycling matches (and its scroll) while a
      // modal dialog is open would act behind the scrim.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      e.preventDefault();
      jumpToMatch(e.shiftKey ? -1 : 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matches, jumpToMatch]);


  // Global rename keyed on the canonical (alias-resolved) tag — the form the
  // roster already exposes as `tag`. Used by the Speakers modal. ("Speaker"
  // sentinel = the untagged group → the "__NULL__" override key.)
  const renameSpeaker = useCallback((canonicalTag: string, name: string) => {
    const trimmed = name.trim();
    const key = canonicalTag === "Speaker" ? "__NULL__" : canonicalTag;
    const resolved = key === "__NULL__" ? null : key;
    editOverrides("rename speaker", (prev) => {
      const next: SpeakerOverrides = {
        global: { ...prev.global }, turn: { ...prev.turn }, aliases: { ...prev.aliases },
        colors: { ...prev.colors }, turnTag: { ...prev.turnTag }, cueTag: { ...prev.cueTag },
        icons: { ...prev.icons },
      };
      if (trimmed && trimmed !== humanizeSpeakerTag(resolved, { unknownWhenNull: hasIdentifiedSpeakers })) {
        next.global[key] = trimmed;
      } else {
        delete next.global[key];
      }
      return next;
    });
  }, [hasIdentifiedSpeakers, editOverrides]);

  // ── Roster: unique speakers (post-alias) + their stats ──────────
  // Used by the roster panel above the transcript body AND drives the
  // drop-target set for the drag-to-merge interaction.
  type RosterEntry = {
    /** Canonical tag — after alias resolution. The untagged group uses the
     *  literal "Speaker" sentinel (can't key a Map on null). */
    tag: string;
    /** Null-preserving resolved tag used ONLY for colour, so the roster pip
     *  matches the turn-bubble + caption hue for the SAME speaker. The bubble
     *  colours from resolveAlias(speaker) (null for untagged); keying colour
     *  off `tag` instead would hash the "Speaker" sentinel to a different hue. */
    colorTag: string | null;
    /** Display name (after rename). */
    name: string;
    /** Number of turns assigned to this canonical tag. */
    turnCount: number;
    /** Indices into `turns`, in chronological order. What the Speakers view
     *  expands to show, so it never has to re-walk the transcript. */
    turnIdxs: number[];
    /** Seconds of speech. The axis a cast is actually ordered by: turn count
     *  says how often someone was interrupted, talk time says who the lead
     *  is. Computed here because the turns are already in hand. */
    talkSeconds: number;
    /** Original tags that resolve to this canonical (incl. itself). */
    sourceTags: string[];
  };
  const roster: RosterEntry[] = useMemo(() => {
    const byCanonical = new Map<string, RosterEntry>();
    // Track first-seen order so the roster stays stable as the user
    // scrolls / renames (rather than re-sorting alphabetically and
    // shuffling chip positions on every interaction).
    let order = 0;
    const orderMap = new Map<string, number>();
    for (let ti = 0; ti < turns.length; ti++) {
      const t = turns[ti];
      const resolved = resolveAlias(t.speaker);
      const canonical = resolved ?? "Speaker";
      let entry = byCanonical.get(canonical);
      if (!entry) {
        entry = {
          tag: canonical,
          colorTag: resolved,
          // Global rename or the humanized default — NOT displayNameFor, which
          // applies per-turn overrides first: a one-off rename on the group's
          // first turn would mislabel the whole roster chip (and the
          // merge-confirm dialog) with that turn's name.
          name: overrides.global[resolved ?? "__NULL__"]
            ?? humanizeSpeakerTag(resolved, { unknownWhenNull: hasIdentifiedSpeakers }),
          turnCount: 0,
          turnIdxs: [],
          talkSeconds: 0,
          sourceTags: [],
        };
        byCanonical.set(canonical, entry);
        orderMap.set(canonical, order++);
      }
      entry.turnCount += 1;
      entry.turnIdxs.push(ti);
      for (const c of t.cues) entry.talkSeconds += Math.max(0, c.end - c.start);
      if (t.speaker && !entry.sourceTags.includes(t.speaker)) {
        entry.sourceTags.push(t.speaker);
      }
    }
    const list = Array.from(byCanonical.values());
    list.sort((a, b) => (orderMap.get(a.tag)! - orderMap.get(b.tag)!));
    return list;
  }, [turns, resolveAlias, overrides.global, hasIdentifiedSpeakers]);
  // The roster header row renders only for real rosters; the follow
  // control falls back to the floating pill without it (3d).
  const rosterVisible = roster.length > 1 || (roster.length === 1 && roster[0].tag !== "Speaker");

  // True when the transcript actually carries speaker identity — either
  // more than one speaker, or a single one that's been labeled (not the
  // generic fallback "Speaker"). When false (un-diarized whisper output,
  // or a caption file with no <v> voice tags) we drop the repeated
  // "Speaker" chip above every bubble and render clean reading prose with
  // just a quiet paragraph timestamp — the chip was pure noise there, and
  // the user called it out as bad UX ("Speaker above the other text").
  const hasRealSpeakers =
    roster.length > 1 || (roster.length === 1 && roster[0].tag !== "Speaker");

  // Speaker colour picker — which speaker (canonical colour key) is being
  // recoloured + the pip rect to anchor the popover. Opened from the modal.
  const [colorPick, setColorPick] = useState<{ key: string; rect: DOMRect } | null>(null);

  // Resolve a speaker's pip colour: a user override (set via the picker) wins,
  // else the auto palette colour. Keyed on the resolved tag (null = untagged) —
  // the same key the caption overlay reads — so a custom colour shows in the
  // transcript bubbles, the Speakers modal, AND on-video captions.
  const speakerDisplayColor = useCallback(
    (colorTag: string | null) => {
      // A user's explicit pick always wins, even on a non-speech group.
      const chosen = overrides.colors[colorTag ?? "__NULL__"];
      if (chosen) return chosen;
      // Music, lyrics, SFX and inaudible take ONE neutral tone rather than a
      // cast hue. The twelve palette colours exist to tell people apart and
      // were searched to stay mutually distinguishable; a music bed eating a
      // slot makes a big cast harder to read for nothing in return.
      const name = overrides.global[colorTag ?? "__NULL__"];
      if (speakerKind(colorTag, name)) return NON_SPEECH_COLOR;
      return speakerColor(colorTag);
    },
    [overrides.colors, overrides.global],
  );

  /**
   * The Speakers view's data, loudest first.
   *
   * Sorted here rather than in the component so the ORDER is a decision this
   * file owns alongside every other roster decision — and so the component
   * stays a renderer. The roster's own order is first appearance, which is
   * deliberately not reused: chronological is what the Text view is for.
   */
  const speakerGroups = useMemo(
    () => roster
      .map((r) => ({
        tag: r.tag,
        name: r.name,
        color: speakerDisplayColor(r.colorTag),
        icon: overrides.icons[r.colorTag ?? "__NULL__"] ?? null,
        talkSeconds: r.talkSeconds,
        turnCount: r.turnCount,
        turnIdxs: r.turnIdxs,
      }))
      .sort((a, b) => b.talkSeconds - a.talkSeconds),
    [roster, speakerDisplayColor, overrides.icons],
  );

  /**
   * Explicit badge icon for a speaker, or null to go back to initials.
   *
   * Keyed on the alias-resolved tag, exactly like colours, so a merged speaker
   * carries one icon rather than one per source tag. Null DELETES the key
   * instead of storing a sentinel, so "back to initials" leaves no trace and
   * the empty-overrides check can still clear the whole record.
   */
  const setSpeakerIcon = useCallback((key: string, kind: string | null) => {
    editOverrides("speaker icon", (p) => {
      const icons = { ...p.icons };
      if (kind) icons[key] = kind; else delete icons[key];
      return { ...p, icons };
    });
  }, [editOverrides]);

  const setSpeakerColor = useCallback((key: string, hex: string) => {
    editOverrides("speaker colour", (p) => ({ ...p, colors: { ...p.colors, [key]: hex } }));
  }, [editOverrides]);
  const resetSpeakerColor = useCallback((key: string) => {
    editOverrides("reset speaker colour", (p) => {
      const colors = { ...p.colors };
      delete colors[key];
      return { ...p, colors };
    });
  }, [editOverrides]);

  // Rename popover state — tracks which turn the user is editing.
  // Anchored to the speaker chip rect so the popover appears next to
  // where the user clicked. Component + type live in
  // ./transcript/RenamePopover.tsx.
  const [rename, setRename] = useState<RenameState | null>(null);
  /** The freshly-split speaker awaiting a name, plus the range it owns (so
   *  picking an existing person instead can re-point those cues). */
  const [naming, setNaming] = useState<{ tag: string; from: number; to: number } | null>(null);
  /** The live cue selection the context menu is acting on. */
  const [cueMenu, setCueMenu] = useState<{ x: number; y: number; from: number; to: number } | null>(null);

  const openRename = useCallback((e: React.MouseEvent, turnIdx: number, originalTag: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setRename({
      turnIdx,
      originalTag,
      currentName: displayNameFor(turnIdx, originalTag),
      rect,
    });
  }, [displayNameFor]);

  function applyRename(newName: string, scope: "all" | "turn") {
    if (!rename) return;
    const trimmed = newName.trim();
    editOverrides(scope === "turn" ? "rename this turn" : "rename speaker", (prev) => {
      const next: SpeakerOverrides = {
        global:  { ...prev.global },
        turn:    { ...prev.turn },
        aliases: { ...prev.aliases },
        colors:  { ...prev.colors },
        turnTag: { ...prev.turnTag },
        cueTag:  { ...prev.cueTag },
        icons:   { ...prev.icons },
      };
      // Key the GLOBAL rename on the alias-RESOLVED tag — displayNameFor reads
      // overrides under the resolved key, and merging deletes globals
      // keyed under merged-away tags. Without resolving, renaming a turn whose
      // original tag was merged into another speaker writes a key nobody reads:
      // the popover closes and nothing changes on screen.
      const resolvedTag = resolveAliasChain(rename.originalTag, prev.aliases);
      const tagKey = resolvedTag ?? "__NULL__";
      if (scope === "all") {
        // Clearing = typing back the DEFAULT display name of the resolved tag
        // (not rename.currentName, which may itself be an existing override).
        if (trimmed && trimmed !== humanizeSpeakerTag(resolvedTag, { unknownWhenNull: hasIdentifiedSpeakers })) {
          next.global[tagKey] = trimmed;
        } else {
          delete next.global[tagKey];
        }
        // A "rename all" clears any per-turn overrides whose RESOLVED
        // tag matches — otherwise an old per-turn rename would silently
        // shadow the new global, surprising the user who renamed
        // everyone. We resolve through the alias chain so a merged-in
        // speaker's per-turn overrides are also caught (you renamed
        // SPEAKER_00 → "Tom"; turns whose original was SPEAKER_01 but
        // were merged into 00 must also drop any per-turn label).
        for (const [ti, _] of Object.entries(next.turn)) {
          const tIdx = parseInt(ti, 10);
          const tagAtTurn = turns[tIdx]?.speaker ?? null;
          const resolved = resolveAliasChain(tagAtTurn, next.aliases);
          if ((resolved ?? "__NULL__") === tagKey) delete next.turn[ti];
        }
      } else {
        // scope === "turn"
        if (trimmed && trimmed !== (rename.originalTag ?? "Speaker")) {
          next.turn[String(rename.turnIdx)] = trimmed;
        } else {
          delete next.turn[String(rename.turnIdx)];
        }
      }
      return next;
    });
    setRename(null);
  }

  // Jump to the FIRST appearance of the speaker being renamed — handy for
  // identifying an "Unknown speaker" before naming it. Resolves through the
  // alias chain (so a merged or untagged speaker is matched by canonical key),
  // seeks + scrolls to that turn's first cue, and closes the popover. Reuses
  // the same seek/scroll idiom as cue-click (unlike search-jump, this one
  // DOES seek — "go to speaker" is an explicit take-me-there action).
  /**
   * Fold several speakers into one, as ONE undo step.
   *
   * De-duplicating a cast is a bulk job — the diarizer splits one person into
   * four as readily as it merges two — and the old per-row "Merge into…"
   * select meant four separate actions and four separate ⌘Zs to take a
   * mistake back. Supersedes the single-pair merge, which was the same code
   * with a list of one.
   */
  const mergeSpeakers = useCallback((sourceTags: string[], targetTag: string) => {
    const sources = sourceTags.filter((t) => t !== targetTag);
    if (sources.length === 0) return;
    editOverrides(sources.length === 1 ? "merge speakers" : `merge ${sources.length} speakers`, (prev) => {
      const aliases = { ...prev.aliases };
      const globals = { ...prev.global };
      const canonicalTarget = resolveAliasChain(targetTag, prev.aliases) ?? targetTag;
      for (const src of sources) {
        // The same cycle guard the single merge had: aliasing a speaker to
        // someone who already resolves back to them would spin the chain.
        if ((resolveAliasChain(src, aliases) ?? src) === canonicalTarget) continue;
        aliases[src] = canonicalTarget;
        // The source's own name would otherwise shadow the target's, since
        // names are keyed by tag and the merged tag still resolves.
        delete globals[src];
      }
      return { ...prev, aliases, global: globals };
    });
  }, [editOverrides]);

  /**
   * Write a cast's names and colours into this transcript, as ONE undo step.
   *
   * A COPY, deliberately: after this the cast is out of the loop entirely.
   * Nothing links the transcript back to it, so a later edit to the cast can
   * never silently change a name in an SRT that has already been delivered.
   * Colours travel with names because a cast whose colours drift between
   * episodes is only half a cast.
   *
   * Written under the CANONICAL tag, so a speaker that has been merged into
   * another gets named once, on the survivor.
   */
  const applyCast = useCallback((
    names: Record<string, string>,
    colors: Record<string, string>,
    castName: string,
  ) => {
    if (Object.keys(names).length === 0) return;
    editOverrides(`apply cast ${castName}`, (prev) => {
      const global = { ...prev.global };
      const nextColors = { ...prev.colors };
      for (const [tag, name] of Object.entries(names)) {
        const key = tag === "Speaker" ? "__NULL__" : (resolveAliasChain(tag, prev.aliases) ?? tag);
        global[key] = name;
        if (colors[tag]) nextColors[key] = colors[tag];
      }
      return { ...prev, global, colors: nextColors };
    });
  }, [editOverrides]);

  /** Jump to a speaker's first turn BY TAG. goToSpeaker reads the open rename
   *  popover; the roster needs the same jump without one. */
  const goToSpeakerTag = useCallback((tag: string) => {
    const key = tag === "Speaker" ? "__NULL__" : tag;
    const turnIdx = turns.findIndex((t) => (resolveAlias(t.speaker) ?? "__NULL__") === key);
    if (turnIdx < 0) return;
    const cueIdx = flatCues.findIndex((f) => f.turnIdx === turnIdx && f.cueIdx === 0);
    if (cueIdx < 0) return;
    setAutoScroll(false);
    onSeek(flatCues[cueIdx].cue.start);
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-cue-idx="${cueIdx}"]`)
      ?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, [turns, flatCues, resolveAlias, onSeek]);

  const goToSpeaker = useCallback(() => {
    if (!rename) return;
    const targetKey = resolveAlias(rename.originalTag) ?? "__NULL__";
    const turnIdx = turns.findIndex(
      (t) => (resolveAlias(t.speaker) ?? "__NULL__") === targetKey,
    );
    setRename(null);
    if (turnIdx < 0) return;
    const cueIdx = flatCues.findIndex((f) => f.turnIdx === turnIdx && f.cueIdx === 0);
    if (cueIdx < 0) return;
    setAutoScroll(false);
    onSeek(flatCues[cueIdx].cue.start);
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-cue-idx="${cueIdx}"]`)
      ?.scrollIntoView({ block: "center", behavior: scrollBehavior() });
  }, [rename, resolveAlias, turns, flatCues, onSeek]);

  /**
   * Reassign ONE turn to another known speaker ("the diarizer got this
   * turn wrong — it's actually Tom"). Stored as a turnTag override, so
   * the turn takes the target's display name AND colour, and follows any
   * later rename/recolour of that speaker. Reassigning back to the turn's
   * own canonical tag just deletes the override (fully reversible). Any
   * per-turn free-text rename is dropped — it would shadow the target name.
   */
  const reassignTurn = useCallback((turnIdx: number, targetTag: string) => {
    editOverrides("reassign turn", (prev) => {
      const next: SpeakerOverrides = {
        global:  { ...prev.global },
        turn:    { ...prev.turn },
        aliases: { ...prev.aliases },
        colors:  { ...prev.colors },
        turnTag: { ...prev.turnTag },
        cueTag:  { ...prev.cueTag },
        icons:   { ...prev.icons },
      };
      // Writes CUE tags, not a turn tag. Reassigning a whole turn is just the
      // special case of reassigning all of its cues — which means it reaches
      // the captions, the AI surfaces and the timeline lanes like any other
      // reassignment, and it cannot be invalidated by the turn renumbering
      // that a later speaker change causes.
      const turn = turns[turnIdx];
      if (!turn) return prev;
      const original = resolveAliasChain(turn.speaker ?? null, prev.aliases) ?? "Speaker";
      for (const c of turn.cues) {
        const k = cueKey(c.start);
        // Assigning a cue back to the speaker it already had removes the
        // override rather than storing a no-op, so "put it back" leaves no
        // trace and the empty-overrides check can still clear the key.
        if (targetTag === original) delete next.cueTag[k];
        else next.cueTag[k] = targetTag === "Speaker" ? "" : targetTag;
      }
      delete next.turn[String(turnIdx)];
      return next;
    });
    setRename(null);
  }, [turns, editOverrides]);

  /**
   * Assign a run of cues to a speaker. `""` clears them back to untagged.
   *
   * This is the whole split action. It writes cue tags and nothing else — the
   * turn structure re-derives from them, so a range picked out of the middle
   * of a turn becomes its own turn with no splitting code involved.
   *
   * Routed through editOverrides, so a split is one ⌘Z like every other
   * speaker edit, and so the undo button names it.
   */
  const assignCueRange = useCallback((from: number, to: number, tag: string) => {
    const picked = flatCues.slice(from, to + 1);
    if (picked.length === 0) return;
    const label = tag === "" ? "clear speaker" : "reassign dialogue";
    editOverrides(label, (prev) => {
      const cueTag = { ...prev.cueTag };
      for (const { cue } of picked) {
        const original = cue.speaker ?? "";
        const k = cueKey(cue.start);
        // Assigning a cue back to what it already was removes the override
        // rather than storing a no-op, so "put it back" leaves no trace and
        // the empty-overrides check can still clear the whole key.
        if (tag === original) delete cueTag[k];
        else cueTag[k] = tag;
      }
      return { ...prev, cueTag };
    });
  }, [flatCues, editOverrides]);

  /**
   * Put a selection into one of the built-in non-speech groups.
   *
   * ONE edit, so it is ONE undo step: the cue reassignment and the group's
   * name land together. Doing them as two calls would make the first use of
   * "Music" cost two presses of cmd+Z and every later use cost one, which is
   * the kind of inconsistency that stops people trusting undo.
   *
   * All music in a transcript folds into the SAME group rather than minting a
   * new tag each time. That is the point of a built-in: twelve separate
   * one-cue "Music" speakers would be worse than no feature.
   */
  const assignCueRangeToKind = useCallback((from: number, to: number, kind: Exclude<SpeechKind, "speech">) => {
    const picked = flatCues.slice(from, to + 1);
    if (picked.length === 0) return;
    const tag = kindTag(kind);
    editOverrides(`tag as ${KIND_LABEL[kind].toLowerCase()}`, (prev) => {
      const cueTag = { ...prev.cueTag };
      for (const { cue } of picked) cueTag[cueKey(cue.start)] = tag;
      return {
        ...prev,
        cueTag,
        // Name it so the bubble reads "Music" rather than a raw tag. Never
        // overwrite a name the user has already given the group.
        global: prev.global[tag] ? prev.global : { ...prev.global, [tag]: KIND_LABEL[kind] },
      };
    });
  }, [flatCues, editOverrides]);

  /** Pull a selection out into a brand-new speaker, then offer to name it. */
  const splitToNewSpeaker = useCallback((from: number, to: number) => {
    const taken = new Set<string>();
    for (const { cue } of flatCues) if (cue.speaker) taken.add(cue.speaker);
    for (const t of Object.values(overrides.cueTag)) if (t) taken.add(t);
    const tag = newSpeakerTag(taken);
    assignCueRange(from, to, tag);
    // The naming sheet follows immediately, because splitting and naming are
    // one intention: nobody lassoes dialogue in order to create "CAST_A".
    setNaming({ tag, from, to });
  }, [flatCues, overrides.cueTag, assignCueRange]);

  function resetAllRenames() {
    editOverrides("reset all speaker names", () => ({ ...EMPTY }));
    setRename(null);
  }

  // ── Inline cue editing ───────────────────────────────────────────
  // Double-click a cue → swap the span for a textarea (CueEditor). Commit
  // re-serializes ALL cues back to SRT/VTT and rewrites the transcript file
  // IN PLACE — the file on disk is the single source of truth every reader
  // (this viewer, the on-video captions, AI summary, exports, speaker lanes)
  // re-parses, so an edit flows everywhere with no second store. After the
  // write, `onTranscriptEdited` bumps App's arrived tick so those readers
  // re-read. The `editingCue` check in the render loop is O(1) per cue, so
  // the karaoke-tick perf memos are untouched.
  const [editingCue, setEditingCue] = useState<number | null>(null);
  const [editErr, setEditErr] = useState<string | null>(null);
  // Info strip for non-fatal edit notices (backup created / VTT flattening).
  const [editNotice, setEditNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!editErr) return;
    const t = window.setTimeout(() => setEditErr(null), 8000);
    return () => window.clearTimeout(t);
  }, [editErr]);
  useEffect(() => {
    if (!editNotice) return;
    const t = window.setTimeout(() => setEditNotice(null), 10000);
    return () => window.clearTimeout(t);
  }, [editNotice]);
  // Editing a stale index after a reload would splice the wrong cue.
  useEffect(() => { setEditingCue(null); }, [turns]);
  // Per-session guards so the backup attempt / flatten warning run once per file.
  const backupHandledRef = useRef<Set<string>>(new Set());
  const flattenWarnedRef = useRef<Set<string>>(new Set());

  const commitCueEdit = useCallback(async (cueIdx: number, newText: string) => {
    setEditingCue(null);
    const target = flatCues[cueIdx]?.cue;
    const trimmed = newText.replace(/\s+/g, " ").trim();
    // Empty = "delete"? No — cancel. Removing a cue shifts every index after
    // it and silently loses timing; that's a bigger feature than a keystroke.
    if (!path || !target || !trimmed || trimmed === target.text) return;
    const nextCues = flatCues.map((f, i) => (i === cueIdx ? { ...f.cue, text: trimmed } : f.cue));
    const format = path.toLowerCase().endsWith(".vtt") ? "vtt" as const : "srt" as const;
    const serialized = serializeCues(nextCues, format);
    try {
      const notices: string[] = [];
      // Data safety: the rewrite normalizes the WHOLE file (serializeCues
      // output), not just the edited cue. Files the app's own pipeline wrote
      // (Whisper output / downloaded captions in the Transcripts library —
      // origin "whisper" / "captions") are ours to rewrite. An IMPORTED
      // .srt/.vtt (origin "unknown": Import transcript / drag-drop / a history
      // entry recorded from an import) may be the user's only copy — save a
      // one-time sibling backup before the first in-place rewrite.
      const appOwned = origin === "whisper" || origin === "captions";
      if (!appOwned && raw != null && !backupHandledRef.current.has(path)) {
        const backupPath = backupPathFor(path);
        try {
          await invoke("write_text_to_path", {
            path: backupPath,
            text: raw,
            ifNotExists: true,
          });
          notices.push(`Original saved as ${backupPath.split("/").pop()}`);
        } catch (e) {
          // "Already exists" = backed up on an earlier run — fine. Any other
          // failure: bail WITHOUT rewriting (don't touch the only copy).
          if (!formatError(e).includes("already exists")) throw e;
        }
        backupHandledRef.current.add(path);
      }
      // parseSrt doesn't model VTT NOTE/STYLE/REGION blocks or cue settings,
      // so the rewrite silently drops them — say so once instead.
      if (format === "vtt" && !flattenWarnedRef.current.has(path) && VTT_DROPPED_RE.test(raw ?? "")) {
        flattenWarnedRef.current.add(path);
        notices.push("Saving rewrites this file in a normalized form. VTT NOTE/STYLE blocks and cue settings are not kept.");
      }
      // String arg, not a byte array: the encode → Array.from route decimal-
      // prints every byte and rebuilds the WHOLE transcript per committed cue
      // edit at ~3x the size, synchronously on the main thread.
      await invoke("write_text_to_path", { path, text: serialized, atomic: true });
      // Local fast path — reparse immediately instead of waiting for the
      // reload-token round trip (which follows anyway and reads the same bytes).
      setRaw(serialized);
      if (notices.length > 0) setEditNotice(notices.join(" · "));
      onTranscriptEdited?.();
    } catch (e) {
      setEditErr(formatError(e));
    }
  }, [flatCues, path, raw, origin, onTranscriptEdited]);

  // ── Download menu state ──────────────────────────────────────────
  const [dlOpen, setDlOpen] = useState(false);
  // Write-failure message for downloadAs (the menu is already closed when the
  // write fails, so the error renders next to the Download button). Auto-clears.
  const [dlError, setDlError] = useState<string | null>(null);
  // Source start-timecode setter popover (feeds the Avid export's burn-in offset).
  const [tcOpen, setTcOpen] = useState(false);
  const [tcInput, setTcInput] = useState("");
  const [tcErr, setTcErr] = useState<string | null>(null);
  useEffect(() => {
    if (!dlError) return;
    const t = window.setTimeout(() => setDlError(null), 8000);
    return () => window.clearTimeout(t);
  }, [dlError]);
  const dlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dlOpen) return;
    function onDoc(e: MouseEvent) {
      if (!dlRef.current?.contains(e.target as Node)) setDlOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [dlOpen]);

  // ── Tools menu state ─────────────────────────────────────────────
  // Groups the secondary toolbar actions (re-detect speakers, history) so the
  // primary actions stay visible and the bar scales as features are added.
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    function onDoc(e: MouseEvent) {
      if (!toolsRef.current?.contains(e.target as Node)) setToolsOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [toolsOpen]);
  // The TC popover lives inside .cp-tx-tools (toolsRef); close it on an outside click.
  useEffect(() => {
    if (!tcOpen) return;
    function onDoc(e: MouseEvent) {
      if (!toolsRef.current?.contains(e.target as Node)) setTcOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [tcOpen]);

  // ── Speaker insights popover state ───────────────────────────────
  // Anchored to the Insights header button (the DOMRect doubles as the
  // open flag, same pattern as the colour picker). The stats derive
  // straight from the loaded cues — recomputed only when turns change.
  const [insightsAnchor, setInsightsAnchor] = useState<DOMRect | null>(null);
  const insightStats = useMemo(
    () => speakerStats(turns.flatMap((t) => t.cues)),
    [turns],
  );

  // ── History popover state ────────────────────────────────────────
  // Anchored to the History button. Closes on outside-click or Esc.
  // Re-reads localStorage on each open so the list reflects entries
  // recorded by other components / other open windows.
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const [speakerModalOpen, setSpeakerModalOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<TranscriptHistoryEntry[]>([]);

  // Dismissal state for the "No speakers" diagnostic, persisted per-
  // SRT path so the user doesn't have to swat it on every re-open of
  // the same transcript. Cleared automatically when the user clicks
  // Regenerate (a fresh run might add speakers, so the notice should
  // get another shot at evaluating).
  const noticeStorageKey = path ? `saucebunny.noticeDismissed.${path}` : null;
  const [noticeDismissed, setNoticeDismissedState] = useState(false);
  useEffect(() => {
    if (!noticeStorageKey) { setNoticeDismissedState(false); return; }
    setNoticeDismissedState(localStorage.getItem(noticeStorageKey) === "1");
  }, [noticeStorageKey]);
  const setNoticeDismissed = useCallback((v: boolean) => {
    setNoticeDismissedState(v);
    if (!noticeStorageKey) return;
    try {
      if (v) localStorage.setItem(noticeStorageKey, "1");
      else   localStorage.removeItem(noticeStorageKey);
    } catch { /* quota */ }
  }, [noticeStorageKey]);
  // r84: separate dismissal for the "fix caption timing" banner, per SRT path,
  // so it doesn't fight the speaker-labels notice above.
  const timingFixKey = path ? `saucebunny.timingFixDismissed.${path}` : null;
  const [timingFixDismissed, setTimingFixDismissedState] = useState(false);
  useEffect(() => {
    if (!timingFixKey) { setTimingFixDismissedState(false); return; }
    setTimingFixDismissedState(localStorage.getItem(timingFixKey) === "1");
  }, [timingFixKey]);
  const setTimingFixDismissed = useCallback((v: boolean) => {
    setTimingFixDismissedState(v);
    if (!timingFixKey) return;
    try {
      if (v) localStorage.setItem(timingFixKey, "1");
      else   localStorage.removeItem(timingFixKey);
    } catch { /* quota */ }
  }, [timingFixKey]);
  useEffect(() => {
    if (!historyOpen) return;
    setHistoryEntries(getHistory());
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setHistoryOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  // ── Builders for each export format ──────────────────────────────
  const baseFilename = useMemo(() => {
    if (!path) return "transcript";
    const name = path.split("/").pop() ?? "transcript";
    return name.replace(/\.[^.]+$/, ""); // strip extension
  }, [path]);

  const buildPlainText = useCallback((): string => {
    return turns.map((turn, ti) => {
      const name = displayNameFor(ti, turn.speaker);
      const time = fmtTime(turn.start);
      const body = turn.cues.map((c) => c.text).join(" ");
      return `[${time}] ${name}\n${body}`;
    }).join("\n\n");
  }, [turns, displayNameFor]);

  const buildMarkdown = useCallback((): string => {
    const header = `# Transcript — ${baseFilename}\n\n`;
    const body = turns.map((turn, ti) => {
      const name = displayNameFor(ti, turn.speaker);
      const time = fmtTime(turn.start);
      const text = turn.cues.map((c) => c.text).join(" ");
      return `### ${name}  \n*${time}*\n\n${text}`;
    }).join("\n\n");
    return header + body;
  }, [turns, displayNameFor, baseFilename]);

  async function downloadAs(format: "txt" | "md" | "srt-copy") {
    setDlOpen(false);
    try {
      const isOriginalSrt = format === "srt-copy";
      const ext = isOriginalSrt ? "srt" : format;
      const defaultName = `${baseFilename}.${ext}`;
      const dest = await saveDialog({
        defaultPath: defaultName,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!dest) return;
      let content: string;
      if (format === "txt") content = buildPlainText();
      else if (format === "md") content = buildMarkdown();
      else {
        // srt-copy: just read the original file and write it under the
        // chosen name. We don't re-render the SRT from cues because the
        // user might want the exact yt-dlp output (preserving cue numbers,
        // exact timestamps from the source). Speaker renames don't affect
        // the SRT spec anyway — there's nowhere to put them.
        content = raw ?? "";
      }
      await invoke("write_text_to_path", { path: dest, text: content });
      setDlError(null);
    } catch (e) {
      console.error("transcript download failed:", e);
      // Surface it — read-only folder / disk-full failures were silent: the
      // menu closed and the user believed the file saved.
      setDlError(formatError(e));
    }
  }

  // Validate + persist the source start timecode (the last gate; setSourceTimecode
  // re-checks too). HH:MM:SS:FF, or ; before the frames for drop-frame.
  function saveTc() {
    const v = tcInput.trim();
    if (!isValidSourceTc(v)) { setTcErr("Use HH:MM:SS:FF (e.g. 01:00:00:00); minutes/seconds/frames under 60."); return; }
    onSetSourceTimecode?.(v);
    setTcOpen(false);
  }

  // ── Avid Media Composer markers (.txt) ───────────────────────────
  // One point marker per cue: the turn's resolved (renamed) speaker → the Avid
  // Username column, cue text → Comment, cue start → absolute sequence TC
  // (offset by the source's Start-TC so markers land on the burn-in origin).
  // Frame rate is taken from the source fps. Tools ▸ Marker ▸ Import Markers.
  async function downloadAvidMarkers() {
    setDlOpen(false);
    try {
      const cues = turns.flatMap((turn, ti) => {
        const speaker = displayNameFor(ti, turn.speaker);
        return turn.cues.map((c) => ({ start: c.start, speaker, text: c.text }));
      });
      if (cues.length === 0) { setDlError("No transcript cues to export."); return; }
      const dest = await saveDialog({
        defaultPath: `${baseFilename}.avid-markers.txt`,
        filters: [{ name: "TXT", extensions: ["txt"] }],
      });
      if (!dest) return;
      const content = transcriptToAvidTxt(cues, {
        frameRate: fpsToRateKey(fps) ?? DEFAULT_MARKER_SETTINGS.frameRate,
        sequenceStartTc: startTimecode || "00:00:00:00",
        dropFrame: false,
      });
      await invoke("write_text_to_path", { path: dest, text: content });
      setDlError(null);
    } catch (e) {
      console.error("avid marker export failed:", e);
      setDlError(formatError(e));
    }
  }

  // ── PDF via the browser print dialog ─────────────────────────────
  // We build a self-contained printable HTML document, write it into a
  // hidden iframe, and trigger print on the iframe's window. That gives
  // the user the macOS "Save as PDF" sheet without us shipping a PDF
  // library. The doc is intentionally minimal (no scripts, light styles)
  // so the print output looks like a clean transcript document, not a
  // screenshot of the app.
  function downloadAsPdf() {
    setDlOpen(false);
    const turnsHtml = turns.map((turn, ti) => {
      const name = escapeHtml(displayNameFor(ti, turn.speaker));
      const time = fmtTime(turn.start);
      const body = escapeHtml(turn.cues.map((c) => c.text).join(" "));
      return `
        <div class="turn">
          <div class="head"><span class="name">${name}</span><span class="time">${time}</span></div>
          <div class="body">${body}</div>
        </div>`;
    }).join("\n");
    const doc = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(baseFilename)}</title>
<style>
  @page { margin: 0.75in; }
  body { font: 11pt/1.5 Georgia, 'Iowan Old Style', serif; color: #111; }
  h1 { font: 600 18pt/1.2 -apple-system, sans-serif; margin: 0 0 18pt; }
  .meta { font: 9pt -apple-system, sans-serif; color: #666; margin-bottom: 24pt; }
  .turn { margin-bottom: 14pt; page-break-inside: avoid; }
  .head { display: flex; justify-content: space-between; font: 600 10pt -apple-system, sans-serif; color: #444; margin-bottom: 4pt; }
  .time { color: #999; font-variant-numeric: tabular-nums; }
  .body { padding-left: 0; }
</style></head>
<body>
  <h1>${escapeHtml(baseFilename)}</h1>
  <div class="meta">${turns.length} turn${turns.length === 1 ? "" : "s"} · Generated by Sauce Bunny</div>
  ${turnsHtml}
</body></html>`;
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);
    const w = iframe.contentWindow;
    const d = iframe.contentDocument;
    if (!w || !d) { document.body.removeChild(iframe); return; }
    d.open(); d.write(doc); d.close();
    // Slight delay so layout settles before invoking print — without
    // it some WebKit builds open the print sheet on a blank page.
    setTimeout(() => {
      try {
        w.focus();
        w.print();
      } finally {
        // Detach after print dialog closes. Use a generous timeout
        // because WKWebView doesn't fire afterprint reliably.
        setTimeout(() => { try { document.body.removeChild(iframe); } catch { /* gone */ } }, 60000);
      }
    }, 120);
  }

  async function onCopyAll() {
    try { await navigator.clipboard.writeText(buildPlainText()); } catch { /* ignore */ }
  }

  function onReveal() {
    if (!path) return;
    invoke("reveal_in_finder", { path }).catch(() => { /* ignore */ });
  }

  // ── Render branches ──────────────────────────────────────────────

  if (!path) {
    // Empty state — the primary action generates a transcript right here:
    // same handler as the sidebar's Generate button (App passes
    // handleGenerateTranscript to both), so model/speaker settings and the
    // missing-model bounce-to-Settings behave identically. Gated on a loaded
    // SOURCE (not on canRegenerate, which also wants a downloaded model —
    // the handler explains a missing model better than a dead button would).
    return (
      <div className="cp-pane-empty cp-tx-empty">
        <IconTranscript size={28} className="cp-tx-empty-icon" />
        <div className="cp-tx-empty-title">No transcript yet</div>
        <div className="cp-tx-empty-body">
          Transcribe the loaded source, or import an
          <code> .srt</code> / <code>.vtt</code> from disk.
        </div>
        <div className="cp-tx-empty-actions">
          <button
            className="btn btn-primary"
            onClick={onRegenerate}
            disabled={!hasSource || regenerateBusy}
            title={
              !hasSource
                ? "Load a video or audio source first"
                : "Transcribe the loaded source with current Settings (model · speaker detection)"
            }
          >
            {regenerateBusy ? "Generating…" : "Generate transcript"}
          </button>
          <button className="btn btn-ghost" onClick={onImportTranscript}>
            Import transcript…
          </button>
        </div>
        {!hasSource && (
          <div className="cp-tx-empty-hint">
            Load a source first. Paste a URL or import a file.
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return <div className="cp-pane-empty cp-tx-empty"><div className="cp-tx-empty-title">Loading transcript…</div></div>;
  }

  if (loadErr) {
    return (
      <div className="cp-pane-empty cp-tx-empty">
        <IconAlert size={20} stroke="var(--color-warn, #f5a)" />
        <div className="cp-tx-empty-title">Couldn't read transcript</div>
        <div className="cp-tx-empty-body">{loadErr}</div>
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="cp-pane-empty cp-tx-empty">
        <div className="cp-tx-empty-title">Transcript is empty</div>
        <div className="cp-tx-empty-body">
          The SRT file at this path parsed to zero cues. Try regenerating, or
          open the file to inspect it directly.
        </div>
        <div className="cp-tx-empty-actions">
          <button className="btn btn-ghost" onClick={onReveal}>
            <IconReveal size={12} /> Reveal in Finder
          </button>
        </div>
      </div>
    );
  }

  // filename no longer rendered in the header (user feedback: it was
  // visual noise). Still used by `baseFilename` for downloads; that
  // derivation already runs in a useMemo elsewhere.
  const hasAnyOverride =
    Object.keys(overrides.global).length > 0 ||
    Object.keys(overrides.turn).length > 0 ||
    Object.keys(overrides.turnTag).length > 0;

  return (
    <div className="cp-tx-wrap" ref={wrapRef}>
      {/* Header — Clear · History · Download. Per user feedback the
          filename was visual noise (it's already implied by which
          source you have loaded); the header is now actions-only. The
          filename is preserved on the History row where it adds
          context (telling apart prior transcripts). */}
      <div className="cp-tx-head">
        <div className="cp-tx-head-actions cp-tx-head-left">
          {/* Undo/redo lives in the transcript toolbar because this is where
              the app's fiddliest edits happen — renaming a speaker across a
              two-hour interview, merging two the diarizer split, reassigning a
              single turn — and where "Reset all names" sits a click away. The
              stack itself is app-wide and has existed since marks and review
              comments; it was simply invisible unless you already knew ⌘Z
              worked here. */}
          <UndoRedoButtons onUndo={onUndo} onRedo={onRedo} compact />
          <button
            className="btn btn-ghost cp-tx-iconbtn"
            onClick={onClearTranscript}
            title="Dismiss this transcript (the SRT file stays on disk)"
          >
            <span aria-hidden className="cp-tx-glyph-x">×</span>
            <span>Clear</span>
          </button>
          {canRegenerate && (
            <button
              className="btn btn-ghost cp-tx-iconbtn"
              onClick={onRegenerate}
              disabled={regenerateBusy}
              title="Re-run transcription against the loaded source with current Settings (model · speaker detection · expected speakers)"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-3.5-7.1" />
                <polyline points="21 4 21 10 15 10" />
              </svg>
              <span>{regenerateBusy ? "Regenerating…" : "Regenerate"}</span>
            </button>
          )}
          {/* Secondary actions live in a Tools menu so the bar stays compact
              and scales as features are added. The menu is anchored via
              historyBtnRef so the History popover opens beneath it. */}
          <div className="cp-tx-tools" ref={toolsRef}>
            <button
              className={"btn btn-ghost cp-tx-iconbtn" + (toolsOpen || historyOpen ? " active" : "")}
              onClick={() => setToolsOpen((p) => !p)}
              title="More transcript tools"
              ref={historyBtnRef}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /><circle cx="5" cy="12" r="1.5" />
              </svg>
              <span>Tools</span>
              <IconChevronDown size={10} />
            </button>
            {toolsOpen && (
              <div className="cp-tx-dl-menu" role="menu">
                {canRedetect && onRedetectSpeakers && (
                  <button
                    role="menuitem"
                    disabled={regenerateBusy}
                    onClick={() => { setToolsOpen(false); onRedetectSpeakers(); }}
                  >
                    {regenerateBusy ? "Detecting speakers…" : "Re-detect speakers"}
                  </button>
                )}
                <button role="menuitem" onClick={() => { setToolsOpen(false); setHistoryOpen(true); }}>
                  Transcript history…
                </button>
                {onSetSourceTimecode && (
                  <button
                    role="menuitem"
                    onClick={() => { setToolsOpen(false); setTcInput(startTimecode ?? ""); setTcErr(null); setTcOpen(true); }}
                  >
                    Set source start timecode…
                  </button>
                )}
              </div>
            )}
            {tcOpen && onSetSourceTimecode && (
              <div className="cp-tx-tc-pop" role="dialog" aria-label="Source start timecode">
                <div className="cp-tx-tc-title">Source start timecode</div>
                <input
                  className="cp-tx-tc-input"
                  value={tcInput}
                  onChange={(e) => { setTcInput(e.target.value); setTcErr(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveTc();
                    else if (e.key === "Escape") setTcOpen(false);
                  }}
                  placeholder="00:00:00:00"
                  spellCheck={false}
                  autoFocus
                />
                <p className="cp-tx-tc-hint">
                  Offsets every Avid marker so they land on your burn-in. HH:MM:SS:FF (use ; for drop-frame).
                </p>
                {tcErr && <p className="cp-tx-tc-err" role="alert">{tcErr}</p>}
                <div className="cp-tx-tc-row">
                  <button className="btn btn-ghost cp-tx-iconbtn" onClick={() => setTcOpen(false)}>Cancel</button>
                  <button
                    className="btn btn-ghost cp-tx-iconbtn"
                    onClick={() => { onSetSourceTimecode(null); setTcOpen(false); }}
                  >
                    Clear
                  </button>
                  <button className="btn cp-tx-iconbtn" onClick={saveTc}>Save</button>
                </div>
              </div>
            )}
          </div>
          <button
            className={"btn btn-ghost cp-tx-iconbtn" + (insightsAnchor ? " active" : "")}
            title="Speaker insights"
            /* Swallow the mousedown so the open popover's outside-click
               handler doesn't close it before this click re-opens it —
               keeps the button a true toggle. */
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setInsightsAnchor((prev) => (prev ? null : rect));
            }}
          >
            <IconInfo size={13} />
            <span>Insights</span>
          </button>
        </div>
        <div className="cp-tx-head-actions" ref={dlRef}>
          <button
            className="btn btn-ghost cp-tx-iconbtn"
            onClick={() => setDlOpen((p) => !p)}
            title="Download or print the transcript"
          >
            Download <IconChevronDown size={10} />
          </button>
          {dlOpen && (
            <div className="cp-tx-dl-menu" role="menu">
              <button role="menuitem" onClick={onCopyAll}>Copy to clipboard</button>
              <div className="cp-tx-dl-sep" />
              <button role="menuitem" onClick={() => downloadAs("txt")}>Download .txt</button>
              <button role="menuitem" onClick={() => downloadAs("md")}>Download .md</button>
              <button role="menuitem" onClick={() => downloadAs("srt-copy")}>Download .srt</button>
              <button role="menuitem" onClick={downloadAsPdf}>Print / Save as PDF…</button>
              <div className="cp-tx-dl-sep" />
              <button role="menuitem" onClick={downloadAvidMarkers}>Avid markers (.txt)…</button>
              <div className="cp-tx-dl-sep" />
              <button role="menuitem" onClick={onReveal}>Reveal original in Finder</button>
            </div>
          )}
          {dlError && (
            <div className="cp-tx-dl-error" role="alert" title={dlError}>
              Save failed: {dlError}
            </div>
          )}
        </div>
      </div>

      <TranscriptSearchBar
        ref={searchInputRef}
        mode={searchMode}
        onModeChange={setSearchMode}
        query={query}
        onQueryChange={setQuery}
        matchCount={matches.length}
        matchCursor={matchCursor}
        onJump={jumpToMatch}
        onResetNames={hasAnyOverride ? resetAllRenames : undefined}
      />
      {editErr && (
        <div className="cp-tx-edit-error" role="alert" title={editErr}>
          Edit not saved: {editErr}
        </div>
      )}
      {editNotice && (
        <div className="cp-tx-hint" role="status" title={editNotice}>
          <svg className="cp-tx-hint-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
          <span className="cp-tx-hint-text">{editNotice}</span>
          <button
            className="cp-tx-hint-close"
            onClick={() => setEditNotice(null)}
            title="Dismiss"
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {/* Roster — only when there's something worth roster-ing (more
          than one speaker, or any speaker actually labeled). Drives
          the drag-to-merge interaction: drag one chip onto another to
          tell the system "these are the same person." */}
      {/* Diagnostic — surfaced when the loaded transcript carries no
          diarization data (every cue's speaker is null → roster has a
          single "Speaker" bucket). Catches the common confusion case:
          "I set Detect speakers + 3 expected, but I'm seeing one
          generic Speaker." The likely causes are (a) auto-loaded SRT
          predates the diarizer wiring, (b) the regenerate didn't have
          Detect speakers toggled on, or (c) the diarizer failed
          silently and we kept the un-diarized whisper output. All three
          are fixed by tweaking Sidebar settings then clicking the
          Regenerate button in the header. */}
      {/* Slim, muted, one-line hint (r65) — was a full-width yellow
          paragraph shown right out the gate, which read as a warning. Now
          it's a quiet info strip with an inline Regenerate and a dismiss. */}
      {/* r84: loose YouTube ASR caption timing → offer an exact Whisper re-time.
          Same quiet cp-tx-hint pattern; self-dismisses once origin flips to
          "whisper" (handleFixCaptionTiming swaps it). Web sources only. */}
      {turns.length > 0 && origin === "captions" && sourceKind === "youtube" && canRegenerate && !!onFixCaptionTiming && !timingFixDismissed && (
        <div
          className="cp-tx-hint"
          title="Re-transcribes the cached audio locally for exact timing; a few minutes for long clips. Your current captions stay until it finishes."
        >
          <svg className="cp-tx-hint-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
          <span className="cp-tx-hint-text">
            Captions are auto-timed by YouTube and can run late.
          </span>
          <button
            className="cp-tx-hint-action"
            onClick={onFixCaptionTiming}
            disabled={regenerateBusy}
            title="Re-time captions to the audio with your transcription engine (local, exact)"
          >
            {regenerateBusy ? "Re-timing…" : "Fix timing"}
          </button>
          <button
            className="cp-tx-hint-close"
            onClick={() => setTimingFixDismissed(true)}
            title="Dismiss (won't show again for this transcript)"
            aria-label="Dismiss"
          >×</button>
        </div>
      )}
      {turns.length > 0 && roster.length === 1 && roster[0].tag === "Speaker" && canRegenerate && !noticeDismissed && (
        <div
          className="cp-tx-hint"
          title="Caption speaker labels are used automatically when the source carries them; this one's captions didn't. Detect speakers runs diarization to add them."
        >
          <svg className="cp-tx-hint-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
          <span className="cp-tx-hint-text">
            No speaker labels. Turn on <em>Detect speakers</em> to add them.
          </span>
          <button
            className="cp-tx-hint-action"
            onClick={onRegenerate}
            disabled={regenerateBusy}
            title="Re-run transcription with current Settings (model · speaker detection)"
          >
            {regenerateBusy ? "Regenerating…" : "Regenerate"}
          </button>
          <button
            className="cp-tx-hint-close"
            onClick={() => setNoticeDismissed(true)}
            title="Dismiss (won't show again for this transcript)"
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {rosterVisible && (
        <div className="cp-tx-roster" role="toolbar" aria-label="Speakers in this transcript">
          <div className="cp-tx-roster-label">
            {roster.length} speaker{roster.length === 1 ? "" : "s"}
            <button
              type="button"
              className="cp-tx-roster-manage"
              onClick={() => setSpeakerModalOpen(true)}
              title="See all speakers · rename · recolour · merge"
            >
              Manage speakers
            </button>
            {/* Follow playback lives beside Manage speakers (3d): same
                control group, grey-active grammar. Appears only while
                auto-scroll is disengaged, exactly like the old pill. */}
            {!autoScroll && (
              <button
                type="button"
                className="cp-tx-roster-manage cp-tx-follow-btn"
                onClick={() => setAutoScroll(true)}
                title="Resume auto-scroll to follow playback"
              >
                Follow playback
              </button>
            )}
          </div>
        </div>
      )}

      {/* Body — one chat-bubble block per turn */}
      <div
        className={"cp-tx-body" + (selecting ? " selecting" : "")}
        ref={scrollRef}
        onScroll={onScroll}
        // Tracked on the body rather than per cue: a drag that starts on one
        // cue and ends on another only produces pointer events on the cue it
        // started in, so a per-cue flag would never clear.
        onPointerDown={(e) => { if (e.button === 0) setSelecting(true); }}
      >
        {searchMode === "speakers" ? (
          <SpeakerGroups
            groups={speakerGroups}
            turns={turns}
            cueStartIndices={cueStartIndices}
            activeCueIdx={activeCueIdx}
            query={query}
            formatTime={(sec) => secondsToTc(sec, fps)}
            onSeek={(sec) => { setAutoScroll(true); onSeek(sec); }}
          />
        ) : turns.map((turn, ti) => {
          const cueStartIdx = cueStartIndices[ti];
          const { displayName, resolvedTag } = turnMeta[ti];
          const hasOverride =
            !!overrides.turn[String(ti)] ||
            !!overrides.turnTag[String(ti)] ||
            // Resolve the alias chain — globals are keyed on the RESOLVED tag,
            // so a merged-then-renamed turn must check its canonical key.
            !!overrides.global[resolvedTag ?? "__NULL__"];
          return (
            <div className="cp-tx-turn" key={ti}>
              <div className={"cp-tx-turn-head" + (hasRealSpeakers ? "" : " no-speaker")}>
                {hasRealSpeakers && (<>
                {/* The chip is decorative alongside the NAME button (one tab
                    stop per speaker, not two) - the button is the keyboard
                    path to rename (a11y r141). */}
                <span
                  className={"cp-tx-speaker" + (hasOverride ? " renamed" : "")}
                  style={{ background: speakerDisplayColor(resolvedTag) }}
                  aria-hidden
                  onClick={(e) => openRename(e, ti, turn.speaker)}
                  onContextMenu={(e) => openRename(e, ti, turn.speaker)}
                  title="Click or right-click to rename · use Manage speakers to recolour or merge"
                >
                  <KindGlyph tag={resolvedTag} name={displayName} size={13} override={overrides.icons[resolvedTag ?? "__NULL__"]} />
                </span>
                <button
                  type="button"
                  className="cp-tx-speaker-name"
                  aria-label={`Rename speaker ${displayName}`}
                  onClick={(e) => openRename(e, ti, turn.speaker)}
                  onContextMenu={(e) => openRename(e, ti, turn.speaker)}
                  title="Click or right-click to rename"
                >
                  {displayName}
                </button>
                </>)}
                <button
                  className="cp-tx-jump"
                  onClick={() => { setAutoScroll(true); onSeek(turn.start); }}
                  title="Jump to this turn"
                >
                  {secondsToTc(turn.start, fps)}
                </button>
              </div>
              <div className="cp-tx-turn-body">
                {turn.cues.map((cue, ci) => {
                  const idx = cueStartIdx + ci;
                  if (idx === editingCue) {
                    return (
                      <CueEditor
                        key={ci}
                        initialText={cue.text}
                        onCommit={(t) => { void commitCueEdit(idx, t); }}
                        onCancel={() => setEditingCue(null)}
                      />
                    );
                  }
                  const active = idx === activeCueIdx;
                  const isMatch = matchSet.has(idx);
                  const isActiveMatch = matches[matchCursor] === idx;
                  return (
                    <span
                      key={ci}
                      data-cue-idx={idx}
                      className={
                        "cp-tx-cue" +
                        (active ? " active" : "") +
                        (isMatch ? " match" : "") +
                        (isActiveMatch ? " match-active" : "")
                      }
                      // Editing a cue is the most common thing anyone does in
                      // this panel — a Whisper mis-transcription is fixed here
                      // — and the ONLY way in was a double-click on a bare
                      // <span> with no role, no tab stop and no key handler.
                      // A mouse was mandatory to correct a word.
                      //
                      // Now a real button-shaped control: Enter or Space jumps
                      // (matching the click), and F2 opens the editor, which is
                      // the rename convention every file manager and
                      // spreadsheet has trained people on. Double-click still
                      // works and is still the fastest way with a mouse.
                      role="button"
                      // EXACTLY ONE cue is a tab stop, and it is the one at the
                      // playhead — so Tab lands you on the line you are
                      // currently hearing, which is the line you want to fix.
                      // Making every cue tabbable would put thousands of stops
                      // in a two-hour interview, the same explosion the Library
                      // grid had. Clicking any cue moves the stop to it.
                      tabIndex={idx === tabbableCueIdx ? 0 : -1}
                      onFocus={() => setFocusedCue(idx)}
                      aria-label={`${secondsToTc(cue.start, fps)} ${cue.text}`}
                      onClick={() => {
                        // A drag-select ENDS in a click on the last cue it
                        // touched. Without this guard, finishing a selection
                        // seeks the player and re-arms follow-scroll, which
                        // then scrolls the very selection you just made out
                        // from under you. Nothing else in the app selects
                        // text, so nothing else hit this.
                        if (!document.getSelection()?.isCollapsed) return;
                        setAutoScroll(true);
                        onSeek(cue.start);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "F2") {
                          e.preventDefault();
                          e.stopPropagation();
                          setAutoScroll(false);
                          setEditingCue(idx);
                          return;
                        }
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setAutoScroll(true);
                          onSeek(cue.start);
                        }
                      }}
                      onContextMenu={(e) => {
                        const range = selectionToCueRange(document.getSelection(), scrollRef.current);
                        // No selection means this is an ordinary right-click
                        // on one cue, which is still a useful thing to act on:
                        // treat that cue as the range.
                        const r = range ?? { from: idx, to: idx };
                        e.preventDefault();
                        e.stopPropagation();
                        // Repaint the highlight to the SNAPPED range before
                        // the menu opens, so what is highlighted is exactly
                        // what will change. Without this the user lassos half
                        // a sentence, the action quietly widens to whole cues,
                        // and the result does not match what they saw.
                        paintCueRange(r, scrollRef.current);
                        setAutoScroll(false);
                        setCueMenu({ x: e.clientX, y: e.clientY, ...r });
                      }}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        // Freeze follow-mode so the karaoke autoscroll can't
                        // yank the paragraph away mid-edit.
                        setAutoScroll(false);
                        setEditingCue(idx);
                      }}
                      title={`${secondsToTc(cue.start, fps)} · click to jump · double-click or F2 to edit`}
                    >
                      {/* In speaker mode, don't highlight the body —
                          the query targets the speaker name, not the
                          words, so dribbling marks into the prose just
                          confuses the user (e.g. searching "Tom" would
                          mark "tomorrow"). */}
                      {highlightMatch(cue.text, searchMode === "text" ? query : "")}{" "}
                    </span>
                  );
                })}
              </div>
            </div>
          );
        })}
        <div style={{ height: 32 }} />
      </div>

      {/* Floating "Follow playback" pill — FALLBACK only: transcripts with
          no speaker roster have no header row to host the control (3d moved
          it beside Manage speakers), so the chat-style pill covers them. */}
      {!autoScroll && !rosterVisible && (
        <button
          className="cp-tx-follow-pill"
          onClick={() => setAutoScroll(true)}
          title="Resume auto-scroll to follow playback"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <polyline points="6 9 12 15 18 9" />
          </svg>
          Follow playback
        </button>
      )}

      {/* Rename popover — portaled so it can overflow the drawer + sit
          above scroll. Positioned next to the chip the user clicked.
          When other speakers exist, it also offers "this turn is actually …"
          — a per-turn reassignment to a known speaker (computed only while
          the popover is open, so it costs nothing on playhead ticks). */}
      {rename && (
        <RenamePopover
          state={rename}
          onCancel={() => setRename(null)}
          onApply={applyRename}
          colorValue={speakerDisplayColor(effectiveTagFor(rename.turnIdx, rename.originalTag))}
          iconValue={overrides.icons[
            resolveAliasChain(effectiveTagFor(rename.turnIdx, rename.originalTag), overrides.aliases) ?? "__NULL__"
          ] ?? null}
          onPickIcon={(kind) => {
            const resolved = resolveAliasChain(effectiveTagFor(rename.turnIdx, rename.originalTag), overrides.aliases);
            setSpeakerIcon(resolved ?? "__NULL__", kind);
          }}
          onPickColor={(hex) => {
            const resolved = resolveAliasChain(effectiveTagFor(rename.turnIdx, rename.originalTag), overrides.aliases);
            setSpeakerColor(resolved ?? "__NULL__", hex);
          }}
          onGoToSpeaker={goToSpeaker}
          reassignChoices={roster
            .filter((r) => r.tag !== (effectiveTagFor(rename.turnIdx, rename.originalTag) ?? "Speaker"))
            .map((r): ReassignChoice => ({
              tag: r.tag,
              name: r.name,
              color: speakerDisplayColor(r.colorTag),
              talkSeconds: r.talkSeconds,
            }))
            // Loudest first, like the Speakers view, the roster and the split
            // sheet. First-appearance order put the lead wherever they
            // happened to start talking.
            .sort((a, b) => b.talkSeconds - a.talkSeconds)}
          onReassign={(tag) => reassignTurn(rename.turnIdx, tag)}
        />
      )}
      {speakerModalOpen && (
        <SpeakerRosterModal
          roster={roster}
          onRename={renameSpeaker}
          onMergeMany={mergeSpeakers}
          onPlaySpeaker={goToSpeakerTag}
          onApplyCast={applyCast}
          onGrabFace={onGrabFace}
          colorOf={(item) => speakerDisplayColor(item.colorTag)}
          onPickColor={(item, rect) => setColorPick({ key: item.colorTag ?? "__NULL__", rect })}
          onClose={() => setSpeakerModalOpen(false)}
        />
      )}
      {cueMenu && (
        <CueSelectionMenu
          anchor={{ x: cueMenu.x, y: cueMenu.y }}
          cueCount={cueMenu.to - cueMenu.from + 1}
          speakers={roster.map((r) => ({ tag: r.tag, name: r.name, color: speakerDisplayColor(r.colorTag) }))}
          currentTag={resolveAlias(flatCues[cueMenu.from]?.cue.speaker ?? null) ?? "Speaker"}
          onAssign={(tag) => assignCueRange(cueMenu.from, cueMenu.to, tag === "Speaker" ? "" : tag)}
          onNewSpeaker={() => splitToNewSpeaker(cueMenu.from, cueMenu.to)}
          onPlay={() => { const c = flatCues[cueMenu.from]?.cue; if (c) onSeek(c.start); }}
          onClose={() => setCueMenu(null)}
        />
      )}
      {naming && (
        <NewSpeakerSheet
          suggestions={roster
            .filter((r) => r.tag !== naming.tag)
            .map((r) => ({
              tag: r.tag,
              name: r.name,
              color: speakerDisplayColor(r.colorTag),
              talkSeconds: r.talkSeconds,
              untagged: r.colorTag === null,
            }))}
          initialColor={speakerDisplayColor(naming.tag)}
          onName={(name, color) => {
            editOverrides("name new speaker", (prev) => ({
              ...prev,
              global: { ...prev.global, [naming.tag]: name },
              colors: { ...prev.colors, [naming.tag]: color },
            }));
            setNaming(null);
          }}
          onPickKind={(kind) => {
            assignCueRangeToKind(naming.from, naming.to, kind);
            setNaming(null);
          }}
          onPickExisting={(tag) => {
            // Re-point the same cues at somebody who already exists. One more
            // undo step than the split, which is right: they are two decisions.
            assignCueRange(naming.from, naming.to, tag === "Speaker" ? "" : tag);
            setNaming(null);
          }}
          onCancel={() => setNaming(null)}
        />
      )}
      {colorPick && (
        <SpeakerColorPicker
          value={
            overrides.colors[colorPick.key]
            || speakerTextColor(colorPick.key === "__NULL__" ? null : colorPick.key)
          }
          anchorRect={colorPick.rect}
          onCommit={(hex) => setSpeakerColor(colorPick.key, hex)}
          onReset={overrides.colors[colorPick.key]
            ? () => { resetSpeakerColor(colorPick.key); setColorPick(null); }
            : undefined}
          onClose={() => setColorPick(null)}
        />
      )}
      {insightsAnchor && (
        <InsightsPopover
          anchor={insightsAnchor}
          stats={insightStats}
          colorOf={(s) => speakerDisplayColor(resolveAlias(s))}
          onClose={() => setInsightsAnchor(null)}
        />
      )}
      {historyOpen && historyBtnRef.current && (
        <HistoryPopover
          anchor={historyBtnRef.current.getBoundingClientRect()}
          entries={historyEntries}
          activePath={path}
          onClose={() => setHistoryOpen(false)}
          onPick={(entry) => {
            setHistoryOpen(false);
            onLoadFromHistory(entry);
          }}
          onRemove={(id) => {
            removeEntry(id);
            setHistoryEntries(getHistory());
          }}
          onClearAll={() => {
            clearHistory();
            setHistoryEntries(getHistory());
          }}
        />
      )}
    </div>
  );
}
