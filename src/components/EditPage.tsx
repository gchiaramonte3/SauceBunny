import { useEffect, useState } from "react";
import type { EditSummary } from "../bindings/EditSummary";
import { editStore } from "../lib/edit-store";
import { LAST_STRING_OUT, recallLast, rememberLast } from "../lib/last-open";
import { EditList } from "./EditList";
import { EditNewPanel } from "./EditNewPanel";
import { EditWorkspace } from "./EditWorkspace";
import { IconPlus } from "./Icons";
import { IconStringOut } from "./IconStringOut";

type Props = { active: boolean; aiModelId?: string | null; onOpenSettings: (tab: "ai-apis") => void };

/**
 * String Outs, laid out like AAF Audio: the page title and its actions on
 * top, then the open string out. It reopens whatever was open last, so the
 * welcome shows only to someone who has never made one; after that the page
 * opens on their work or, if they closed it, on their list.
 */
export function EditPage({ active, aiModelId, onOpenSettings }: Props) {
  const [editId, setEditId] = useState<string | null>(() => recallLast(LAST_STRING_OUT));
  const [edits, setEdits] = useState<EditSummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!active) return;
    let live = true;
    editStore.list().then((items) => {
      if (!live) return;
      setEdits(items);
      // A remembered string out that no longer exists: open the list, and stop remembering it.
      if (editId && !items.some((item) => item.id === editId)) { rememberLast(LAST_STRING_OUT, null); setEditId(null); }
    }).catch(() => { if (live) setEdits([]); });
    return () => { live = false; };
  }, [active, editId]);
  const open = (id: string | null) => { setCreating(false); setEditId(id); rememberLast(LAST_STRING_OUT, id); };
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
    {creating ? <EditNewPanel onOpen={open} onCancel={() => setCreating(false)} appLocalModelId={aiModelId} />
      : editId ? <EditWorkspace key={editId} editId={editId} active={active} onClose={() => open(null)} onOpenEdit={open}
        onSettings={() => onOpenSettings("ai-apis")} appLocalModelId={aiModelId} />
      : edits === null ? null
      : hasEdits ? <EditList edits={edits} onOpen={open} />
      : <div className="cp-multitrack-empty"><IconStringOut size={32} /><h2>Pull the story out, bite by bite</h2>
        <p>Pick an AAF Audio sequence and cut it by its words, or make a string out for every person in the scene. It goes back to Media Composer as an AAF.</p>
        <button type="button" className="btn btn-ghost" onClick={() => setCreating(true)}>New string out…</button>
        <span>Local processing · Your AAF sequences stay untouched</span></div>}
  </main>;
}
