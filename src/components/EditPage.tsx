import { useState } from "react";
import { EditPicker } from "./EditPicker";
import { EditWorkspace } from "./EditWorkspace";

const LAST = "saucebunny.editor.lastEdit";
const readLast = () => { try { return localStorage.getItem(LAST); } catch { return null; } };
const writeLast = (id: string | null) => { try { if (id) localStorage.setItem(LAST, id); else localStorage.removeItem(LAST); } catch { /* private window */ } };

type Props = { active: boolean };

/**
 * The Transcript Editor view: the edits list, or one edit open. The last edit
 * reopens on the next visit, the way a document app picks up where you were.
 */
export function EditPage({ active }: Props) {
  const [editId, setEditId] = useState<string | null>(readLast);
  const open = (id: string | null) => { setEditId(id); writeLast(id); };
  return <main className="cp-te-page" aria-label="Transcript Editor" hidden={!active}>
    {editId ? <EditWorkspace editId={editId} active={active} onClose={() => open(null)} /> : <EditPicker onOpen={open} />}
  </main>;
}
