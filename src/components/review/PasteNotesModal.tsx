import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { parseProducerNotes } from "../../lib/note-import";
import { secondsToClock } from "../../lib/timecode";
import { useModalFocus } from "../../hooks/use-modal-focus";

/** One row the panel actually imports. */
export type ImportedNote = {
  startSec: number | null;
  endSec: number | null;
  body: string;
};

/**
 * Paste a producer's notes doc, preview how it parsed, import as comments.
 *
 * WHY A PREVIEW AT ALL. The paste is a Google Doc or a Sheets column written
 * at speed — mixed timecode formats, ranges with missing spaces, typos, lines
 * with no timecode. The parser is deliberately forgiving, and forgiveness
 * means interpretation, and an interpretation the user never saw is how a
 * note lands at 8 minutes when the producer meant 8 seconds. The preview
 * shows the exact anchor every line resolved to BEFORE anything is written,
 * with a checkbox per row so sheet furniture ("STORY NOTES", the title row)
 * can ride along in the paste and simply stay unticked.
 *
 * THE AUTHOR FIELD IS EDITABLE because these are usually someone ELSE'S
 * words. The reviewer pasting them is the editor; the notes came from a
 * producer, and comments signed by the wrong person make the thread read as
 * if the editor was arguing with themselves. Defaults to the current
 * reviewer, one edit away from the truth.
 */
export function PasteNotesModal({
  durationSec, fps, defaultAuthor, onImport, onClose,
}: {
  /** Duration of the loaded cut, for disambiguating three-part timecodes. */
  durationSec?: number | null;
  fps: number;
  defaultAuthor: string;
  onImport: (rows: ImportedNote[], author: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [author, setAuthor] = useState(defaultAuthor);
  /** Explicit per-row overrides of the default tick. Cleared when the text
   *  changes, because row indexes mean nothing across a re-paste. */
  const [overrides, setOverrides] = useState<Record<number, boolean>>({});
  /** True when the box was seeded from the clipboard, so the modal can say
   *  where the text came from instead of it just being mysteriously there. */
  const [prefilled, setPrefilled] = useState(false);
  const typedRef = useRef(false);

  // The user pressed "paste notes" moments after copying them, so the paste
  // itself is a step the modal can usually skip. Read through Rust, not
  // navigator.clipboard — the web API raises macOS's confirmation modal (see
  // Toolbar's paste button, where this was learned). Gated on the clipboard
  // actually PARSING like notes: at least one timecoded line. Prefilling a
  // copied URL or a stray paragraph would read as the modal malfunctioning.
  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const clip = await invoke<string>("read_clipboard_text");
        if (stale || typedRef.current || !clip?.trim()) return;
        const rows = parseProducerNotes(clip, { durationSec: durationSec ?? undefined, fps });
        if (rows.some((r) => r.startSec != null)) {
          setText(clip);
          setPrefilled(true);
        }
      } catch {
        // No clipboard access (tests, or an empty clipboard) → an empty box,
        // which is just the modal's normal starting state.
      }
    })();
    return () => { stale = true; };
    // Mount-only: re-reading the clipboard after the user has interacted
    // would fight their editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = useMemo(
    () => parseProducerNotes(text, { durationSec: durationSec ?? undefined, fps }),
    [text, durationSec, fps],
  );
  const isChecked = (i: number) => overrides[i] ?? !rows[i].suspectHeader;
  const picked = rows.filter((_, i) => isChecked(i));

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(true, dialogRef);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (picked.length === 0) return;
    onImport(
      picked.map((r) => ({ startSec: r.startSec, endSec: r.endSec, body: r.body })),
      author.trim() || defaultAuthor,
    );
  };

  return createPortal(
    <div className="cp-modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="cp-modal cp-pastenotes"
        role="dialog"
        // Without aria-modal this modal was invisible to the app's OWN guard:
        // TranscriptViewer gates cmd+F / cmd+G on an aria-modal dialog being
        // present, so those keys reached the transcript behind the scrim.
        aria-modal="true"
        aria-label="Paste producer notes"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cp-modal-header">
          <h2>Paste notes</h2>
          <button className="cp-modal-close" onClick={onClose} title="Close (Esc)" aria-label="Close">✕</button>
        </div>

        {prefilled && (
          <div className="cp-pastenotes-prefill">
            Filled from your clipboard. Not the right text? Just paste over it.
          </div>
        )}
        <textarea
          className="cp-pastenotes-input"
          autoFocus
          value={text}
          onChange={(e) => { typedRef.current = true; setPrefilled(false); setText(e.target.value); setOverrides({}); }}
          placeholder={"Paste from a Google Doc or Sheet, one note per line.\n\n00:05 - do we have a fuller shot here?\n0:21 - 0:43 - this section drags\nAt the end, were we adding the bites?"}
          spellCheck={false}
        />

        {rows.length > 0 && (
          <>
            <div className="cp-pastenotes-count">
              {picked.length === rows.length
                ? `${rows.length} ${rows.length === 1 ? "note" : "notes"}`
                : `${picked.length} of ${rows.length} notes`}
              {" "}· click a row to skip it
            </div>
            <div className="cp-pastenotes-list">
              {rows.map((r, i) => (
                <label key={i} className={"cp-pastenotes-row" + (isChecked(i) ? "" : " off")} title={r.raw}>
                  <input
                    type="checkbox"
                    checked={isChecked(i)}
                    onChange={(e) => setOverrides((p) => ({ ...p, [i]: e.target.checked }))}
                  />
                  <span className={"cp-pastenotes-tc" + (r.startSec == null ? " general" : "")}>
                    {chipText(r.startSec, r.endSec)}
                  </span>
                  <span className="cp-pastenotes-body">{r.body}</span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="cp-pastenotes-foot">
          <label className="cp-pastenotes-author">
            <span>Notes by</span>
            <input
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder={defaultAuthor}
              spellCheck={false}
            />
          </label>
          <div className="cp-pastenotes-actions">
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={picked.length === 0}>
              {picked.length === 0 ? "Import" : `Import ${picked.length} ${picked.length === 1 ? "note" : "notes"}`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The anchor chip. A range whose ends floor to the same second ("00:08 &
 * 00:08:10") would print "0:08-0:08", which reads as a stutter, not a span —
 * the range is still imported; only the chip collapses to the single second.
 */
function chipText(startSec: number | null, endSec: number | null): string {
  if (startSec == null) return "General";
  const a = secondsToClock(startSec);
  if (endSec == null) return a;
  const b = secondsToClock(endSec);
  return a === b ? a : `${a}-${b}`;
}
