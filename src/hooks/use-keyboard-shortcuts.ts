import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { AppView } from "../App";
import type { PlayerHandle } from "../components/player-handle";
import type { ToastKind } from "../components/CanvasToast";
import { DISMISS_POPOVERS } from "./use-dismiss";
import {
  KEY_ACTION_BY_ID, VIEWS_WITH_A_PLAYER, eventToCombo, isPlaybackScoped,
  type KeyActionId,
} from "../lib/keybindings";
import { tcDigitsToFrames } from "../lib/timecode";
import { endSeekFrames } from "../lib/playhead-clock";
import { loadActiveTab } from "../lib/tab-state";

/** Everything the dispatch reads. Enumerated by tsc, not by hand. */
export type KeyboardShortcutsDeps = {
  comboToAction: Map<string, KeyActionId>;
  status: string;
  fps: number;
  readerFps: () => number;
  durationFrames: number;
  settingsOpen: boolean;
  exportOpts: { folder: string | null };
  // views + refs
  activeViewRef: { current: string };
  homeViewRef: RefObject<HTMLDivElement | null>;
  libraryViewRef: RefObject<HTMLDivElement | null>;
  clipViewRef: RefObject<HTMLDivElement | null>;
  coreviewViewRef: RefObject<HTMLDivElement | null>;
  readerViewRef: RefObject<HTMLDivElement | null>;
  readerPlayerRef: RefObject<PlayerHandle | null>;
  tcEntryRef: { current: string | null };
  kHeldRef: { current: boolean };
  reviewRangeGateRef: { current: {
    panelDetached: boolean; queueOpen: boolean; roomActive: boolean;
    reviewSourceKey: string | null; hasSource: boolean; clipVisible: boolean;
  } };
  reviewRangeKeysRef: RefObject<{ markIn: () => void; markOut: () => void } | null>;
  // transport + marks
  onPlayToggle: () => void;
  shuttleStep: (direction: 1 | -1, isRepeat?: boolean) => void;
  onMarkIn: () => void;
  onMarkOut: () => void;
  onClearMarks: () => void;
  onGotoIn: () => void;
  onGotoOut: () => void;
  onStep: (delta: number) => void;
  onSeek: (frames: number) => void;
  readerSeekRel: (secs: number) => void;
  handlePlaybackRateStep: (dir: 1 | -1) => void;
  handlePlaybackRateChange: (r: number) => void;
  // app actions
  handleFetch: () => void;
  handleExport: () => void;
  handleAddToQueue: () => void;
  performUndo: () => void;
  performRedo: () => void;
  navigateView: (v: AppView) => void;
  pushNotification: (kind: ToastKind, title: string, body: string, path?: string) => void;
  setTcEntry: Dispatch<SetStateAction<string | null>>;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setShortcutsOpen: Dispatch<SetStateAction<boolean>>;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  setLogsOpen: Dispatch<SetStateAction<boolean>>;
  setQueueOpenChoice: (next: boolean | ((p: boolean) => boolean)) => void;
};

/**
 * The global keyboard dispatch: rebindable shortcuts, the timecode-entry HUD,
 * and the K-held frame-step tracking.
 *
 * Lifted out of App.tsx as one block, verbatim. It was ~258 lines with a
 * twenty-five entry dependency array — the single most tangled effect in the
 * largest file in the codebase, and the reason CLAUDE.md calls App.tsx the
 * biggest risk here. Nothing in the body changed: the whole point of moving it
 * as-is is that a reviewer can diff the block and see no logic edits, and that
 * tsc enumerates the real dependency surface instead of me guessing at it.
 *
 * The three things that are NOT simple action triggers stay hand-coded around
 * the dispatch, exactly as they were: the timecode HUD swallows everything
 * while it is open, Escape belongs to SettingsModal (App must not add a second
 * closer — see the comment in the body), and a bare digit opens the HUD.
 */
export function useKeyboardShortcuts(p: KeyboardShortcutsDeps): void {
  const {
    comboToAction, status, fps, readerFps, durationFrames, settingsOpen, exportOpts,
    activeViewRef, homeViewRef, libraryViewRef, clipViewRef, coreviewViewRef,
    readerViewRef, readerPlayerRef, tcEntryRef, kHeldRef,
    reviewRangeGateRef, reviewRangeKeysRef,
    onPlayToggle, shuttleStep, onMarkIn, onMarkOut, onClearMarks,
    onGotoIn, onGotoOut, onStep, onSeek, readerSeekRel,
    handlePlaybackRateStep, handlePlaybackRateChange,
    handleFetch, handleExport, handleAddToQueue,
    performUndo, performRedo, navigateView, pushNotification,
    setTcEntry, setPaletteOpen, setShortcutsOpen, setSettingsOpen, setLogsOpen,
    setQueueOpenChoice,
  } = p;

  useEffect(() => {
    // Run a matched action with the exact behavior of its hand-coded predecessor
    // (the shuttle ladder on back/fwd, the export status gate, etc.).
    function runAction(id: KeyActionId, e: KeyboardEvent) {
      // Transport and Marking act on the Clip player and ITS in/out marks.
      // Every one of them was firing from Home and the Library, where that
      // player is mounted but not on screen — so pressing Space started
      // playback you could not see, i/o/g moved the export marks on a
      // different file than the one under the cursor, j/k/l shuttled it,
      // [ / ] / \ changed its speed and Home/End seeked it. Silent state
      // corruption from a view that looks inert.
      //
      // `global: false` in the binding table only means "not while typing";
      // there was never a view gate. The `reader` view is already handled
      // action by action below because it owns a second player; this is the
      // same idea applied once, to the views that own no player at all.
      //
      // Returning WITHOUT preventDefault is deliberate: the key has to stay
      // available to whatever view IS in front, which is what lets the
      // Library run arrow-key navigation and type-ahead on the same letters.
      if (isPlaybackScoped(id) && !VIEWS_WITH_A_PLAYER.has(activeViewRef.current)) return;
      e.preventDefault();
      switch (id) {
        // A keyboard-opened modal has to dismiss the transient popovers it
        // covers. `useDismiss` closes on an outside MOUSEDOWN and on Escape,
        // and ⌘K is neither — so the recents popover stayed open UNDERNEATH
        // the palette with its ↑/↓/Enter listener still live. Arrowing the
        // palette moved the hidden list too, and one Enter loaded a recent
        // video: the user's keystroke landed on a surface they could not see.
        //
        // Dispatched unconditionally rather than only on open. If this is the
        // toggle that CLOSES the palette, no popover can be open to receive it
        // (opening the palette is what closed them), so the extra event is
        // inert and the alternative is reading state the handler does not hold.
        case "app.palette":
          window.dispatchEvent(new CustomEvent(DISMISS_POPOVERS));
          setPaletteOpen((p) => !p);
          break;
        case "app.shortcuts":
          window.dispatchEvent(new CustomEvent(DISMISS_POPOVERS));
          setShortcutsOpen((p) => !p);
          break;
        case "app.settings": setSettingsOpen((p) => !p); break;
        // ⌘Z / ⇧⌘Z — non-global on purpose: in a text field these cases never
        // run (and nothing is preventDefault-ed), so the keystroke falls
        // through to the native Edit ▸ Undo/Redo menu items and the field's
        // own undo manager. Outside fields the DOM keydown arrives BEFORE the
        // menu's key equivalent and runAction's preventDefault suppresses it —
        // the same ordering the ⌘,/⌘K/⌘\ registry-vs-menu twins already rely on.
        case "edit.undo": performUndo(); break;
        case "edit.redo": performRedo(); break;
        case "src.fetch":    handleFetch(); break;
        // ⌘1/⌘2/⌘3 — top-level view switch (nav rail). Global: navigation has
        // to work from a text field too. The Clip view stays mounted either
        // way, so this never interrupts playback or a running job.
        case "view.home":
        case "view.library":
        case "view.clip":
        case "view.coreview":
        case "view.reader": {
          // View switching stays live during a session: the room is a
          // dressing of the shared stage, not a trap (leaving to Clip keeps
          // the session connected; the rail's Review badge is the way back).
          const v: AppView =
            id === "view.home" ? "home" :
            id === "view.library" ? "library" :
            id === "view.coreview" ? "coreview" :
            id === "view.reader" ? "reader" : "clip";
          // Route through navigateView (not raw setActiveView) so Home also
          // bumps homeResetTick like every other nav surface does.
          navigateView(v);
          // The outgoing view is about to be [hidden]; if focus lived inside
          // it, it orphans to <body>. Move focus into the newly-shown view's
          // root once React commits the unhide (rAF lands after the paint).
          const viewRef =
            v === "home" ? homeViewRef :
            v === "library" ? libraryViewRef :
            v === "coreview" ? coreviewViewRef :
            v === "reader" ? readerViewRef : clipViewRef;
          requestAnimationFrame(() => viewRef.current?.focus());
          break;
        }
        case "view.logs":    setLogsOpen((p) => !p); break;
        case "queue.add":    handleAddToQueue(); break;
        case "queue.toggle": setQueueOpenChoice((p) => !p); break;
        case "export.clip":
          if (status === "loaded" && !exportOpts.folder) {
            pushNotification("info", "Choose an export folder first",
              "Pick a folder in the sidebar, or set a default in Settings → General.");
          } else if (status === "loaded") {
            handleExport();
          }
          break;
        case "play.toggle":
          // In the reader, Space drives the reader's own player (the Clip
          // player is paused by the single-clock gate; onPlayToggle would wake
          // it). Elsewhere it's the Clip/room player as usual.
          if (activeViewRef.current === "reader") {
            const p = readerPlayerRef.current;
            if (p?.isReady()) { p.isPlaying() ? p.pause() : p.play(); }
          } else onPlayToggle();
          break;
        // J / L — NLE transport: each press walks the shuttle ladder
        // (1-2-4-8×, opposite press steps down, +1 resumes real playback);
        // with K held it's a single-frame nudge instead. Repeats (key held)
        // sustain the current rate rather than laddering to the cap.
        case "play.back5": if (activeViewRef.current === "reader") readerSeekRel(-5); else shuttleStep(-1, e.repeat); break;
        case "play.fwd5":  if (activeViewRef.current === "reader") readerSeekRel(5); else shuttleStep(1, e.repeat); break;
        case "mark.in":      onMarkIn(); break;
        case "mark.out":     onMarkOut(); break;
        // ⇧I/⇧O — review comment-range marks, only when the review UI is
        // actually in front of the user: docked drawer open, Review tab
        // active, a source loaded. loadActiveTab() reads the write-through
        // persisted tab (lib/tab-state) — no reactive plumbing needed. When
        // the panel is floated the docked drawer is unmounted and the
        // floated Review tab is a stub, so these no-op there.
        case "review.rangeIn":
        case "review.rangeOut": {
          const g = reviewRangeGateRef.current;
          // hasSource matters beyond reviewSourceKey: metadata (and thus the
          // key) survives status="error", but the playhead is null there —
          // marks would silently land at 0:00.
          // Room face forces the drawer open on the Review tab, so the
          // persisted tab/open prefs don't gate there.
          // The panel only tracks the playhead while its view is on screen, so
          // firing from Home/Library/Reader would reach a ReviewPanel whose
          // currentSec is null: the mark silently no-ops, or worse files at
          // 0:00. Gate on the same visibility the panel uses so the shortcut is
          // inert BY DESIGN here, not by accident.
          if (!g.clipVisible) break;
          if ((g.panelDetached && !g.roomActive) || (!g.roomActive && (!g.queueOpen || loadActiveTab() !== "review")) || !g.reviewSourceKey || !g.hasSource) break;
          const h = reviewRangeKeysRef.current;
          if (id === "review.rangeIn") h?.markIn(); else h?.markOut();
          break;
        }
        case "mark.clear":   onClearMarks(); break;
        case "mark.gotoIn":  onGotoIn(); break;
        case "mark.gotoOut": onGotoOut(); break;
        case "play.frameBack":  if (activeViewRef.current === "reader") readerSeekRel(-1 / readerFps()); else onStep(-1); break;
        case "play.frameFwd":   if (activeViewRef.current === "reader") readerSeekRel(1 / readerFps()); else onStep(1); break;
        case "play.secondBack": if (activeViewRef.current === "reader") readerSeekRel(-1); else onStep(-Math.round(fps)); break;
        case "play.secondFwd":  if (activeViewRef.current === "reader") readerSeekRel(1); else onStep(Math.round(fps)); break;
        case "play.toStart": if (activeViewRef.current === "reader") readerPlayerRef.current?.seekTo(0); else onSeek(0); break;
        case "play.toEnd": {
          if (activeViewRef.current === "reader") {
            const p = readerPlayerRef.current;
            if (p) p.seekTo(Math.max(0, p.getDuration() - 0.1));
            break;
          }
          const end = endSeekFrames(durationFrames);
          if (end != null) onSeek(end);
          break;
        }
        // Persistent playback speed ([ / ] / \) — steps the 0.5–2× list. No-op in
        // the reader (its transport is Space + skip + click-a-line, no rate UI).
        case "play.rateDown":  if (activeViewRef.current !== "reader") handlePlaybackRateStep(-1); break;
        case "play.rateUp":    if (activeViewRef.current !== "reader") handlePlaybackRateStep(1); break;
        case "play.rateReset": if (activeViewRef.current !== "reader") handlePlaybackRateChange(1); break;
      }
    }

    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const inField = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // Physical-K tracking for K+J/K+L frame-stepping. Tracked by e.code so
      // layout/Shift can't alias it; cleared on keyup + window blur below.
      if (e.code === "KeyK") kHeldRef.current = true;

      // ── Timecode entry HUD (modal text entry; not rebindable) ──
      // While open: digits append, Backspace deletes, Return snaps the playhead,
      // Esc cancels; everything else is swallowed so shortcuts can't fire mid-entry.
      if (tcEntryRef.current != null) {
        if (e.key >= "0" && e.key <= "9") { e.preventDefault(); setTcEntry((s) => ((s ?? "") + e.key).slice(-8)); return; }
        if (e.key === "Backspace")        { e.preventDefault(); setTcEntry((s) => (s ?? "").slice(0, -1)); return; }
        if (e.key === "Escape")           { e.preventDefault(); setTcEntry(null); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          const frames = tcDigitsToFrames(tcEntryRef.current ?? "", fps);
          setTcEntry(null);
          onSeek(frames);
          return;
        }
        return;
      }

      // ── Esc inside Settings belongs to SettingsModal, not here ──
      // This used to be a second, independent closer: `if (Escape &&
      // settingsOpen) setSettingsOpen(false)`. SettingsModal has always had its
      // own Escape handler, so the same key closed the same modal from two
      // places — harmless while both did the identical thing, and a real bug
      // the moment one of them learned a rule the other had not.
      //
      // That happened when Delete gained an arm/confirm step. The modal orders
      // it correctly (an armed Delete disarms; Escape only closes when nothing
      // is armed), but BOTH listeners are window/keydown in the bubble phase
      // and this one registers first — App mounts before the modal does — so it
      // closed Settings out from under the arming every time. A unit test on
      // SettingsModal alone could never see it; the e2e spec found it in a
      // browser, which is the reason that spec exists.
      //
      // The modal is always mounted (`open={settingsOpen}`) and its handler is
      // live whenever it is open, so nothing is lost by deleting the duplicate.
      // Do not re-add a second closer here; give the rule to the modal.

      // ── Rebindable shortcuts ──
      // global actions (⌘-combos) fire even in a field / with Settings open;
      // transport & marking only when neither is true (so typing never scrubs).
      const combo = eventToCombo(e);
      const actionId = combo ? comboToAction.get(combo) : undefined;
      if (actionId) {
        const action = KEY_ACTION_BY_ID[actionId];
        if (action.global || (!inField && !settingsOpen)) { runAction(actionId, e); return; }
      }

      if (inField || settingsOpen) return;

      // ── Bare number opens the TC-entry HUD (seeded with the digit) ──
      // Same view gate as the transport actions: a digit typed in the Library
      // was opening a "go to timecode" HUD over a player the user is not
      // looking at, and eating the keystroke that type-ahead wants.
      if (!VIEWS_WITH_A_PLAYER.has(activeViewRef.current)) { /* fall through */ }
      else if (e.key >= "0" && e.key <= "9" && durationFrames > 0) {
        e.preventDefault();
        setTcEntry(e.key);
        return;
      }
    }
    // Keyup/blur companions exist solely for the K-held bookkeeping — the
    // action dispatch itself stays keydown-only.
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "KeyK") kHeldRef.current = false;
    }
    function onBlur() { kHeldRef.current = false; }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    comboToAction, handleFetch, handleExport, handleAddToQueue, status, fps, durationFrames, settingsOpen,
    onPlayToggle, shuttleStep, onMarkIn, onMarkOut, onClearMarks,
    onGotoIn, onGotoOut, onStep, onSeek,
    handlePlaybackRateStep, handlePlaybackRateChange,
    performUndo, performRedo, navigateView,
    // `exportOpts.folder` is READ in this listener (the ⌘E "choose an export
    // folder first" guard). It refreshed anyway, but only because
    // `handleExport` above happens to depend on the whole `exportOpts` object
    // — narrow those deps to the fields it actually uses, which is an ordinary
    // optimisation, and ⌘E starts insisting on a folder the user has already
    // chosen. Listing it directly costs nothing (the effect already re-runs on
    // that change) and removes a coupling nothing states.
    exportOpts.folder,
    kHeldRef, pushNotification, readerSeekRel, setQueueOpenChoice,
    // Added when this moved out of App.tsx. Inside the component the linter
    // could see these were refs and setState functions and left them alone;
    // as props it cannot, so they are listed. Every one is identity-stable
    // (ten useRef, five useState setters, and readerFps is now a useCallback
    // with no deps), so the effect still subscribes exactly once — listing
    // them changes the lint, not the behaviour.
    activeViewRef, clipViewRef, coreviewViewRef, homeViewRef, libraryViewRef,
    readerFps, readerPlayerRef, readerViewRef,
    reviewRangeGateRef, reviewRangeKeysRef, tcEntryRef,
    setLogsOpen, setPaletteOpen, setSettingsOpen, setShortcutsOpen, setTcEntry,
  ]);
}
