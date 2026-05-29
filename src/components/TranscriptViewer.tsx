import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { IconReveal, IconAlert, IconChevronDown } from "./Icons";
import { parseSrt, groupIntoTurns, fmtTime, type Turn } from "../lib/srt";
import {
  getHistory,
  removeEntry,
  type TranscriptHistoryEntry,
} from "../lib/transcript-history";
import { RenamePopover, type RenameState } from "./transcript/RenamePopover";
import {
  MergeConfirmPopover,
  type MergeConfirmState,
} from "./transcript/MergeConfirmPopover";
import { HistoryPopover } from "./transcript/HistoryPopover";
import {
  escapeHtml,
  highlightMatch,
  humaniseSpeakerTag,
  resolveAliasChain,
  speakerColor,
  speakerInitials,
} from "./transcript/helpers";

type Props = {
  /**
   * Absolute path on disk to the SRT/VTT file. When null, we render the
   * empty state. When changed, we reload + reparse.
   */
  path: string | null;
  /**
   * Current playhead position in seconds. Drives the karaoke highlight.
   * Pass `null` when no source is loaded.
   */
  playheadSeconds: number | null;
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
};

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
  path, playheadSeconds, onSeek, origin: _origin,
  onClearTranscript, onLoadFromHistory,
  onRegenerate, regenerateBusy, canRegenerate,
  onImportTranscript,
}: Props) {
  const [raw, setRaw] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);

  // ── Speaker overrides ───────────────────────────────────────────
  // Three layers, resolved in this order (later wins):
  //   1. aliases:  tag → tag    "these two are the same person"
  //   2. global:   tag → name   "rename SPEAKER_00 → Tom everywhere"
  //   3. turn:     ti  → name   "this one turn is actually …"
  //
  // displayNameFor() walks the alias chain first (so a merged speaker
  // resolves to its target tag), then applies the global rename on the
  // resolved tag, then the per-turn override. Color is also keyed on
  // the resolved tag so merged speakers share a colour.
  //
  // All three layers persist together in localStorage keyed by path.
  type Overrides = {
    global: Record<string, string>;
    turn: Record<string, string>;
    aliases: Record<string, string>;
  };
  const storageKey = path ? `saucebunny.speakerNames.${path}` : null;
  const [overrides, setOverrides] = useState<Overrides>({ global: {}, turn: {}, aliases: {} });

  // Load overrides when the path changes.
  useEffect(() => {
    if (!storageKey) { setOverrides({ global: {}, turn: {}, aliases: {} }); return; }
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Overrides;
        // Defensive: clamp shape so a corrupted entry doesn't crash.
        setOverrides({
          global:  typeof parsed.global  === "object" && parsed.global  ? parsed.global  : {},
          turn:    typeof parsed.turn    === "object" && parsed.turn    ? parsed.turn    : {},
          aliases: typeof parsed.aliases === "object" && parsed.aliases ? parsed.aliases : {},
        });
      } else {
        setOverrides({ global: {}, turn: {}, aliases: {} });
      }
    } catch {
      setOverrides({ global: {}, turn: {}, aliases: {} });
    }
  }, [storageKey]);

  // Persist on every change. Skip the no-op (empty + key absent) write.
  useEffect(() => {
    if (!storageKey) return;
    const empty = Object.keys(overrides.global).length === 0
               && Object.keys(overrides.turn).length === 0
               && Object.keys(overrides.aliases).length === 0;
    if (empty) {
      localStorage.removeItem(storageKey);
    } else {
      try { localStorage.setItem(storageKey, JSON.stringify(overrides)); } catch { /* quota */ }
    }
  }, [storageKey, overrides]);

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

  // ── Load the file whenever the path changes ──────────────────────
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
        setLoadErr(String(e ?? "Failed to read transcript"));
        setRaw(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  // ── Parse + group whenever the raw text changes ──────────────────
  const turns: Turn[] = useMemo(() => {
    if (!raw) return [];
    try { return groupIntoTurns(parseSrt(raw)); } catch { return []; }
  }, [raw]);

  const flatCues = useMemo(
    () => turns.flatMap((t, ti) => t.cues.map((c, ci) => ({ cue: c, turnIdx: ti, cueIdx: ci }))),
    [turns],
  );

  // ── Active row from playhead ─────────────────────────────────────
  const activeCueIdx = useMemo(() => {
    if (playheadSeconds == null || flatCues.length === 0) return -1;
    let lo = 0, hi = flatCues.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = flatCues[mid].cue;
      if (playheadSeconds < c.start) hi = mid - 1;
      else if (playheadSeconds > c.end) lo = mid + 1;
      else return mid;
    }
    return Math.max(-1, hi);
  }, [playheadSeconds, flatCues]);

  useEffect(() => {
    if (!autoScroll || activeCueIdx < 0 || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-cue-idx="${activeCueIdx}"]`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeCueIdx, autoScroll]);

  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const top = e.currentTarget.scrollTop;
    const delta = Math.abs(top - lastScrollTop.current);
    lastScrollTop.current = top;
    if (delta > 80) setAutoScroll(false);
  }

  // ── Speaker display name resolution ──────────────────────────────
  // Hoisted above the search block (r43) so `matches` in speaker mode
  // can call it. The full block (rename + merge + roster) still lives
  // further down — only the resolver itself moves up.
  const displayNameFor = useCallback((turnIdx: number, originalTag: string | null): string => {
    const turnOverride = overrides.turn[String(turnIdx)];
    if (turnOverride) return turnOverride;
    const resolved = resolveAlias(originalTag);
    const tagKey = resolved ?? "__NULL__";
    const globalOverride = overrides.global[tagKey];
    if (globalOverride) return globalOverride;
    // Humanise the model-emitted tag for display. SPEAKER_00 → Speaker 1
    // (1-indexed, since humans don't say "speaker zero"). Custom tags
    // (already-renamed, or non-diarized null) pass through unchanged.
    return humaniseSpeakerTag(resolved);
  }, [overrides, resolveAlias]);

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
  // and forget to flip back.
  type SearchMode = "text" | "speakers";
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

  const jumpToMatch = useCallback((delta: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (matchCursor + delta + matches.length) % matches.length;
    setMatchCursor(next);
    const cueIdx = matches[next];
    const cue = flatCues[cueIdx]?.cue;
    if (!cue) return;
    setAutoScroll(false);
    onSeek(cue.start);
    scrollRef.current?.querySelector<HTMLElement>(`[data-cue-idx="${cueIdx}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [matches, matchCursor, flatCues, onSeek]);

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); jumpToMatch(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape") { e.preventDefault(); setQuery(""); }
  }

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
      e.preventDefault();
      jumpToMatch(e.shiftKey ? -1 : 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [matches, jumpToMatch]);

  /**
   * Merge sourceTag into targetTag — i.e. "these are actually the
   * same person." Implemented as an alias entry rather than rewriting
   * every turn, so the merge is fully reversible (delete the alias)
   * and any future rename on the target propagates correctly.
   *
   * Cycle prevention: if targetTag (after its own alias resolution)
   * would land back on sourceTag, refuse. Also no-op when source ==
   * target.
   */
  const mergeSpeaker = useCallback((sourceTag: string, targetTag: string) => {
    if (sourceTag === targetTag) return;
    setOverrides((prev) => {
      // Resolve target's own alias chain so the alias always points
      // at the canonical tag (compacts chains, avoids deep walks).
      const canonicalTarget = resolveAliasChain(targetTag, prev.aliases) ?? targetTag;
      if (canonicalTarget === sourceTag) {
        // Would create a cycle. Refuse silently — the user just
        // dragged onto themselves (transitively).
        return prev;
      }
      const next: Overrides = {
        global:  { ...prev.global },
        turn:    { ...prev.turn },
        aliases: { ...prev.aliases, [sourceTag]: canonicalTarget },
      };
      // Drop a now-unused global rename on the source (its tag
      // resolves elsewhere, so the rename would never display anyway).
      delete next.global[sourceTag];
      return next;
    });
  }, []);

  const unmergeSpeaker = useCallback((sourceTag: string) => {
    setOverrides((prev) => {
      if (!prev.aliases[sourceTag]) return prev;
      const next = { ...prev, aliases: { ...prev.aliases } };
      delete next.aliases[sourceTag];
      return next;
    });
  }, []);

  // ── Roster: unique speakers (post-alias) + their stats ──────────
  // Used by the roster panel above the transcript body AND drives the
  // drop-target set for the drag-to-merge interaction.
  type RosterEntry = {
    /** Canonical tag — after alias resolution. */
    tag: string;
    /** Display name (after rename). */
    name: string;
    /** Number of turns assigned to this canonical tag. */
    turnCount: number;
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
      const canonical = resolveAlias(t.speaker) ?? "Speaker";
      let entry = byCanonical.get(canonical);
      if (!entry) {
        entry = {
          tag: canonical,
          name: displayNameFor(ti, t.speaker),
          turnCount: 0,
          sourceTags: [],
        };
        byCanonical.set(canonical, entry);
        orderMap.set(canonical, order++);
      }
      entry.turnCount += 1;
      if (t.speaker && !entry.sourceTags.includes(t.speaker)) {
        entry.sourceTags.push(t.speaker);
      }
    }
    const list = Array.from(byCanonical.values());
    list.sort((a, b) => (orderMap.get(a.tag)! - orderMap.get(b.tag)!));
    return list;
  }, [turns, resolveAlias, displayNameFor]);

  // Drag-to-merge: track the dragged source tag in a ref so handlers
  // can read it inside React without re-render thrash. Hover state
  // for visual feedback lives in component state.
  const dragTagRef = useRef<string | null>(null);
  const [dragHoverTag, setDragHoverTag] = useState<string | null>(null);

  // Merge-confirm popover — opens at the drop site when the user
  // releases a chip on top of another. Confirmed merges call
  // mergeSpeaker; cancellation just dismisses. Component + type live in
  // ./transcript/MergeConfirmPopover.tsx.
  const [mergeConfirm, setMergeConfirm] = useState<MergeConfirmState | null>(null);

  // Rename popover state — tracks which turn the user is editing.
  // Anchored to the speaker chip rect so the popover appears next to
  // where the user clicked. Component + type live in
  // ./transcript/RenamePopover.tsx.
  const [rename, setRename] = useState<RenameState | null>(null);

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
    setOverrides((prev) => {
      const next: Overrides = {
        global:  { ...prev.global },
        turn:    { ...prev.turn },
        aliases: { ...prev.aliases },
      };
      const tagKey = rename.originalTag ?? "__NULL__";
      if (scope === "all") {
        if (trimmed && trimmed !== (rename.originalTag ?? "Speaker")) {
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

  function resetAllRenames() {
    setOverrides({ global: {}, turn: {}, aliases: {} });
    setRename(null);
  }

  // ── Download menu state ──────────────────────────────────────────
  const [dlOpen, setDlOpen] = useState(false);
  const dlRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dlOpen) return;
    function onDoc(e: MouseEvent) {
      if (!dlRef.current?.contains(e.target as Node)) setDlOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [dlOpen]);

  // ── History popover state ────────────────────────────────────────
  // Anchored to the History button. Closes on outside-click or Esc.
  // Re-reads localStorage on each open so the list reflects entries
  // recorded by other components / other open windows.
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
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
      const bytes = Array.from(new TextEncoder().encode(content));
      await invoke("write_bytes_to_path", { path: dest, bytes });
    } catch (e) {
      console.error("transcript download failed:", e);
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
    return (
      <div className="cp-tx-empty">
        <div className="cp-tx-empty-title">No transcript yet</div>
        <div className="cp-tx-empty-body">
          Generate a Whisper transcript or download YouTube captions from the
          sidebar — the result appears here automatically. Or import an existing
          <code> .srt</code> / <code>.vtt</code> from disk:
        </div>
        <div className="cp-tx-empty-actions">
          <button className="btn btn-ghost" onClick={onImportTranscript}>
            Import transcript…
          </button>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div className="cp-tx-empty"><div className="cp-tx-empty-title">Loading transcript…</div></div>;
  }

  if (loadErr) {
    return (
      <div className="cp-tx-empty">
        <IconAlert size={20} stroke="var(--color-warn, #f5a)" />
        <div className="cp-tx-empty-title">Couldn't read transcript</div>
        <div className="cp-tx-empty-body">{loadErr}</div>
      </div>
    );
  }

  if (turns.length === 0) {
    return (
      <div className="cp-tx-empty">
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
    Object.keys(overrides.turn).length > 0;

  return (
    <div className="cp-tx-wrap">
      {/* Header — Clear · History · Download. Per user feedback the
          filename was visual noise (it's already implied by which
          source you have loaded); the header is now actions-only. The
          filename is preserved on the History row where it adds
          context (telling apart prior transcripts). */}
      <div className="cp-tx-head">
        <div className="cp-tx-head-actions cp-tx-head-left">
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
          <button
            className={"btn btn-ghost cp-tx-iconbtn" + (historyOpen ? " active" : "")}
            onClick={() => setHistoryOpen((p) => !p)}
            title="Re-open a previous transcript"
            ref={historyBtnRef}
          >
            {/* Inline clock glyph — bare SVG keeps the icon file from
                growing every time we need a one-off. */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <polyline points="12 7 12 12 15 14" />
            </svg>
            <span>History</span>
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
              <button role="menuitem" onClick={onReveal}>Reveal original in Finder</button>
            </div>
          )}
        </div>
      </div>

      <div className="cp-tx-search">
        {/* Mode pill — Text / Speakers. Two-button segmented control;
            we'll grow it (Markers, Timestamps) as those features land
            but this is what the user asked for now (Avid-style filter). */}
        <div className="cp-tx-search-mode" role="tablist" aria-label="Search mode">
          <button
            role="tab"
            aria-selected={searchMode === "text"}
            className={"cp-tx-search-mode-btn" + (searchMode === "text" ? " active" : "")}
            onClick={() => setSearchMode("text")}
            title="Search the transcript text"
          >
            Text
          </button>
          <button
            role="tab"
            aria-selected={searchMode === "speakers"}
            className={"cp-tx-search-mode-btn" + (searchMode === "speakers" ? " active" : "")}
            onClick={() => setSearchMode("speakers")}
            title="Search by speaker name (e.g. 'Tom', 'Speaker 2')"
          >
            Speakers
          </button>
        </div>
        <input
          className="cp-tx-search-input"
          placeholder={searchMode === "speakers" ? "Find a speaker…" : "Search transcript…  (⌘G next · ⇧⌘G prev)"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          /* Spell-check ON in text mode (Whisper output is prose);
             OFF in speaker mode (names like "Tom" or "Speaker 2" get
             squiggle-underlined as misspellings, which is just noise).
             `lang="en"` is the missing piece that nudges WKWebView to
             pick a real dictionary — without it the underline often
             doesn't render at all (per user screenshot r43 of "Thansky ou"
             not flagged). */
          spellCheck={searchMode === "text"}
          lang={searchMode === "text" ? "en" : undefined}
          autoComplete="off"
          autoCorrect={searchMode === "text" ? "on" : "off"}
        />
        {query && (
          <span className="cp-tx-search-count">
            {matches.length === 0 ? "no matches" : `${matchCursor + 1} / ${matches.length}`}
          </span>
        )}
        {/* "Follow playback" moved to a floating pill over the transcript
            body (r65) — it was overflowing this row. "Reset names" is now a
            compact icon (only when the user has renamed speakers) so the row
            never clips. */}
        {hasAnyOverride && (
          <button
            className="cp-tx-icon-action"
            onClick={resetAllRenames}
            title="Reset all custom speaker names for this transcript"
            aria-label="Reset speaker names"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.36 2.64L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
        )}
      </div>

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
      {turns.length > 0 && roster.length === 1 && roster[0].tag === "Speaker" && canRegenerate && !noticeDismissed && (
        <div className="cp-tx-hint">
          <svg className="cp-tx-hint-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 16v-4" />
            <path d="M12 8h.01" />
          </svg>
          <span className="cp-tx-hint-text">
            No speaker labels — enable <em>Detect speakers</em> in Settings, then regenerate.
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

      {(roster.length > 1 || (roster.length === 1 && roster[0].tag !== "Speaker")) && (
        <div className="cp-tx-roster" role="toolbar" aria-label="Speakers in this transcript">
          <div className="cp-tx-roster-label">
            {roster.length} speaker{roster.length === 1 ? "" : "s"}
            <span className="cp-tx-roster-hint">drag to merge</span>
          </div>
          <div className="cp-tx-roster-chips">
            {roster.map((r) => {
              const isDropHover = dragHoverTag === r.tag;
              const isDragSource = dragTagRef.current === r.tag;
              return (
                <div
                  key={r.tag}
                  className={
                    "cp-tx-roster-chip" +
                    (isDropHover ? " drop-hover" : "") +
                    (isDragSource ? " dragging" : "")
                  }
                  draggable
                  onDragStart={(e) => {
                    dragTagRef.current = r.tag;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("application/x-cp-speaker", r.tag);
                  }}
                  onDragEnd={() => { dragTagRef.current = null; setDragHoverTag(null); }}
                  onDragOver={(e) => {
                    const src = dragTagRef.current;
                    if (!src || src === r.tag) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragHoverTag !== r.tag) setDragHoverTag(r.tag);
                  }}
                  onDragLeave={(e) => {
                    if (e.currentTarget === e.target) setDragHoverTag(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const src = dragTagRef.current
                              ?? e.dataTransfer.getData("application/x-cp-speaker");
                    setDragHoverTag(null);
                    dragTagRef.current = null;
                    if (!src || src === r.tag) return;
                    // Open confirm popover; commit happens there.
                    const rect = e.currentTarget.getBoundingClientRect();
                    const srcEntry = roster.find((x) => x.tag === src || x.sourceTags.includes(src));
                    setMergeConfirm({
                      sourceTag: src,
                      sourceName: srcEntry?.name ?? src,
                      targetTag: r.tag,
                      targetName: r.name,
                      rect,
                    });
                  }}
                  onClick={(e) => {
                    // Click-to-rename on roster chip — find any turn
                    // whose canonical tag matches and pass it as the
                    // anchor turn index. The rename popover treats
                    // "rename all" as "rename this canonical tag", so
                    // any matching turnIdx works.
                    const anyTurnIdx = turns.findIndex((t) => (resolveAlias(t.speaker) ?? "Speaker") === r.tag);
                    if (anyTurnIdx >= 0) openRename(e, anyTurnIdx, r.tag);
                  }}
                  title={`${r.name} · ${r.turnCount} turn${r.turnCount === 1 ? "" : "s"}\nClick to rename · drag onto another speaker to merge`}
                >
                  <span
                    className="cp-tx-roster-pip"
                    style={{ background: speakerColor(r.tag) }}
                  >
                    {speakerInitials(r.name)}
                  </span>
                  <span className="cp-tx-roster-name">{r.name}</span>
                  <span className="cp-tx-roster-count">{r.turnCount}</span>
                  {r.sourceTags.length > 1 && (
                    <button
                      className="cp-tx-roster-unmerge"
                      onClick={(e) => {
                        e.stopPropagation();
                        // Unmerge the most-recent alias pointing here.
                        // Cheap approximation of "undo last merge for
                        // this canonical" — pop the first sourceTag
                        // that isn't the canonical itself.
                        const peel = r.sourceTags.find((s) => s !== r.tag);
                        if (peel) unmergeSpeaker(peel);
                      }}
                      title={`Merged from ${r.sourceTags.length} original speakers — click to peel one off`}
                    >
                      ⌥{r.sourceTags.length}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Body — one chat-bubble block per turn */}
      <div className="cp-tx-body" ref={scrollRef} onScroll={onScroll}>
        {turns.map((turn, ti) => {
          const cueStartIdx = turns.slice(0, ti).reduce((n, t) => n + t.cues.length, 0);
          const displayName = displayNameFor(ti, turn.speaker);
          const hasOverride =
            !!overrides.turn[String(ti)] ||
            !!overrides.global[turn.speaker ?? "__NULL__"];
          return (
            <div className="cp-tx-turn" key={ti}>
              <div className="cp-tx-turn-head">
                <span
                  className={"cp-tx-speaker" + (hasOverride ? " renamed" : "")}
                  style={{ background: speakerColor(resolveAlias(turn.speaker)) }}
                  onClick={(e) => openRename(e, ti, turn.speaker)}
                  onContextMenu={(e) => openRename(e, ti, turn.speaker)}
                  title="Click or right-click to rename · drag onto a speaker in the roster to merge"
                  draggable={!!turn.speaker}
                  onDragStart={(e) => {
                    if (!turn.speaker) return;
                    dragTagRef.current = resolveAlias(turn.speaker) ?? turn.speaker;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("application/x-cp-speaker", dragTagRef.current);
                  }}
                  onDragEnd={() => { dragTagRef.current = null; setDragHoverTag(null); }}
                >
                  {speakerInitials(displayName)}
                </span>
                <span
                  className="cp-tx-speaker-name"
                  onClick={(e) => openRename(e, ti, turn.speaker)}
                  onContextMenu={(e) => openRename(e, ti, turn.speaker)}
                  title="Click or right-click to rename"
                  style={{ cursor: "pointer" }}
                >
                  {displayName}
                </span>
                <button
                  className="cp-tx-jump"
                  onClick={() => { setAutoScroll(true); onSeek(turn.start); }}
                  title="Jump to this turn"
                >
                  {fmtTime(turn.start)}
                </button>
              </div>
              <div className="cp-tx-turn-body">
                {turn.cues.map((cue, ci) => {
                  const idx = cueStartIdx + ci;
                  const active = idx === activeCueIdx;
                  const isMatch = matches.includes(idx);
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
                      onClick={() => { setAutoScroll(true); onSeek(cue.start); }}
                      title={`${fmtTime(cue.start)} — click to jump`}
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

      {/* Floating "Follow playback" pill (r65) — appears over the transcript
          body when the user has scrolled away from the playhead. Recognizable
          chat-style "jump back to live" pattern; keeps it out of the cramped
          search row where it used to clip. */}
      {!autoScroll && (
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
          above scroll. Positioned next to the chip the user clicked. */}
      {rename && (
        <RenamePopover
          state={rename}
          onCancel={() => setRename(null)}
          onApply={applyRename}
        />
      )}
      {mergeConfirm && (
        <MergeConfirmPopover
          state={mergeConfirm}
          onCancel={() => setMergeConfirm(null)}
          onConfirm={() => {
            mergeSpeaker(mergeConfirm.sourceTag, mergeConfirm.targetTag);
            setMergeConfirm(null);
          }}
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
        />
      )}
    </div>
  );
}
