import { useMemo } from "react";
import type { EditDocument } from "../bindings/EditDocument";
import type { EditHistory } from "../bindings/EditHistory";
import { useEditAsk } from "../hooks/use-edit-ask";
import type { EditChange } from "../hooks/use-edit-session";
import type { useEditWorkspace } from "../hooks/use-edit-workspace";
import { askLines, askMentions, type AskCitation, type AskMessage } from "../lib/edit-ask";
import { appState } from "../lib/edit-ask-tools";
import { fromDocument, toDocument, type OpenEdit } from "../lib/edit-document";
import { removeWithoutCuttingOvertalk, type TimelineLane, type TimelineWord } from "../lib/edit-model";
import { editStore, newEditId } from "../lib/edit-store";
import { layoutEditBites } from "../lib/edit-stringout";
import { cutSeconds, layoutStoryCut } from "../lib/edit-story";
import { secondsToClock } from "../lib/timecode";
import { formatError } from "../lib/error-format";
import { EditAsk } from "./EditAsk";
import { EditHistoryPanel } from "./EditHistoryPanel";
import { EditInspector } from "./EditInspector";

export type EditSideTab = "ask" | "inspector" | "history";
const TABS: { id: EditSideTab; label: string }[] = [{ id: "ask", label: "Ask" }, { id: "inspector", label: "Inspector" }, { id: "history", label: "History" }];

type Props = {
  editId: string; document: EditDocument; words: TimelineWord[]; used: Set<string>; lengths: Record<string, number>;
  lanes: TimelineLane[]; colors: Record<string, string>; ws: ReturnType<typeof useEditWorkspace>;
  tab: EditSideTab; onTab: (tab: EditSideTab) => void; history: EditHistory | null; jump: (state: number) => void; pin: (state: number, name: string | null) => void;
  commit: (label: string, change: (open: OpenEdit) => EditChange, group?: string | null) => Promise<boolean>;
  tc: (seconds: number) => string; sourceName: (source: string) => string; nameOf: (track: string) => string; where: (line: AskCitation) => string;
  sourceTc?: (source: string, seconds: number) => string;
  onJump: (line: AskCitation) => void; onOpenEdit: (id: string) => void; onSettings: () => void; appLocalModelId: string | null | undefined;
};

/** The left column: Ask, then the Inspector, then History. */
export function EditSidePanel(props: Props) {
  const { document, words, ws } = props;
  const lines = useMemo(() => askLines(words, props.used), [words, props.used]);
  // Ask reads everyone, but a cut weighs overtalk only from people on a
  // track: a group angle nobody hears cannot talk over anyone.
  const heard = useMemo(() => {
    const on = new Set(props.lanes.filter((lane) => lane.track > 0).map((lane) => lane.id));
    return words.filter((word) => on.has(word.track));
  }, [words, props.lanes]);
  const mentions = useMemo(() => askMentions(props.lanes, document.sources), [props.lanes, document.sources]);
  const ask = useEditAsk({ editId: props.editId, lines, mentions, nameOf: props.nameOf, sourceName: props.sourceName, appLocalModelId: props.appLocalModelId, sourceTc: props.sourceTc,
    document, words, screen: () => appState({ editId: props.editId, document, selected: ws.selected, caret: ws.placed[ws.caretNow()], marks: ws.marks, tc: props.tc }) });
  /** A proposal lands here as one undo step, or as a new string out that leaves this one alone. */
  const apply = async (message: AskMessage, into: "here" | "new") => {
    const action = message.action;
    if (!action) return;
    try {
      let next: EditDocument, done = "";
      if (action.kind === "build" || action.kind === "cut") {
        if (action.kind === "build") next = layoutEditBites(document, action.lines, action.title, props.lengths, words);
        else {
          // A story cut: beats laid out tight, fillers taken out (edit-story.ts).
          const laid = layoutStoryCut(document, { title: action.title, target: action.target, beats: action.beats }, props.lengths, words);
          next = laid.document;
          done = `Built "${action.title}", ${secondsToClock(cutSeconds(next), { round: true })}${laid.trimmed
            ? `, with ${laid.trimmed} filler word${laid.trimmed === 1 ? "" : "s"} taken out (Removed lines shows them, and Restore puts any back)` : ""}.`;
        }
        if (into === "here") {
          const opened = fromDocument(next);
          if (await props.commit(`Ask: ${action.title}`, () => ({ document: next, timeline: opened.timeline, markers: opened.markers }))) {
            ask.markApplied(message.id, "here");
            if (done) ws.setMessage(done);
          }
          return;
        }
      } else {
        const ids = new Set(action.lines.flatMap((line) => line.wordIds));
        if (into === "here") {
          if (await props.commit("Ask: Remove Lines", (state) => ({ timeline: removeWithoutCuttingOvertalk(heard, state.timeline, ids) }))) ask.markApplied(message.id, "here");
          return;
        }
        const opened = fromDocument(document);
        next = toDocument({ ...document, title: `${document.title}, without ${action.lines.length} line${action.lines.length === 1 ? "" : "s"}` },
          removeWithoutCuttingOvertalk(heard, opened.timeline, ids), opened.markers);
      }
      const id = newEditId();
      await editStore.create(id, next);
      ask.markApplied(message.id, "new", id);
      if (done) ws.setMessage(done);
      // The new string out opens in a tab of its own; this one stays in its tab.
      props.onOpenEdit(id);
    } catch (cause) {
      ws.setMessage(`Could not apply: ${formatError(cause)}`);
    }
  };
  return <div className="cp-te-side">
    <div className="cp-te-side-tabs" role="tablist" aria-label="String out panels">
      {TABS.map((tab) => <button key={tab.id} type="button" role="tab" id={`cp-te-side-${tab.id}`} aria-controls="cp-te-side-body" aria-selected={props.tab === tab.id}
        tabIndex={props.tab === tab.id ? 0 : -1} className={`cp-te-side-tab${props.tab === tab.id ? " is-on" : ""}`} onClick={() => props.onTab(tab.id)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const index = TABS.findIndex((item) => item.id === props.tab), next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
          props.onTab(next.id);
          window.document.getElementById(`cp-te-side-${next.id}`)?.focus();
        }}>{tab.label}</button>)}
    </div>
    <div id="cp-te-side-body" className="cp-te-side-body" role="tabpanel" aria-labelledby={`cp-te-side-${props.tab}`}>
      {props.tab === "ask" && <EditAsk ask={ask} mentions={mentions} colors={props.colors} appLocalModelId={props.appLocalModelId} where={props.where}
        onJump={props.onJump} onApply={(message, into) => void apply(message, into)} onOpen={props.onOpenEdit} onSettings={props.onSettings} />}
      {props.tab === "inspector" && <EditInspector ws={ws} words={words} lanes={props.lanes} colors={props.colors} tc={props.tc} sourceName={props.sourceName} />}
      {props.tab === "history" && (props.history ? <EditHistoryPanel history={props.history} onJump={props.jump} onPin={props.pin} />
        : <p className="cp-te-pane-note" role="status">Reading the history…</p>)}
    </div>
  </div>;
}
