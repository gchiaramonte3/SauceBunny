import { IconPanelLeft, IconPanelRight, IconRedo, IconSparkles, IconUndo } from "../src/components/Icons";

type Props = {
  title: string; subtitle: string;
  left: boolean; source: boolean; right: boolean;
  onLeft: () => void; onSource: () => void; onRight: () => void; onAsk: () => void;
  undo: string | null; redo: string | null; onUndo: () => void; onRedo: () => void;
  showRemoved: boolean; onShowRemoved: () => void;
};

/**
 * The window's toolbar. Panel toggles sit at the edge their panel opens
 * from, as in Finder, Xcode and every NavigationSplitView. Undo names what it
 * undoes.
 */
export function TeToolbar(props: Props) {
  return <header className="cp-te-toolbar">
    <button type="button" className={`cp-icon-btn${props.left ? " active" : ""}`} aria-pressed={props.left}
      aria-label="Left panel" title={`${props.left ? "Hide" : "Show"} the left panel (Control-Command-S)`} onClick={props.onLeft}><IconPanelLeft size={15} /></button>
    <div className="cp-te-titles">
      <h1 className="cp-te-title">{props.title}</h1>
      <span className="cp-te-subtitle">{props.subtitle}</span>
    </div>
    <span className="cp-te-proto" title="A clickable prototype: generated audio, nothing saved, nothing exported">Prototype</span>
    <button type="button" className={`btn btn-ghost cp-te-btn${props.source ? " is-on" : ""}`} aria-pressed={props.source} onClick={props.onSource}
      title={`${props.source ? "Hide" : "Show"} the source panel beside the edit`}>Source</button>
    <span className="cp-te-toolbar-gap" />
    <button type="button" className={`btn btn-ghost cp-te-btn${props.showRemoved ? " is-on" : ""}`} aria-pressed={props.showRemoved} onClick={props.onShowRemoved}
      title="Show removed lines struck through where they were, ready to restore">Removed lines</button>
    <button type="button" className="btn btn-ghost cp-te-btn" onClick={props.onAsk} title="Ask about your transcripts (Command-K)"><IconSparkles size={13} />Ask</button>
    <div className="cp-te-history" role="group" aria-label="History">
      <button type="button" className="cp-icon-btn" disabled={!props.undo} onClick={props.onUndo}
        aria-label={props.undo ? `Undo ${props.undo}` : "Undo"} title={props.undo ? `Undo ${props.undo} (Command-Z)` : "Nothing to undo"}><IconUndo size={15} /></button>
      <button type="button" className="cp-icon-btn" disabled={!props.redo} onClick={props.onRedo}
        aria-label={props.redo ? `Redo ${props.redo}` : "Redo"} title={props.redo ? `Redo ${props.redo} (Shift-Command-Z)` : "Nothing to redo"}><IconRedo size={15} /></button>
    </div>
    <button type="button" className={`cp-icon-btn${props.right ? " active" : ""}`} aria-pressed={props.right}
      aria-label="Right panel" title={`${props.right ? "Hide" : "Show"} the right panel (Control-Command-I)`} onClick={props.onRight}><IconPanelRight size={15} /></button>
  </header>;
}
