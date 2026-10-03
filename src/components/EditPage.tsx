import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { EditSummary } from "../bindings/EditSummary";
import { editFromSequence } from "../lib/edit-new";
import { editStore, newEditId } from "../lib/edit-store";
import { formatError } from "../lib/error-format";
import { LAST_STRING_OUT, recallLast, rememberLast } from "../lib/last-open";
import { loadJson, saveJson } from "../lib/storage";
import { EditList } from "./EditList";
import { EditNewPanel } from "./EditNewPanel";
import { EditWorkspace } from "./EditWorkspace";
import { IconPlus } from "./Icons";
import { IconStringOut } from "./IconStringOut";
import { TabStrip } from "./TabStrip";
import type { EditSourceMarks } from "../hooks/use-edit-source-side";

/** The string outs open as tabs, in the order they were opened. */
const TABS_KEY = "saucebunny.stringOuts.tabs";
const PANEL_ID = "cp-te-tab-panel";
/** The string out AAF Audio's "Open in String Outs" made for each sequence, by AAF Audio document id. */
const FOR_SEQUENCE_KEY = "saucebunny.stringOuts.forSequence";
const loadTabs = (): string[] => {
  const saved = loadJson<unknown>(TABS_KEY, []);
  return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === "string"))] : [];
};

type Props = {
  active: boolean; aiModelId?: string | null; onOpenSettings: (tab: "ai-apis") => void;
  /** AAF Audio asked to open this sequence here. */
  openRequest?: { documentId: string; tick: number; marks?: { in: number | null; out: number | null } | null } | null;
};

/**
 * String Outs, laid out like AAF Audio: the page title and its actions on
 * top, then the open string out. It reopens whatever was open last, so the
 * welcome shows only to someone who has never made one; after that the page
 * opens on their work or, if they closed it, on their list.
 *
 * Open string outs are tabs, like sequence tabs in an NLE: the whole scene in
 * one, a person's bites made from it by Ask in the next, each exported as its
 * own AAF. A string out is open in at most one tab; closing a tab never
 * deletes anything. Only the chosen tab is mounted (its editor and sources
 * load again when chosen), as in Neo's and Premiere's timelines.
 */
export function EditPage({ active, aiModelId, onOpenSettings, openRequest }: Props) {
  const [editId, setEditId] = useState<string | null>(() => recallLast(LAST_STRING_OUT));
  const [tabs, setTabs] = useState<string[]>(() => {
    const saved = loadTabs(), last = recallLast(LAST_STRING_OUT);
    return last && !saved.includes(last) ? [...saved, last] : saved;
  });
  useEffect(() => { saveJson(TABS_KEY, tabs); }, [tabs]);
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
      // A remembered string out that no longer exists: open the list, and stop remembering it.
      if (editId && !items.some((item) => item.id === editId)) { rememberLast(LAST_STRING_OUT, null); setEditId(null); }
    }).catch(() => { if (live) setEdits([]); });
    return () => { live = false; };
  }, [active, editId]);
  const open = (id: string | null) => {
    setCreating(false); setEditId(id); rememberLast(LAST_STRING_OUT, id);
    if (id) setTabs((current) => current.includes(id) ? current : [...current, id]);
  };
  /** Close a tab; closing the chosen one moves to its right-hand neighbour, else its left. */
  const close = (id: string) => {
    const at = tabs.indexOf(id), rest = tabs.filter((tab) => tab !== id);
    setTabs(rest);
    if (id === editId) { const next = rest[at] ?? rest[at - 1] ?? null; setEditId(next); rememberLast(LAST_STRING_OUT, next); }
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
        await editStore.create(id, editFromSequence(sequence, sequence.manifest.name, false));
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
        {hasEdits && <select className="cp-select" aria-label="Open saved string out" value={editId ?? ""}
          onChange={(event) => { if (event.target.value) open(event.target.value); }}>
          <option value="">Saved string outs…</option>
          {edits?.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>}
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
  </main>;
}
