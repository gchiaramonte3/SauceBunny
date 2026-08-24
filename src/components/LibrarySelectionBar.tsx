import { IconFolder, IconReveal, IconStack, IconTranscript, IconCircleX, IconTrash } from "./Icons";

/**
 * The bar that appears once more than one file is selected.
 *
 * IT EXISTS SO MULTI-SELECT MEANS SOMETHING. Shift-clicking a range with no
 * verbs behind it is a highlight, not a feature — the user assembles a set and
 * then has nowhere to take it. This is where the set becomes an action, and it
 * is deliberately the only place a batch runs from, so "what will this apply
 * to" always has one visible answer: the count in this bar.
 *
 * APPEARS AT TWO, NOT AT ONE. A single selected file is the ordinary browsing
 * state and already has the detail panel; showing a batch bar for it would put
 * a second, competing set of actions on screen for every single click.
 */
export function LibrarySelectionBar({
  count, onTranscribe, onQueue, onReveal, onMove, onDelete, deleteLabel, onClear,
  batchLine, onBatchCancel,
}: {
  count: number;
  /** Live batch status. Rendered even at zero selection: clearing the
   *  selection must not hide a job that is still running. */
  batchLine?: string | null;
  onBatchCancel?: () => void;
  /** Transcribe every selected file, queued. Absent while one is already running. */
  onTranscribe?: () => void;
  onQueue?: () => void;
  onReveal?: () => void;
  /** File the whole selection into a folder. Shelves whose containers are
   *  real directories (frames) offer this; the folder pane does not, because
   *  moving files between library roots is a different, riskier act. */
  onMove?: () => void;
  /** Delete the whole selection. Asks first, at the call site. */
  onDelete?: () => void;
  deleteLabel?: string;
  onClear: () => void;
}) {
  if (batchLine) {
    return (
      <div className="cp-lib-selbar" role="status" aria-live="polite">
        <span className="cp-lib-selbar-count">{batchLine}</span>
        <span className="cp-lib-selbar-spacer" />
        {onBatchCancel && (
          <button className="btn btn-ghost" onClick={onBatchCancel} title="Stop after the current file">
            <IconCircleX size={14} /> Stop
          </button>
        )}
      </div>
    );
  }
  if (count < 2) return null;
  return (
    <div className="cp-lib-selbar" role="toolbar" aria-label={`${count} files selected`}>
      <span className="cp-lib-selbar-count">{count} selected</span>
      <span className="cp-lib-selbar-spacer" />
      {onTranscribe && (
        <button className="btn btn-ghost" onClick={onTranscribe} title="Transcribe all selected files, one after another">
          <IconTranscript size={14} /> Transcribe
        </button>
      )}
      {onQueue && (
        <button className="btn btn-ghost" onClick={onQueue} title="Add all selected files to the clip queue">
          <IconStack size={14} /> Add to queue
        </button>
      )}
      {onReveal && (
        <button className="btn btn-ghost" onClick={onReveal} title="Reveal the selected files in Finder">
          <IconReveal size={14} /> Reveal
        </button>
      )}
      {onMove && (
        <button className="btn btn-ghost" onClick={onMove} title="File every selected item into a folder">
          <IconFolder size={14} /> Move
        </button>
      )}
      {/* Destructive verb LAST, the order every menu in this app uses, so the
          pointer never passes over it on the way to something safe. */}
      {onDelete && (
        <button className="btn btn-ghost cp-selbar-danger" onClick={onDelete} title={deleteLabel ?? "Delete the selected items"}>
          <IconTrash size={14} /> Delete
        </button>
      )}
      <button className="btn btn-ghost" onClick={onClear} title="Clear the selection (Esc)">
        <IconCircleX size={14} /> Clear
      </button>
    </div>
  );
}
