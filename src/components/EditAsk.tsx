import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { useEditAsk } from "../hooks/use-edit-ask";
import { mentionQuery, type AskCitation, type AskMention, type AskMessage } from "../lib/edit-ask";
import { EditAskMessage } from "./EditAskMessage";
import { EditModelMenu } from "./EditModelMenu";

type Props = {
  ask: ReturnType<typeof useEditAsk>; mentions: AskMention[]; colors: Record<string, string>; appLocalModelId: string | null | undefined;
  where: (line: AskCitation) => string; onJump: (line: AskCitation) => void; onApply: (message: AskMessage, into: "here" | "new") => void;
  onOpen: (id: string) => void; onSettings: () => void;
};

const HEIGHT = "saucebunny.stringOuts.askHeight";
const [MIN, MAX, IDEAL] = [72, 420, 120];
const clamp = (value: number) => Math.round(Math.max(MIN, Math.min(MAX, value)));
const readHeight = () => { try { return clamp(Number(localStorage.getItem(HEIGHT)) || IDEAL); } catch { return IDEAL; } };

/**
 * Ask: questions about the transcripts, answered by the model chosen here.
 * Type @ to point it at a person or a sequence. The prompt box is tall and
 * its top edge drags (or takes arrow keys) to make it taller still.
 */
export function EditAsk({ ask, mentions, colors, appLocalModelId, where, onJump, onApply, onOpen, onSettings }: Props) {
  const [draft, setDraft] = useState("");
  const [height, setHeight] = useState(readHeight);
  const [menu, setMenu] = useState<{ start: number; query: string; index: number } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null), log = useRef<HTMLDivElement>(null), caretAfter = useRef<number | null>(null);
  const id = useId();
  useLayoutEffect(() => { if (caretAfter.current != null && input.current) { input.current.setSelectionRange(caretAfter.current, caretAfter.current); caretAfter.current = null; } }, [draft]);
  // Scroll the log itself: scrollIntoView would also scroll the page around it.
  useEffect(() => { const element = log.current; if (element) element.scrollTop = element.scrollHeight; }, [ask.messages.length, ask.busy]);
  useEffect(() => { try { localStorage.setItem(HEIGHT, String(height)); } catch { /* not remembered */ } }, [height]);
  const matches = menu ? mentions.filter((item) => item.token.slice(1).toLowerCase().startsWith(menu.query) || item.label.toLowerCase().startsWith(menu.query)).slice(0, 8) : [];
  const choose = (option: AskMention) => {
    if (!menu || !input.current) return;
    const caret = input.current.selectionStart;
    caretAfter.current = menu.start + option.token.length + 1;
    setDraft(`${draft.slice(0, menu.start)}${option.token} ${draft.slice(caret)}`); setMenu(null);
    input.current.focus();
  };
  const send = () => { if (draft.trim() && !ask.busy) { void ask.send(draft); setDraft(""); setMenu(null); } };
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = event.clientY, from = height;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => setHeight(clamp(from + start - next.clientY));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  };
  return <section className="cp-te-ask" aria-label="Ask">
    <div className="cp-te-ask-head">
      <EditModelMenu value={ask.model} appLocalModelId={appLocalModelId} disabled={ask.busy} onChange={ask.setModel} onSettings={onSettings} />
      <button type="button" className="btn btn-ghost cp-te-btn" disabled={!ask.messages.length} onClick={ask.clear} title="Clear this conversation">Clear</button>
    </div>
    <div ref={log} className="cp-te-ask-log" role="log" aria-live="polite" aria-label="Conversation">
      {ask.messages.map((message) => <EditAskMessage key={message.id} message={message} colors={colors} where={where} busy={ask.busy} onJump={onJump} onApply={onApply} onOpen={onOpen}
        onRun={message.role === "you" || message.failed ? () => ask.rerun(message.id) : undefined}
        onEdit={message.role === "you" ? () => { setDraft(message.text); caretAfter.current = message.text.length; input.current?.focus(); } : undefined} />)}
      {(ask.busy || ask.status) && <p className="cp-te-ask-status" role="status">{ask.status}</p>}
    </div>
    <form className="cp-te-ask-form" style={{ "--te-ask-h": `${height}px` } as React.CSSProperties} onSubmit={(event) => { event.preventDefault(); send(); }}>
      <div className="cp-te-ask-resize cp-resize-handle horizontal" role="separator" aria-orientation="horizontal" aria-label="Prompt height"
        aria-valuemin={MIN} aria-valuemax={MAX} aria-valuenow={height} tabIndex={0} title="Drag to resize · arrow keys to nudge · Home to reset"
        onPointerDown={drag} onDoubleClick={() => setHeight(IDEAL)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 48 : 16;
          if (event.key === "ArrowUp") { event.preventDefault(); setHeight((value) => clamp(value + step)); }
          if (event.key === "ArrowDown") { event.preventDefault(); setHeight((value) => clamp(value - step)); }
          if (event.key === "Home") { event.preventDefault(); setHeight(IDEAL); }
        }} />
      {menu && matches.length > 0 && <ul id={`${id}-mentions`} className="cp-te-mentions" role="listbox" aria-label="Mention">
        {matches.map((option, index) => <li key={option.token} id={`${id}-m-${index}`} role="option" aria-selected={index === menu.index}
          className={index === menu.index ? "is-active" : undefined} onPointerDown={(event) => { event.preventDefault(); choose(option); }}>
          <span className="cp-te-chip">{option.token}</span><span className="cp-te-mention-kind">{option.kind === "person" ? "Person" : `Sequence · ${option.label}`}</span>
        </li>)}
      </ul>}
      <label className="cp-visually-hidden" htmlFor={`${id}-input`}>Ask anything. Type @ to mention a person or a sequence.</label>
      <textarea id={`${id}-input`} ref={input} className="cp-te-ask-input" value={draft} placeholder="Ask anything"
        role="combobox" aria-expanded={!!menu && matches.length > 0} aria-controls={`${id}-mentions`} aria-autocomplete="list"
        aria-activedescendant={menu && matches.length ? `${id}-m-${menu.index}` : undefined}
        onChange={(event) => { setDraft(event.target.value); const found = mentionQuery(event.target.value, event.target.selectionStart); setMenu(found ? { ...found, index: 0 } : null); }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (menu && matches.length) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); return setMenu({ ...menu, index: (menu.index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length }); }
            if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); return choose(matches[menu.index]); }
            if (event.key === "Escape") { event.preventDefault(); return setMenu(null); }
          }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); }
        }} />
      <div className="cp-te-ask-send">
        <span className="cp-te-pane-note">⏎ to send · ⇧⏎ new line · @ to mention</span>
        {ask.busy ? <button type="button" className="btn cp-te-btn" onClick={ask.stop}>Stop</button>
          : <button type="submit" className="btn cp-te-btn" disabled={!draft.trim()}>Send</button>}
      </div>
    </form>
  </section>;
}
