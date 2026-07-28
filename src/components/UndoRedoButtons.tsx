import { useSyncExternalStore } from "react";
import { IconRedo, IconUndo } from "./Icons";
import { appUndo } from "../lib/undo";

/**
 * Undo / redo, with the state visible.
 *
 * The app has had an undo stack since marks and review comments were written,
 * and the only ways to reach it were ⌘Z and the command palette — so a user
 * who did not already know it existed had no reason to believe it did. That
 * matters most in transcription, where the edits are the fiddliest in the app
 * (renaming a speaker across a two-hour interview, merging two the diarizer
 * split, reassigning one turn) and where "reset all speaker names" sits one
 * click away.
 *
 * The buttons name what they will do, in the tooltip and to a screen reader:
 * "Undo rename speaker", not a bare "Undo". Knowing what is about to be
 * reversed is most of the value — it is the difference between pressing it and
 * hoping, and pressing it because you can see it is the thing you meant.
 *
 * Reads the stack itself rather than taking props, because the stack is a
 * module singleton with a `useSyncExternalStore`-shaped API and any surface
 * that renders these needs the SAME state; threading it would just be another
 * thing to get out of step.
 */
export function UndoRedoButtons({ onUndo, onRedo, compact }: {
  /** Defaults to the shared stack. App passes its own so the toast HUD and
   *  the composer's draft-first fallback behave identically to ⌘Z. */
  onUndo?: () => void;
  onRedo?: () => void;
  /** Icon-only, for a crowded toolbar. */
  compact?: boolean;
}) {
  const snap = useSyncExternalStore(appUndo.subscribe, appUndo.getSnapshot);
  const size = compact ? 13 : 14;
  return (
    <div className="cp-undoredo" role="group" aria-label="Undo and redo">
      <button
        type="button"
        className="btn btn-ghost btn-compact cp-undoredo-btn"
        disabled={!snap.canUndo}
        // The label carries the action, so a screen reader announces "Undo
        // merge speakers" rather than leaving the user to guess.
        aria-label={snap.undoLabel ? `Undo ${snap.undoLabel}` : "Undo"}
        title={snap.undoLabel ? `Undo ${snap.undoLabel}` : "Nothing to undo"}
        onClick={onUndo ?? (() => { appUndo.undo(); })}
      >
        <IconUndo size={size} />
        {!compact && <span>Undo</span>}
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-compact cp-undoredo-btn"
        disabled={!snap.canRedo}
        aria-label={snap.redoLabel ? `Redo ${snap.redoLabel}` : "Redo"}
        title={snap.redoLabel ? `Redo ${snap.redoLabel}` : "Nothing to redo"}
        onClick={onRedo ?? (() => { appUndo.redo(); })}
      >
        <IconRedo size={size} />
        {!compact && <span>Redo</span>}
      </button>
    </div>
  );
}
