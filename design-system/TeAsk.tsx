import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { IconSparkles } from "../src/components/Icons";
import { mentionOptions, mentionQuery, type TeAgentContext, type TeLine, type TeMention, type TeReply } from "./transcript-editor-agent";

export type TeAskMessage = { id: number; role: "you" | "ask"; text: string; reply?: TeReply; applied?: boolean };

type Props = {
  context: TeAgentContext; messages: TeAskMessage[]; onSend: (text: string) => void;
  onApply: (message: TeAskMessage) => void; onJump: (line: TeLine) => void;
  colors: Record<string, string>; sourceName: (id: string) => string; lineTc: (line: TeLine) => string;
};

const starters = ["Find “onions” in @Kitchen", "Pull every line from @Rosa in @ITM", "Remove fillers from @edit", "Summarize @Judges"];

/** A sent message, with its @mentions drawn as chips. */
function Mentions({ text, options }: { text: string; options: TeMention[] }) {
  const tokens = new Set(options.map((option) => option.token.toLowerCase()));
  return <>{text.split(/(@[\w-]+)/g).map((part, index) => tokens.has(part.toLowerCase())
    ? <span key={index} className="cp-te-chip">{part}</span> : <span key={index}>{part}</span>)}</>;
}

/**
 * Ask: talk to the transcripts. Type @ to point it at a source, a person or
 * the edit. Answers cite the lines they come from, and anything that would
 * change the edit arrives as a button to apply (and undo), never as a change
 * the chat has already made.
 */
export function TeAsk(props: Props) {
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<{ start: number; query: string; index: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), log = useRef<HTMLDivElement>(null);
  const id = useId();
  // Where the caret goes after a mention is chosen. Set in the same commit as
  // the text, not a frame later, or typing straight on lands in the wrong place.
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caretAfter.current == null || !input.current) return;
    input.current.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
  }, [draft]);
  const options = mentionOptions(props.context);
  const matches = menu ? options.filter((option) => option.token.slice(1).toLowerCase().startsWith(menu.query) || option.label.toLowerCase().startsWith(menu.query)).slice(0, 8) : [];
  useEffect(() => { log.current?.lastElementChild?.scrollIntoView({ block: "end" }); }, [props.messages.length]);
  const track = (text: string, caret: number) => {
    const found = mentionQuery(text, caret);
    setMenu(found ? { ...found, index: 0 } : null);
  };
  const choose = (option: TeMention) => {
    if (!menu || !input.current) return;
    const caret = input.current.selectionStart;
    const next = `${draft.slice(0, menu.start)}${option.token} ${draft.slice(caret)}`;
    caretAfter.current = menu.start + option.token.length + 1;
    setDraft(next); setMenu(null);
    input.current.focus();
  };
  const send = (text: string) => { if (text.trim()) { props.onSend(text.trim()); setDraft(""); setMenu(null); } };
  return <section className="cp-te-ask" aria-label="Ask">
    <p className="cp-te-ask-note"><IconSparkles size={13} /> Scripted in this prototype. In the app, Ask reads the transcripts you mention with local Qwen, or Claude with your own key, and every change it suggests waits for you to apply it.</p>
    <div ref={log} className="cp-te-ask-log" role="log" aria-live="polite" aria-label="Conversation">
      {props.messages.length === 0 && <div className="cp-te-ask-starters">{starters.map((starter) =>
        <button key={starter} type="button" className="btn btn-ghost cp-te-btn" onClick={() => send(starter)}>{starter}</button>)}</div>}
      {props.messages.map((message) => <div key={message.id} className={`cp-te-msg is-${message.role}`}>
        <p className="cp-te-msg-text">{message.role === "you" ? <Mentions text={message.text} options={options} /> : message.text}</p>
        {message.reply && message.reply.lines.length > 0 && <ol className="cp-te-msg-lines">{message.reply.lines.slice(0, 12).map((line) =>
          <li key={line.words[0].id} style={{ "--te-speaker": props.colors[line.speaker] } as React.CSSProperties}>
            <button type="button" className="cp-te-msg-line" onClick={() => props.onJump(line)} title="Show this line in its source">
              <span className="cp-te-swatch" aria-hidden="true" />
              <span className="cp-te-msg-where">{props.sourceName(line.source)} · {props.lineTc(line)}</span>
              <span className="cp-te-msg-quote">{line.words.map((word) => word.text).join(" ")}</span>
            </button>
          </li>)}
          {message.reply.lines.length > 12 && <li className="cp-te-msg-more">and {message.reply.lines.length - 12} more</li>}
        </ol>}
        {message.reply?.proposal && <button type="button" className="btn cp-te-btn cp-te-msg-apply" disabled={message.applied}
          onClick={() => props.onApply(message)}>{message.applied ? "Applied. ⌘Z undoes it." : message.reply.proposal.label}</button>}
      </div>)}
    </div>
    <form className="cp-te-ask-form" onSubmit={(event) => { event.preventDefault(); send(draft); }}>
      {menu && matches.length > 0 && <ul id={`${id}-mentions`} className="cp-te-mentions" role="listbox" aria-label="Mention">
        {matches.map((option, index) => <li key={option.token} id={`${id}-m-${index}`} role="option" aria-selected={index === menu.index}
          className={index === menu.index ? "is-active" : undefined} onPointerDown={(event) => { event.preventDefault(); choose(option); }}>
          <span className="cp-te-chip">{option.token}</span><span className="cp-te-mention-kind">{option.kind === "edit" ? "This edit" : option.kind === "source" ? `Source · ${option.label}` : "Person"}</span>
        </li>)}
      </ul>}
      <label className="cp-visually-hidden" htmlFor={`${id}-input`}>Ask about the transcripts. Type @ to mention a source, a person or the edit.</label>
      <textarea id={`${id}-input`} ref={input} className="cp-te-ask-input" rows={2} value={draft} placeholder="Ask about your footage. Type @ to mention a source or person."
        role="combobox" aria-expanded={!!menu && matches.length > 0} aria-controls={`${id}-mentions`} aria-autocomplete="list"
        aria-activedescendant={menu && matches.length ? `${id}-m-${menu.index}` : undefined}
        onChange={(event) => { setDraft(event.target.value); track(event.target.value, event.target.selectionStart); }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (menu && matches.length) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); return setMenu({ ...menu, index: (menu.index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length }); }
            if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); return choose(matches[menu.index]); }
            if (event.key === "Escape") { event.preventDefault(); return setMenu(null); }
          }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(draft); }
        }} />
      <button type="submit" className="btn cp-te-btn" disabled={!draft.trim()}>Ask</button>
    </form>
  </section>;
}
