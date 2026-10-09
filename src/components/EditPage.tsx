import { pipelineInvoke } from "../lib/pipeline";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { EditSummary } from "../bindings/EditSummary";
import { editFromSequence } from "../lib/edit-new";
import { editStore, newEditId } from "../lib/edit-store";
import { formatError } from "../lib/error-format";
import { loadJson, saveJson } from "../lib/storage";
import { EditList } from "./EditList";
import { EditExportAll } from "./EditExportAll";
import { EditNewPanel } from "./EditNewPanel";
import { EditWorkspace } from "./EditWorkspace";
import { IconPlus } from "./Icons";
import { IconStringOut } from "./IconStringOut";
import { PipelinePanel } from "./PipelinePanel";
import { TabStrip } from "./TabStrip";
import { documentName } from "../lib/multitrack";
import type { EditSourceMarks } from "../hooks/use-edit-source-side";
const invoke = pipelineInvoke("String Outs");

const PANEL_ID = "cp-te-tab-panel";
/** The string out AAF Audio's "Open in String Outs" made for each sequence, by AAF Audio document id. */
const FOR_SEQUENCE_KEY = "saucebunny.stringOuts.forSequence";

type Props = {
  active: boolean; aiModelId?: string | null; onOpenSettings: (tab: "ai-apis") => void;
  /** AAF Audio asked to open this sequence here. */
  openRequest?: { documentId: string; tick: number; marks?: { in: number | null; out: number | null } | null } | null;
  /** The Pipeline at the foot of the page: one open/closed state for every page, toggled by ⌘\. */
  pipelineOpen?: boolean; onPipelineOpen?: (open: boolean) => void;
};

/**
 * String Outs, laid out like AAF Audio: the page title and its actions on
 * top, then the open string out. Every launch starts clear, on the list of
 * string outs (or the welcome, for someone who has never made one); nothing
 * reopens by itself (the owner, 2026-10-05). What is opened stays open in its
 * tab while the app runs.
 *
 * Open string outs are tabs, like sequence tabs in an NLE: the whole scene in
 * one, a person's bites made from it by Ask in the next, each exported as its
 * own AAF. A string out is open in at most one tab; closing a tab never
 * deletes anything. Only the chosen tab is mounted (its editor and sources
 * load again when chosen), as in Neo's and Premiere's timelines.
 */
export function EditPage({ active, aiModelId, onOpenSettings, openRequest, pipelineOpen = false, onPipelineOpen = () => undefined }: Props) {
  const [editId, setEditId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [edits, setEdits] = useState<EditSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    editStore.list().then((items) => {
      if (!live) return;
      setEdits(items);
      // Tabs of string outs that no longer exist close themselves.
      setTabs((open) => open.filter((id) => items.some((item) => item.id === id)));
      // The open string out no longer exists: back to the list.
      if (editId && !items.some((item) => item.id === editId)) setEditId(null);
    }).catch(() => { if (live) setEdits([]); });
    return () => { live = false; };
  }, [active, editId]);
  const open = (id: string | null) => {
    setCreating(false); setEditId(id);
    if (id) setTabs((current) => current.includes(id) ? current : [...current, id]);
  };
  /** Close a tab; closing the chosen one moves to its right-hand neighbour, else its left. */
  const close = (id: string) => {
    const at = tabs.indexOf(id), rest = tabs.filter((tab) => tab !== id);
    setTabs(rest);
    if (id === editId) setEditId(rest[at] ?? rest[at - 1] ?? null);
  };
  // AAF Audio's "Open in String Outs": that sequence's string out, made the
  // first time as Avid would start it, the sequence loaded as the source and
  // an empty record to build the cut in. Asked again, it opens the same one.
  const handled = useRef(0);
  const [opening, setOpening] = useState<string | null>(null);
  // The In and Out that came with it, for the string out's source side.
  const [carried, setCarried] = useState<EditSourceMarks | null>(null);
  useEffect(() => {
    if (!active || !openRequest || handled.current === openRequest.tick) return;
    handled.current = openRequest.tick;
    const { documentId, marks } = openRequest;
    setOpening(null);
    setCarried(marks ? { documentId, ...marks, tick: openRequest.tick } : null);
    void (async () => {
      try {
        const made = loadJson<Record<string, string>>(FOR_SEQUENCE_KEY, {});
        const existing = made[documentId];
        if (existing && (await editStore.list()).some((item) => item.id === existing)) { open(existing); return; }
        const sequence = await invoke<AafDocument>("aaf_open", { documentId });
        const id = newEditId();
        await editStore.create(id, editFromSequence(sequence, documentName(sequence)));
        saveJson(FOR_SEQUENCE_KEY, { ...made, [documentId]: id });
        setEdits(await editStore.list());
        open(id);
      } catch (cause) { setOpening(`Could not open it in String Outs: ${formatError(cause)}`); }
    })();
  }, [active, openRequest]);
  const titleOf = (id: string) => edits?.find((item) => item.id === id)?.title ?? "String out";
  // The chosen tab's title follows the edit as it is renamed (Ask's Replace names it).
  const retitle = useCallback((title: string) => setEdits((list) => list && list.some((item) => item.id === editId && item.title !== title)
    ? list.map((item) => item.id === editId ? { ...item, title } : item) : list), [editId]);
  const hasEdits = !!edits?.length;
  return <main className="cp-multitrack-page cp-te-page" aria-label="String Outs" hidden={!active}>
    <header className="cp-multitrack-page-head"><div><h1>String Outs</h1><p>Cut by the words. Send it back to Avid.</p></div>
      <div className="cp-multitrack-page-actions">
        {/* Not over the list itself, which already offers every one of them. */}
        {hasEdits && (editId || creating) && <select className="cp-select" aria-label="Open saved string out" value={editId ?? ""}
          onChange={(event) => { if (event.target.value) open(event.target.value); }}>
          <option value="">Saved string outs…</option>
          {edits?.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>}
        {tabs.length > 1 && <EditExportAll editIds={tabs} titleOf={titleOf} />}
        <button type="button" className="btn btn-ghost" onClick={() => setCreating(true)}><IconPlus size={14} />New string out…</button>
      </div>
    </header>
    {opening && <p className="cp-multitrack-error cp-multitrack-page-error" role="alert">{opening}</p>}
    {tabs.length > 0 && <div className="cp-te-tabs">
      <TabStrip tabs={tabs.map((id) => ({ id, label: titleOf(id) }))} selected={creating ? "" : editId ?? ""} onSelect={open} onClose={close}
        label="Open string outs" noun="string outs" panelId={PANEL_ID} />
    </div>}
    <div id={PANEL_ID} className="cp-te-tab-panel" role={tabs.length ? "tabpanel" : undefined} aria-label={editId && !creating ? titleOf(editId) : undefined}>
    {creating ? <EditNewPanel onOpen={open} onCancel={() => setCreating(false)} appLocalModelId={aiModelId} />
      : editId ? <EditWorkspace key={editId} editId={editId} active={active} onClose={() => open(null)} onOpenEdit={open} onTitle={retitle} sourceMarks={carried}
        onSettings={() => onOpenSettings("ai-apis")} appLocalModelId={aiModelId} />
      : edits === null ? null
      : hasEdits ? <EditList edits={edits} onOpen={open} />
      : <div className="cp-multitrack-empty"><IconStringOut size={32} /><h2>Pull the story out, bite by bite</h2>
        <p>Pick an AAF Audio sequence and cut it by its words, or make a string out for every person in the scene. It goes back to Media Composer as an AAF.</p>
        <button type="button" className="btn btn-ghost" onClick={() => setCreating(true)}>New string out…</button>
        <span>Local processing · Your AAF sequences stay untouched</span></div>}
    </div>
    <PipelinePanel page="String Outs" active={active} open={pipelineOpen} onOpenChange={onPipelineOpen} error={opening}
      emptyMessage="Nothing logged yet. Calls that wait, fail or run long appear here as they happen; Export diagnostics adds what the string out is doing and how every call has performed." />
  </main>;
}
