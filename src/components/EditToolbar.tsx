import type { ReactNode } from "react";
import { IconChevronLeft, IconHistory, IconRedo, IconUndo } from "./Icons";

type Props = {
  title: string; subtitle: string;
  source: boolean; onSource: () => void; history: boolean; onHistory: () => void;
  showRemoved: boolean; onShowRemoved: () => void;
  undo: string | null; redo: string | null; onUndo: () => void; onRedo: () => void;
  onClose: () => void; children?: ReactNode;
};

/**
 * The editor's toolbar. Undo and redo name what they undo, from the history
 * on disk; `children` is where Export sits.
 */
export function EditToolbar(props: Props) {
  return <header className="cp-te-toolbar">
    <button type="button" className="cp-icon-btn" aria-label="All string outs" title="All string outs" onClick={props.onClose}><IconChevronLeft size={15} /></button>
    <div className="cp-te-titles">
      <h2 className="cp-te-title">{props.title}</h2>
      <span className="cp-te-subtitle">{props.subtitle}</span>
    </div>
    <button type="button" className={`btn btn-ghost cp-te-btn${props.source ? " is-on" : ""}`} aria-pressed={props.source} onClick={props.onSource}
      title={`${props.source ? "Hide" : "Show"} the source panel`}>Source</button>
    <span className="cp-te-toolbar-gap" />
    <button type="button" className={`btn btn-ghost cp-te-btn${props.showRemoved ? " is-on" : ""}`} aria-pressed={props.showRemoved} onClick={props.onShowRemoved}
      title={`${props.showRemoved ? "Hide" : "Show"} removed lines`}>Removed lines</button>
    <div className="cp-te-history" role="group" aria-label="Undo history">
      <button type="button" className="cp-icon-btn" disabled={!props.undo} onClick={props.onUndo}
        aria-label={props.undo ? `Undo ${props.undo}` : "Undo"} title={props.undo ? `Undo ${props.undo} (⌘Z)` : "Nothing to undo"}><IconUndo size={15} /></button>
      <button type="button" className="cp-icon-btn" disabled={!props.redo} onClick={props.onRedo}
        aria-label={props.redo ? `Redo ${props.redo}` : "Redo"} title={props.redo ? `Redo ${props.redo} (⇧⌘Z)` : "Nothing to redo"}><IconRedo size={15} /></button>
      <button type="button" className={`cp-icon-btn${props.history ? " active" : ""}`} aria-pressed={props.history} onClick={props.onHistory}
        aria-label="History" title={`${props.history ? "Hide" : "Show"} history (⌘Y)`}><IconHistory size={15} /></button>
    </div>
    {props.children}
  </header>;
}
