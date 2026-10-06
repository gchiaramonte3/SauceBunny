import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";
import { formatError } from "../lib/error-format";
import { sequenceLabels } from "../lib/multitrack";
import { pipelineInvoke } from "../lib/pipeline";
import { plural } from "../lib/plural";
import { RECENT_SEQUENCES, hiddenCount, hideSequences, loadHiddenSequences, sequenceShelf, showHiddenSequences } from "../lib/sequence-shelf";
import { IconChevronDown } from "./Icons";
const invoke = pipelineInvoke("String Outs");

type Props = { exclude: string[]; onAdd: (document: AafDocument) => void; onError: (message: string) => void };

const fileOf = (path: string) => path.split("/").pop() || path;
const day = (ms?: number) => ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : null;

/**
 * Add an AAF Audio sequence to the edit as another source. Its people join
 * the lanes they already have, by name, so Rosa's mic in every sequence plays
 * on Rosa's lane.
 *
 * Our own menu rather than a native select: macOS drew that at the control,
 * as wide as the longest name, with every sequence ever imported and no way
 * to take one out. This one opens to the left under its button, newest first,
 * and a sequence can be removed from the list (× or Delete) or the list
 * cleared, which hides and deletes nothing (lib/sequence-shelf).
 */
export function EditAddSource({ exclude, onAdd, onError }: Props) {
  const [saved, setSaved] = useState<AafDocumentSummary[]>([]);
  const [hidden, setHidden] = useState(loadHiddenSequences);
  const [open, setOpen] = useState(false), [all, setAll] = useState(false), [tick, setTick] = useState(0);
  const box = useRef<HTMLDivElement>(null), menu = useRef<HTMLDivElement>(null), focusNext = useRef<string | null>(null);
  const close = useCallback(() => { setOpen(false); setAll(false); }, []);
  useDismiss(box, close, open);
  useMenuKeys(menu, open, close);
  // A sequence saved in AAF Audio while this is open joins the list, and one
  // hidden from it comes back the same way.
  useEffect(() => {
    const onSaucebunnyMultitrackChanged = () => setTick((value) => value + 1);
    const subscription = listen("saucebunny:multitrack-changed", onSaucebunnyMultitrackChanged).catch(() => null);
    return () => { void subscription.then((unlisten) => unlisten?.()); };
  }, []);
  useEffect(() => {
    let live = true;
    invoke<AafDocumentSummary[]>("aaf_list").then((items) => { if (live) setSaved(items); }).catch(() => undefined);
    return () => { live = false; };
  }, [tick]);
  const labels = useMemo(() => sequenceLabels(saved), [saved]);
  const choices = sequenceShelf(saved, hidden).filter((item) => !exclude.includes(item.id));
  const shown = all ? choices : choices.slice(0, RECENT_SEQUENCES), more = choices.length - shown.length, hiddenNow = hiddenCount(saved, hidden);
  // A removed row or Show more takes away what held focus: keep the keyboard
  // in the menu, on the row that follows. (WebKit does not focus a clicked
  // button, so this cannot wait for focus to have left.)
  useEffect(() => {
    const root = menu.current, wanted = focusNext.current;
    focusNext.current = null;
    if (!open || !root) return;
    const target = wanted ? root.querySelector<HTMLElement>(`[data-sequence="${wanted}"]`) : null;
    if (target) target.focus();
    else if (!root.contains(document.activeElement)) root.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  });
  const remove = (items: AafDocumentSummary[], next?: string) => { focusNext.current = next ?? null; setHidden(hideSequences(items, saved, hidden)); };
  const add = (id: string) => { close(); invoke<AafDocument>("aaf_open", { documentId: id }).then(onAdd).catch((cause: unknown) => onError(formatError(cause))); };
  const title = choices.length ? "Add an AAF Audio sequence to cut from" : !saved.length ? "No AAF Audio sequences yet. Import one in AAF Audio."
    : hiddenNow ? "Every other sequence is hidden from this list" : "Every AAF Audio sequence is already in this string out";
  return <div ref={box} className="cp-view-options cp-te-add">
    <button type="button" className={`btn btn-ghost cp-te-btn${open ? " is-on" : ""}`} aria-haspopup="menu" aria-expanded={open} title={title}
      disabled={!choices.length && !hiddenNow} onClick={() => (open ? close() : setOpen(true))}>Add sequence<IconChevronDown size={12} /></button>
    {open && <div ref={menu} className="cp-view-popover cp-te-add-menu" role="menu" aria-label="Add a sequence">
      {shown.map((item, index) => {
        const name = labels.get(item.id) ?? item.name, next = shown[index + 1]?.id ?? shown[index - 1]?.id;
        return <div key={item.id} className="cp-te-add-row" role="none">
          <button type="button" role="menuitem" className="cp-popover-item" data-sequence={item.id} title={name} aria-keyshortcuts="Delete" onClick={() => add(item.id)}
            onKeyDown={(event) => { if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove([item], next); } }}>
            <span className="lbl">{name}</span>
            <span className="sub">{[fileOf(item.source_path), day(item.modified_ms)].filter(Boolean).join(" · ")}</span>
          </button>
          <button type="button" className="cp-icon-btn cp-te-add-remove" tabIndex={-1} aria-label={`Remove ${name} from this list`} title={`Remove ${name} from this list (Delete)`}
            onClick={() => remove([item], next)}>×</button>
        </div>;
      })}
      {more > 0 && <button type="button" role="menuitem" className="cp-popover-item" onClick={() => { focusNext.current = choices[shown.length].id; setAll(true); }}>
        <span className="lbl">Show {more.toLocaleString()} more</span></button>}
      {!choices.length && <p className="cp-te-add-empty">{saved.length ? "Nothing else to add." : "No AAF Audio sequences yet."}</p>}
      <div className="cp-te-add-sep" role="separator" />
      {choices.length > 0 && <button type="button" role="menuitem" className="cp-popover-item" title="Hide every sequence in this list. Nothing is deleted, and a sequence comes back when it is saved again in AAF Audio"
        onClick={() => remove(choices)}><span className="lbl">Clear list</span></button>}
      {hiddenNow > 0 && <button type="button" role="menuitem" className="cp-popover-item" onClick={() => setHidden(showHiddenSequences())}>
        <span className="lbl">Show {plural(hiddenNow, "hidden sequence", "hidden sequences")}</span></button>}
    </div>}
  </div>;
}
