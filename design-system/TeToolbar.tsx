import { IconPanelLeft, IconPanelRight, IconRedo, IconUndo } from "../src/components/Icons";

type Props = {
  title: string; subtitle: string;
  sidebar: boolean; inspector: boolean; source: boolean; folded: boolean; view: "source" | "edit";
  onSidebar: () => void; onInspector: () => void; onSource: () => void; onView: (view: "source" | "edit") => void;
  undo: string | null; redo: string | null; onUndo: () => void; onRedo: () => void;
  showRemoved: boolean; onShowRemoved: () => void;
};

/**
 * The window's toolbar. Pane toggles sit at the edge their pane opens from,
 * as in Finder, Xcode and every NavigationSplitView. Undo names what it undoes.
 */
export function TeToolbar(props: Props) {
  return <header className="cp-te-toolbar">
    <button type="button" className={`cp-icon-btn${props.sidebar ? " active" : ""}`} aria-pressed={props.sidebar}
      aria-label="Sequences sidebar" title={`${props.sidebar ? "Hide" : "Show"} the sequences sidebar (Control-Command-S)`} onClick={props.onSidebar}><IconPanelLeft size={15} /></button>
    <div className="cp-te-titles">
      <h1 className="cp-te-title">{props.title}</h1>
      <span className="cp-te-subtitle">{props.subtitle}</span>
    </div>
    <span className="cp-te-proto" title="A clickable prototype: generated audio, nothing saved, nothing exported">Prototype</span>
    {props.folded
      ? <div className="cp-segmented cp-te-fold" role="radiogroup" aria-label="Pane" style={{ "--seg-count": 2, "--seg-active": props.view === "source" ? 0 : 1 } as React.CSSProperties}>
        {(["source", "edit"] as const).map((view) => <button key={view} type="button" role="radio" aria-checked={props.view === view}
          className={props.view === view ? "active" : undefined} onClick={() => props.onView(view)}>{view === "source" ? "Source" : "Edit"}</button>)}
      </div>
      : <button type="button" className={`btn btn-ghost cp-te-btn${props.source ? " is-on" : ""}`} aria-pressed={props.source} onClick={props.onSource}
        title={`${props.source ? "Hide" : "Show"} the source transcript beside the edit`}>Source</button>}
    <span className="cp-te-toolbar-gap" />
    <button type="button" className={`btn btn-ghost cp-te-btn${props.showRemoved ? " is-on" : ""}`} aria-pressed={props.showRemoved} onClick={props.onShowRemoved}
      title="Show what each cut removed, struck through, in the edit">Show removed</button>
    <div className="cp-te-history" role="group" aria-label="History">
      <button type="button" className="cp-icon-btn" disabled={!props.undo} onClick={props.onUndo}
        aria-label={props.undo ? `Undo ${props.undo}` : "Undo"} title={props.undo ? `Undo ${props.undo} (Command-Z)` : "Nothing to undo"}><IconUndo size={15} /></button>
      <button type="button" className="cp-icon-btn" disabled={!props.redo} onClick={props.onRedo}
        aria-label={props.redo ? `Redo ${props.redo}` : "Redo"} title={props.redo ? `Redo ${props.redo} (Shift-Command-Z)` : "Nothing to redo"}><IconRedo size={15} /></button>
    </div>
    <button type="button" className={`cp-icon-btn${props.inspector ? " active" : ""}`} aria-pressed={props.inspector}
      aria-label="Inspector" title={`${props.inspector ? "Hide" : "Show"} the inspector (Control-Command-I)`} onClick={props.onInspector}><IconPanelRight size={15} /></button>
  </header>;
}
