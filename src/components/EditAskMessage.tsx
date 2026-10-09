import { useEffect, useState } from "react";
import type { AskCitation, AskMessage } from "../lib/edit-ask";
import { copyText } from "../lib/clipboard";
import { EditAskCut } from "./EditAskCut";
import { IconClipboard, IconPencil, IconRefresh } from "./Icons";

type Props = {
  message: AskMessage; colors: Record<string, string>; where: (line: AskCitation) => string; busy: boolean;
  onJump: (line: AskCitation) => void; onApply: (message: AskMessage, into: "here" | "new") => void; onOpen: (id: string) => void;
  /** Ask this question again (a question), or the question this failed answer was to. */
  onRun?: () => void;
  /** Put this question back in the prompt box to change it. */
  onEdit?: () => void;
};

const SHOWN = 12;

/**
 * One turn of the conversation. Cited lines are buttons that take you to
 * where they were said. A proposed change is never made by the chat itself:
 * a build or a story cut lands as a NEW string out by default, with replacing
 * this one as the other choice; a removal applies here by default, or into a
 * copy.
 */
export function EditAskMessage({ message, colors, where, busy, onJump, onApply, onOpen, onRun, onEdit }: Props) {
  const action = message.action;
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(false), 1500); return () => window.clearTimeout(timer); }, [copied]);
  // An answer copies with the lines it cites, each with where it was said, so it pastes as notes.
  const copy = () => void copyText([message.text, ...message.lines.map((line) => `${where(line)}  ${line.text}`)].join("\n"))
    .then(() => setCopied(true)).catch(() => undefined);
  const lines = (list: AskCitation[]) => <ol className="cp-te-msg-lines">
    {list.slice(0, SHOWN).map((line) => <li key={line.wordIds[0]} style={{ "--te-speaker": colors[line.track] } as React.CSSProperties}>
      <button type="button" className="cp-te-msg-line" onClick={() => onJump(line)} title="Show where this was said">
        <span className="cp-te-swatch" aria-hidden="true" />
        <span className="cp-te-msg-where">{where(line)}</span>
        <span className="cp-te-msg-quote">{line.text}</span>
      </button>
    </li>)}
    {list.length > SHOWN && <li className="cp-te-msg-more">and {list.length - SHOWN} more</li>}
  </ol>;
  const you = message.role === "you";
  return <div className={`cp-te-msg is-${message.role}${message.failed ? " is-failed" : ""}`}>
    <p className="cp-te-msg-text" role={message.failed ? "alert" : undefined}>{message.text}</p>
    <div className="cp-te-msg-tools">
      <button type="button" className="cp-te-msg-tool" onClick={copy}>
        <IconClipboard size={12} /><span>{copied ? "Copied" : "Copy"}</span></button>
      {onEdit && <button type="button" className="cp-te-msg-tool" onClick={onEdit}><IconPencil size={12} /><span>Edit</span></button>}
      {onRun && <button type="button" className="cp-te-msg-tool" disabled={busy} onClick={onRun}>
        <IconRefresh size={12} /><span>{you ? "Run again" : "Try again"}</span></button>}
    </div>
    {message.lines.length > 0 && lines(message.lines)}
    {action && <div className="cp-te-msg-action">
      {action.kind === "cut" ? <EditAskCut title={action.title} target={action.target} beats={action.beats} lines={lines} /> : <>
        <p className="cp-te-msg-proposal">{action.kind === "build"
          ? `Build "${action.title}": ${action.lines.length} bite${action.lines.length === 1 ? "" : "s"}`
          : `Remove ${action.lines.length} line${action.lines.length === 1 ? "" : "s"} from this string out`}</p>
        {lines(action.lines)}
      </>}
      {message.applied ? <p className="cp-te-msg-done">
        {message.applied === "here" ? "Applied here. ⌘Z undoes it." : "Made as a new string out."}
        {message.createdId && <button type="button" className="btn btn-ghost cp-te-btn" onClick={() => onOpen(message.createdId!)}>Open it</button>}
      </p>
        : <div className="cp-te-msg-buttons">
          {action.kind !== "remove" ? <>
            <button type="button" className="btn cp-te-btn" disabled={busy} onClick={() => onApply(message, "new")}>Make new string out</button>
            <button type="button" className="btn btn-ghost cp-te-btn" disabled={busy} onClick={() => onApply(message, "here")}>Replace this one</button>
          </> : <>
            <button type="button" className="btn cp-te-btn" disabled={busy} onClick={() => onApply(message, "here")}>Remove here</button>
            <button type="button" className="btn btn-ghost cp-te-btn" disabled={busy} onClick={() => onApply(message, "new")}>Into a copy</button>
          </>}
        </div>}
    </div>}
  </div>;
}
