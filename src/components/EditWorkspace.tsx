import { useState } from "react";
import { useEditSession } from "../hooks/use-edit-session";
import { useEditSources } from "../hooks/use-edit-sources";
import { addSource } from "../lib/edit-new";
import { EditAddSource } from "./EditAddSource";
import { EditEditor } from "./EditEditor";

type Props = { editId: string; active: boolean; onClose: () => void };

/**
 * One open edit: its undo log (use-edit-session) and everything its sources
 * say (use-edit-sources), then the editor itself once the head has loaded.
 */
export function EditWorkspace({ editId, active, onClose }: Props) {
  const session = useEditSession(editId);
  const [addError, setAddError] = useState<string | null>(null);
  const data = useEditSources(session.head?.document ?? null);
  if (!session.head || !session.open) {
    return <div className="cp-te cp-te-loading">
      {session.error ? <><p className="cp-te-errors" role="alert">{session.error}</p><button type="button" className="btn btn-ghost" onClick={onClose}>All edits</button></>
        : <p className="cp-te-pane-note" role="status">Opening the edit…</p>}
    </div>;
  }
  const document = session.head.document;
  return <>
    <EditEditor key={editId} editId={editId} head={session.head} open={session.open} history={session.history} data={data} active={active}
      commit={session.commit} undo={() => void session.undo()} redo={() => void session.redo()} jump={(state) => void session.jump(state)}
      pin={(state, name) => void session.pin(state, name)} onClose={onClose}
      addSource={<EditAddSource exclude={document.sources.map((source) => source.document_id)} onError={setAddError}
        onAdd={(aaf) => { setAddError(null); void session.commit(`Add ${aaf.manifest.name}`, (open) => ({ document: addSource(open.document, aaf) })); }} />} />
    {(session.error || addError) && <p className="cp-te-errors cp-te-session-error" role="alert">{session.error ?? addError}</p>}
  </>;
}
