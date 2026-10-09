import type { useEditWorkspace } from "../hooks/use-edit-workspace";
import { EditOvertalkPrompt } from "./EditOvertalkPrompt";

type Workspace = ReturnType<typeof useEditWorkspace>;

/**
 * The record's two guards, floating over the string out: a delete that would
 * cut someone talking underneath, and an Extract that would take words off a
 * track that is not selected. `onDone` puts focus back in the document.
 */
export function EditRecordPrompts({ ws, onDone }: { ws: Workspace; onDone: () => void }) {
  return <>
    {ws.prompt && <EditOvertalkPrompt title={`${ws.names(ws.prompt.result.crosstalk.map((word) => word.track))} talks under this.`}
      body={`Muted ${ws.names(ws.prompt.who)} only. Cutting for everyone also removes ${ws.prompt.result.crosstalk.length === 1 ? "one word" : `${ws.prompt.result.crosstalk.length} words`} of ${ws.names(ws.prompt.result.crosstalk.map((word) => word.track))}'s.`}
      keep="Keep" other="Cut for everyone" onKeep={() => { ws.setPrompt(null); onDone(); }} onDismiss={() => { ws.setPrompt(null); onDone(); }} onOther={() => ws.prompt && ws.applyDelete(ws.prompt.keys, ws.prompt.count)} />}
    {ws.extractGuard && <EditOvertalkPrompt title={`${ws.names(ws.extractGuard.who)} ${ws.extractGuard.who.length > 1 ? "talk" : "talks"} in this range.`}
      body={`Extract closes the range up on every track, so ${ws.extractGuard.count === 1 ? "one word" : `${ws.extractGuard.count} words`} on a track that is not selected would go too. Lift takes it off the selected tracks only.`}
      keep="Lift selected tracks" other="Extract anyway" onKeep={() => ws.takeMarked(false)} onDismiss={() => { ws.setExtractGuard(null); onDone(); }} onOther={() => ws.takeMarked(true, true)} />}
  </>;
}
