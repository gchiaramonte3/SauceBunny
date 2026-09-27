import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../lib/ai-chat";
import { askPrompt, askRecords, cite, parseAskAnswer, scopeLines, type AskLine, type AskMention, type AskMessage } from "../lib/edit-ask";
import { formatError } from "../lib/error-format";
import { buildSourcePrefix } from "../lib/prompt-prefix";
import { chat, connectModel, contextOf, loadStringOutModel, saveStringOutModel, type StringOutModel } from "../lib/string-out-model";

type Options = {
  editId: string; lines: AskLine[]; mentions: AskMention[];
  nameOf: (track: string) => string; sourceName: (source: string) => string; appLocalModelId: string | null | undefined;
};

const KEPT = 60;
const storeKey = (editId: string) => `saucebunny.stringOuts.ask.${editId}`;
const load = (editId: string): AskMessage[] => {
  try { const raw = localStorage.getItem(storeKey(editId)); return raw ? (JSON.parse(raw) as AskMessage[]).slice(-KEPT) : []; } catch { return []; }
};
const newId = () => crypto.randomUUID();

/**
 * One conversation per string out, kept with it across launches (the last
 * sixty messages). A question is answered by the model String Outs is set
 * to; the AbortController is held before the first await, so Stop reaches a
 * cold model load as well as the answer.
 */
export function useEditAsk({ editId, lines, mentions, nameOf, sourceName, appLocalModelId }: Options) {
  const [messages, setMessages] = useState<AskMessage[]>(() => load(editId));
  const [model, setModelState] = useState<StringOutModel>(loadStringOutModel);
  const [status, setStatus] = useState<{ busy: boolean; text: string }>({ busy: false, text: "" });
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => { try { localStorage.setItem(storeKey(editId), JSON.stringify(messages.slice(-KEPT))); } catch { /* storage full: the chat lasts this session */ } }, [editId, messages]);
  useEffect(() => () => { abortRef.current?.abort(); abortRef.current = null; }, []);

  async function send(question: string) {
    if (!question.trim() || abortRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const live = () => !ctrl.signal.aborted && abortRef.current === ctrl;
    const earlier = messages;
    setMessages((list) => [...list, { id: newId(), role: "you", text: question.trim(), lines: [], action: null }]);
    setStatus({ busy: true, text: "Connecting to the model…" });
    try {
      const scoped = scopeLines(lines, question, mentions).map((line, id) => ({ ...line, id }));
      if (!scoped.length) throw new Error(lines.length ? "Nothing in the transcript matches those @ mentions." : "There is no transcript to read yet. Add a sequence with a transcript from AAF Audio.");
      const connected = await connectModel(model, appLocalModelId, ctrl.signal);
      if (!live()) return;
      const prefix = buildSourcePrefix(askRecords(scoped, nameOf, sourceName), contextOf(connected));
      if (prefix.sampled) throw new Error("That is more transcript than this model can read at once. Mention a person or a sequence with @ to narrow it, or choose a model with a larger context.");
      setStatus({ busy: true, text: `Reading with ${connected.name}…` });
      const history: ChatMessage[] = earlier.filter((message) => !message.failed).slice(-6).map((message) => message.role === "you"
        ? { role: "user", content: message.text } : { role: "assistant", content: JSON.stringify({ answer: message.text }) });
      const reply = await chat(connected, prefix.system, [...history, { role: "user", content: askPrompt(question) }], ctrl.signal);
      if (!live()) return;
      const parsed = parseAskAnswer(reply, scoped.length);
      const action = parsed.action?.kind === "build" ? { kind: "build" as const, title: parsed.action.title, lines: parsed.action.lines.map((id) => cite(scoped[id])) }
        : parsed.action ? { kind: "remove" as const, lines: parsed.action.lines.map((id) => cite(scoped[id])) } : null;
      setMessages((list) => [...list, { id: newId(), role: "ask", text: parsed.text, lines: parsed.lines.map((id) => cite(scoped[id])), action }]);
    } catch (cause) {
      if (live()) setMessages((list) => [...list, { id: newId(), role: "ask", text: formatError(cause), lines: [], action: null, failed: true }]);
    } finally {
      if (abortRef.current === ctrl) { abortRef.current = null; setStatus({ busy: false, text: "" }); }
    }
  }
  function stop() {
    abortRef.current?.abort(); abortRef.current = null;
    setStatus({ busy: false, text: "Stopped." });
  }
  return {
    messages, model, busy: status.busy, status: status.text, send, stop,
    clear: () => { stop(); setMessages([]); setStatus({ busy: false, text: "" }); },
    setModel: (next: StringOutModel) => { setModelState(next); saveStringOutModel(next); },
    markApplied: (id: string, applied: "here" | "new", createdId?: string) =>
      setMessages((list) => list.map((message) => message.id === id ? { ...message, applied, createdId } : message)),
  };
}
