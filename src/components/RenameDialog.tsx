import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { buildRenamePlan, type RenameItem } from "../lib/rename-pattern";
import { useModalFocus } from "../hooks/use-modal-focus";
import { loadJson, saveJson } from "../lib/storage";

/** Set once the user has been told a rename touches the file on disk. */
const DISK_ACK_KEY = "saucebunny.renameDiskAck";

/**
 * Rename one file, or a hundred, with the result visible before anything is
 * written.
 *
 * THE PREVIEW IS THE FEATURE. Bulk rename is the one Library action that can
 * destroy a day's work in a single press, so every row shows its new name and
 * its own reason for being unacceptable, and Apply is disabled until every row
 * is clean. All-or-nothing rather than "rename the good ones": a half-applied
 * batch leaves the user to work out which half, in a folder whose names just
 * changed under them.
 *
 * ONE DIALOG FOR ONE FILE AND FOR MANY. A single rename is a batch of one, and
 * giving it a separate inline-edit path would mean two implementations of the
 * collision rules, which is exactly how one of them ends up wrong.
 */
export function RenameDialog({
  items, existingNames, onCancel, onApply, failures,
}: {
  /** Files to rename, in display order. */
  items: RenameItem[];
  /** Every filename ALREADY in the same folders, so a collision with a file
   *  that was never selected is caught before the write. */
  existingNames: string[];
  onCancel: () => void;
  onApply: (rows: { path: string; to: string }[]) => void;
  /** Failures from the last attempt, by path. Keeps the dialog OPEN and shows
   *  each reason on its own row: a destructive action that did not happen must
   *  never be something the user can walk away from believing it did. */
  failures?: ReadonlyMap<string, string>;
}) {
  const single = items.length === 1;
  const [pattern, setPattern] = useState(
    // One file starts from its own name, because the common single rename is a
    // small edit. A batch starts from a token, because typing a literal name
    // for many files would give them all the same one.
    single ? (items[0].path.split("/").pop() ?? "") : "{name}",
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      // Select the STEM only, so typing replaces the name and keeps the
      // extension, the way Finder's rename field does.
      const dot = el.value.lastIndexOf(".");
      if (single && dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    });
  }, [single]);

  // Portalled behind a scrim: without this, Tab walks out of the dialog
  // into the page underneath it, and closing drops focus instead of
  // returning it. See hooks/use-modal-focus.
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, dialogRef);
  const plan = useMemo(
    () => buildRenamePlan(items, pattern, existingNames),
    [items, pattern, existingNames],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  /**
   * The one-time "this touches your disk" step.
   *
   * The preview above shows NAMES, which is exactly why this is needed: a list
   * of old -> new reads like editing labels in a library, and nothing on it says
   * the files themselves are being moved. A user who believes they are renaming
   * a catalogue entry has not agreed to what Apply actually does.
   *
   * An inline step rather than a modal over the modal. Stacking would put a
   * focus trap inside a focus trap, which SpeakerRosterModal already documents
   * as the thing to avoid - and it would cover the preview, which is the part
   * being consented to.
   */
  const [ackedDisk, setAckedDisk] = useState(() => loadJson<boolean>(DISK_ACK_KEY, false));
  const [confirming, setConfirming] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  const write = () => {
    if (!plan.ok || plan.changed === 0) return;
    onApply(plan.rows.map((r) => ({ path: r.path, to: r.to })));
  };

  const commit = () => {
    if (!plan.ok || plan.changed === 0) return;
    // First rename on this install stops here. Every one after goes straight
    // through, because a warning shown every time is a warning nobody reads.
    if (!ackedDisk) { setConfirming(true); return; }

    write();
  };

  const confirmAndWrite = () => {
    if (dontAskAgain) { saveJson(DISK_ACK_KEY, true); setAckedDisk(true); }
    setConfirming(false);
    write();
  };

  return createPortal(
    <div className="cp-modal-scrim" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="cp-rename"
        role="dialog"
        aria-modal="true"
        // Focus was already trapped here; the attribute is what the
        // app's OWN cmd+F / cmd+G guard reads, so without it those keys
        // reached the transcript search bar behind this scrim.
        aria-label={single ? "Rename file" : `Rename ${items.length} files`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cp-rename-head">
          {single ? "Rename" : `Rename ${items.length} files`}
        </div>

        <input
          ref={inputRef}
          className="cp-rename-input"
          value={pattern}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
          }}
        />

        {!single && (
          <div className="cp-rename-tokens">
            {/* Pressed, not just documented: reading that {counter:03} exists
                and typing it correctly are different acts. */}
            {["{name}", "{counter:03}", "{date}", "{duration}", "{ext}"].map((t) => (
              <button
                key={t}
                className="cp-rename-token"
                title={`Insert ${t}`}
                onClick={() => setPattern((p) => p + t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <div className="cp-rename-rows">
          {plan.rows.map((r) => (
            <div
              key={r.path}
              className={"cp-rename-row" + (r.problem || failures?.has(r.path) ? " bad" : "")}
            >
              <span className="cp-rename-from">{r.from}</span>
              <span className="cp-rename-arrow" aria-hidden="true">›</span>
              <span className="cp-rename-to">{r.to}</span>
              {(r.problem ?? failures?.get(r.path)) && (
                <span className="cp-rename-why">{r.problem ?? failures?.get(r.path)}</span>
              )}
            </div>
          ))}
        </div>

        {confirming ? (
          <div className="cp-rename-confirm" role="group" aria-label="Confirm renaming files on disk">
            {/* Says what happens to the DISK, then what survives it. The second
                half is not padding: without it this reads as "your notes may be
                lost", which is both frightening and untrue - the poster, the
                source timecode and the review are carried to the new name. */}
            <p className="cp-rename-confirm-lead">
              {plan.changed === 1
                ? "This renames the file on your Mac, not just its name in the library."
                : `This renames ${plan.changed} files on your Mac, not just their names in the library.`}
            </p>
            <p className="cp-rename-confirm-sub">
              Transcripts, review notes, posters and timecodes follow the new name.
              Anything outside Sauce Bunny that points at the old name will not.
            </p>
            <label className="cp-rename-confirm-again">
              <input
                type="checkbox"
                checked={dontAskAgain}
                onChange={(e) => setDontAskAgain(e.target.checked)}
              />
              Don&apos;t warn me again
            </label>
            <div className="cp-rename-confirm-actions">
              <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
                Back
              </button>
              <button className="btn btn-primary" onClick={confirmAndWrite}>
                {plan.changed === 1 ? "Rename the file" : `Rename ${plan.changed} files`}
              </button>
            </div>
          </div>
        ) : (
          <div className="cp-rename-foot">
            <span className="cp-rename-summary">
              {failures?.size
                ? `${failures.size} could not be renamed`
                : plan.ok
                ? (plan.changed === 0 ? "No change" : `${plan.changed} will be renamed`)
                  : `${plan.rows.filter((r) => r.problem).length} cannot be renamed`}
            </span>
            <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={!plan.ok || plan.changed === 0}
              onClick={commit}
            >
              Rename
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
