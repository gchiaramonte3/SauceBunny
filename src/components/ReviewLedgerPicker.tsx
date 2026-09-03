import { useRef, useState } from "react";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { ALL_NOTES, lensCount, lensLabel, type Ledger, type LedgerLens } from "../lib/review-ledger";
import { IconChevronDown } from "./Icons";

/**
 * Going back through the sessions this source has been reviewed in.
 *
 * The control is deliberately quiet and deliberately NOT a filter chip: it
 * names what you are currently reading, which is "All notes" until you choose
 * otherwise. That default is the important half. Scoping to the current
 * session by default would answer the complaint that started this ("I began a
 * second session and the first one's notes were still there") by hiding work
 * someone did, and a review tool that hides notes by default is worse than one
 * that shows too many.
 *
 * So: everything is visible until you ask for less, and asking for less is one
 * click. The count beside each row is what makes the list worth opening - it
 * is how you tell the session where the real pass happened from the one where
 * two things were said.
 */

function when(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function ReviewLedgerPicker({ ledger, lens, onPick, totalRoots }: {
  ledger: Ledger;
  lens: LedgerLens;
  onPick: (lens: LedgerLens) => void;
  /** Root-comment count of the whole doc, for the "All notes" row. */
  totalRoots: number;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useDismiss(wrapRef, () => setOpen(false), open);
  useMenuKeys(menuRef, open, () => setOpen(false));

  // Nothing to go back THROUGH: this source has only ever been reviewed one
  // way. A chevron that opens a list of one is furniture.
  if (ledger.sessions.length === 0) return null;

  const choose = (l: LedgerLens) => { onPick(l); setOpen(false); };
  const row = (l: LedgerLens, title: string, meta: string, key: string) => {
    const active = l.kind === lens.kind
      && (l.kind !== "session" || (lens.kind === "session" && l.id === lens.id));
    return (
      <button
        key={key}
        type="button"
        role="menuitem"
        className={"cp-ledger-item" + (active ? " active" : "")}
        aria-current={active ? "true" : undefined}
        onClick={() => choose(l)}
      >
        <span className="cp-ledger-item-title">{title}</span>
        <span className="cp-ledger-item-meta">{meta}</span>
      </button>
    );
  };

  return (
    <div className="cp-review-ledger" ref={wrapRef}>
      <button
        type="button"
        className={"cp-ledger-btn" + (lens.kind === "all" ? "" : " scoped")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Which session's notes to show"
      >
        <span className="cp-ledger-btn-label">{lensLabel(lens, ledger)}</span>
        <IconChevronDown size={12} />
      </button>
      {open && (
        <div className="cp-ledger-menu" role="menu" ref={menuRef}>
          {row(ALL_NOTES, "All notes",
            `${totalRoots} note${totalRoots === 1 ? "" : "s"}`, "all")}
          {/* Newest first: a ledger is read backwards. */}
          {ledger.sessions.map((s) => row(
            { kind: "session", id: s.id },
            s.title || "Untitled session",
            `${when(s.startedAt)} · ${s.commentIds.size} note${s.commentIds.size === 1 ? "" : "s"}`
              + (s.participants.length ? ` · ${s.participants.join(", ")}` : ""),
            s.id,
          ))}
          {/* Only when there ARE such notes: an empty bucket is a question the
              user did not ask. */}
          {ledger.soloIds.size > 0 && row(
            { kind: "solo" }, "Outside a session",
            `${lensCount({ kind: "solo" }, ledger, totalRoots)} note`
              + (ledger.soloIds.size === 1 ? "" : "s"),
            "solo",
          )}
        </div>
      )}
    </div>
  );
}
