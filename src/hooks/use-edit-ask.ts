import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import type { AssistantReply } from "../bindings/AssistantReply";
import type { EditDocument } from "../bindings/EditDocument";
import type { ChatMessage } from "../lib/ai-chat";
import { loadCloudModel, serviceTier } from "../lib/ai-provider";
import { citeAddress, parseToolsAnswer, toolsHistory, toolsQuestion, toolsSystem } from "../lib/edit-ask-tools";
import type { TimelineWord } from "../lib/edit-model";
import { askBuildTitle, askFindPrompt, askMentioned, askParts, askPrompt, asksToBuild, askRecords, cite, parseAskAnswer, parseAskFind, scopeLines, type AskCitation, type AskLine, type AskMention, type AskMessage } from "../lib/edit-ask";
import { formatError } from "../lib/error-format";
import { buildSourcePrefix, transcriptBudget } from "../lib/prompt-prefix";
import { chat, connectModel, contextOf, loadStringOutModel, saveStringOutModel, type AskModel, type StringOutModel } from "../lib/string-out-model";

type Options = {
  editId: string; lines: AskLine[]; mentions: AskMention[];
  nameOf: (track: string) => string; sourceName: (source: string) => string; appLocalModelId: string | null | undefined;
  /** A source position as that source's timecode, which is what the editor reads everywhere else. */
  sourceTc?: (source: string, seconds: number) => string;
  /** The string out and everyone's words, which turn the addresses a model cites back into lines here. */
  document: EditDocument; words: TimelineWord[];
  /** What is on screen now, for the model's get_app_state. */
  screen: () => unknown;
};

/** Claude and ChatGPT look things up with tools; of the local models, Qwen can (its chat template carries tools) and the rest read the transcript as before. */
const usesTools = (model: AskModel) => model.kind === "cloud" || /qwen/i.test(model.server.model_id);

/** The Transcripts library when the user moved it (Settings ▸ General), for the model's library tools. */
function transcriptLibrary(): string | null {
  try { const saved = JSON.parse(localStorage.getItem("cp-defaults-v2") ?? "{}") as { transcriptLibrary?: unknown }; return typeof saved.transcriptLibrary === "string" && saved.transcriptLibrary ? saved.transcriptLibrary : null; }
  catch { return null; }
}

const KEPT = 60;
const storeKey = (editId: string) => `saucebunny.stringOuts.ask.${editId}`;
const load = (editId: string): AskMessage[] => {
  try { const raw = localStorage.getItem(storeKey(editId)); return raw ? (JSON.parse(raw) as AskMessage[]).slice(-KEPT) : []; } catch { return []; }
};
const save = (editId: string, messages: AskMessage[]) => {
  try { localStorage.setItem(storeKey(editId), JSON.stringify(messages.slice(-KEPT))); } catch { /* storage full: the chat lasts this session */ }
};
const newId = () => crypto.randomUUID();

/**
 * One conversation per string out, kept with it across launches (the last
 * sixty messages). A question is answered by the model String Outs is set
 * to; the AbortController is held before the first await, so Stop reaches a
 * cold model load as well as the answer.
 */
export function useEditAsk({ editId, lines, mentions, nameOf, sourceName, appLocalModelId, sourceTc, document, words, screen }: Options) {
  const [messages, setMessages] = useState<AskMessage[]>(() => load(editId));
  const [model, setModelState] = useState<StringOutModel>(loadStringOutModel);
  const [status, setStatus] = useState<{ busy: boolean; text: string }>({ busy: false, text: "" });
  const abortRef = useRef<AbortController | null>(null);
  const latest = useRef(messages); latest.current = messages;
  useEffect(() => save(editId, messages), [editId, messages]);
  useEffect(() => () => { abortRef.current?.abort(); abortRef.current = null; }, []);

  async function send(question: string) {
    if (!question.trim() || abortRef.current) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    // Stop reaches the tool loop in Rust through the same cancel as a cloud chat.
    const requestId = crypto.randomUUID();
    ctrl.signal.addEventListener("abort", () => void invoke("cloud_chat_cancel", { requestId }).catch(() => undefined), { once: true });
    const live = () => !ctrl.signal.aborted && abortRef.current === ctrl;
    const earlier = messages;
    setMessages((list) => [...list, { id: newId(), role: "you", text: question.trim(), lines: [], action: null }]);
    setStatus({ busy: true, text: "Connecting to the model…" });
    try {
      const connected = await connectModel(model, appLocalModelId, ctrl.signal);
      if (!live()) return;
      if (usesTools(connected)) {
        try {
          setStatus({ busy: true, text: `Looking through the transcripts with ${connected.name}…` });
          const reply = await invoke<AssistantReply>("assistant_chat", { args: {
            provider: connected.kind === "cloud" ? connected.provider : "local", model: connected.kind === "cloud" ? loadCloudModel(connected.provider) : connected.server.model_id,
            system: toolsSystem(document, editId), messages: [...toolsHistory(earlier, document), { role: "user", content: toolsQuestion(question, askMentioned(question, mentions), sourceName) }],
            app_state: screen(), library: transcriptLibrary(), request_id: requestId, service_tier: connected.kind === "cloud" ? serviceTier(connected.provider) : null } });
          if (!live()) return;
          const parsed = parseToolsAnswer(reply.text);
          const cited = (list: string[]) => list.map((address) => citeAddress(address, document, words)).filter((line): line is AskCitation => !!line);
          // Asked to build, the model cited lines but proposed nothing: offer the build from its lines.
          const proposed = parsed.action ?? (parsed.lines.length && asksToBuild(question) ? { kind: "build" as const, title: askBuildTitle(question, mentions), lines: parsed.lines } : null);
          const action = proposed?.kind === "build" ? { kind: "build" as const, title: proposed.title, lines: cited(proposed.lines) } : proposed ? { kind: "remove" as const, lines: cited(proposed.lines) } : null;
          setMessages((list) => [...list, { id: newId(), role: "ask", text: parsed.text, lines: cited(parsed.lines), action: action?.lines.length ? action : null }]);
          return;
        } catch (cause) {
          // A local model that cannot call tools reads the transcript the old way; a cloud failure is the answer.
          if (!live() || connected.kind === "cloud") throw cause;
          setStatus({ busy: true, text: `${connected.name} could not look things up, so it reads the transcript instead…` });
        }
      }
      const scoped = scopeLines(lines, question, mentions).map((line, id) => ({ ...line, id }));
      if (!scoped.length) throw new Error(lines.length ? "Nothing in the transcript matches those @ mentions." : "There is no transcript to read yet. Add a sequence with a transcript from AAF Audio.");
      const ctx = contextOf(connected);
      const records = (list: AskLine[]) => askRecords(list, nameOf, sourceName, sourceTc);
      // Whose transcript is being read, so a long wait says what it is waiting on.
      const who = askMentioned(question, mentions).filter((mention) => mention.kind === "person").map((mention) => `${mention.label}'s`);
      const reading = who.length ? `${who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}` : who[0]} ${who.length > 1 ? "transcripts" : "transcript"} (${scoped.length.toLocaleString()} lines)`
        : `the transcript (${scoped.length.toLocaleString()} lines)`;
      // Too long to read at once: read it in parts, keeping the lines each part
      // says the question is about, then answer from those alone.
      let pool = scoped;
      if (buildSourcePrefix(records(scoped), ctx).sampled) {
        const parts = askParts(records(scoped), Math.floor(transcriptBudget(ctx) * 0.9)), found: AskLine[] = [];
        for (const [index, part] of parts.entries()) {
          setStatus({ busy: true, text: `Reading ${reading}, part ${index + 1} of ${parts.length}, with ${connected.name}…` });
          const lines = part.map((at, id) => ({ ...scoped[at], id }));
          const reply = await chat(connected, buildSourcePrefix(records(lines), ctx).system, [{ role: "user", content: askFindPrompt(question) }], ctrl.signal);
          if (!live()) return;
          found.push(...parseAskFind(reply, lines.length).map((id) => scoped[part[id]]));
        }
        pool = found.map((line, id) => ({ ...line, id }));
        if (!pool.length) {
          setMessages((list) => [...list, { id: newId(), role: "ask", text: `I read all ${parts.length} parts of the transcript, and nothing in it is about that.`, lines: [], action: null }]);
          return;
        }
      }
      const prefix = buildSourcePrefix(records(pool), ctx);
      if (prefix.sampled) throw new Error("More lines are about that than this model can read at once. Mention a person or a sequence with @ to narrow it, or choose a model with a larger context.");
      setStatus({ busy: true, text: pool === scoped ? `Reading ${reading} with ${connected.name}…` : `Answering from the ${pool.length.toLocaleString()} lines found, with ${connected.name}…` });
      const history: ChatMessage[] = earlier.filter((message) => !message.failed).slice(-6).map((message) => message.role === "you"
        ? { role: "user", content: message.text } : { role: "assistant", content: JSON.stringify({ answer: message.text }) });
      const reply = await chat(connected, prefix.system, [...history, { role: "user", content: askPrompt(question) }], ctrl.signal);
      if (!live()) return;
      const parsed = parseAskAnswer(reply, pool.length);
      // Asked to build, the model cited lines but proposed nothing: offer the build from its lines.
      if (!parsed.action && parsed.lines.length && asksToBuild(question)) parsed.action = { kind: "build", title: askBuildTitle(question, mentions), lines: parsed.lines };
      const action = parsed.action?.kind === "build" ? { kind: "build" as const, title: parsed.action.title, lines: parsed.action.lines.map((id) => cite(pool[id])) }
        : parsed.action ? { kind: "remove" as const, lines: parsed.action.lines.map((id) => cite(pool[id])) } : null;
      setMessages((list) => [...list, { id: newId(), role: "ask", text: parsed.text, lines: parsed.lines.map((id) => cite(pool[id])), action }]);
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
    // Saved at once, not by the effect: "Make new string out" opens the new
    // one in the same render, which unmounts this editor before any effect
    // of this update runs, and the proposal would offer itself again.
    markApplied: (id: string, applied: "here" | "new", createdId?: string) => {
      const next = latest.current.map((message) => message.id === id ? { ...message, applied, createdId } : message);
      save(editId, next);
      setMessages(next);
    },
  };
}
