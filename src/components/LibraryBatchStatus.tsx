import { IconCircleX } from "./Icons";

/**
 * A running batch, and the way to stop it.
 *
 * WHAT THIS USED TO BE, and why it is not that any more: the same element was
 * also a floating "N selected · Reveal · Move · Delete" pill that appeared
 * whenever two or more files were selected. It was removed on request, and the
 * request was right - the pill was a second, competing set of actions hovering
 * over the shelf, in a different idiom from the row menus that already carry
 * those verbs, and it covered the last row of whatever you were looking at.
 * Every verb it held now lives in the right-click menu, which is where the
 * rest of the library keeps its verbs.
 *
 * WHAT SURVIVES IS NOT A BUTTON BAR. A batch transcribe can run for many
 * minutes across many files, and a job with no visible progress and no way to
 * stop it is a worse problem than a crowded shelf. So this stays: it appears
 * only while a batch is actually running, says what it is doing, and offers
 * Stop. It is a status strip, and it is deliberately independent of the
 * selection - clearing the selection must not hide a job that is still going.
 *
 * The class name is unchanged (`cp-lib-selbar`) because the LAYOUT rule it
 * carries is unchanged and is pinned by selection-bar-contract: this element
 * must stay out of the browse row's flex flow, or it renders as a full-height
 * column beside the grid rather than as a strip.
 */
export function LibraryBatchStatus({ batchLine, onBatchCancel }: {
  /** Live batch status, e.g. "Transcribing 3 of 12". Null when idle. */
  batchLine?: string | null;
  onBatchCancel?: () => void;
}) {
  if (!batchLine) return null;
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
