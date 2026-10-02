import { useState } from "react";
import { IconHistory } from "../src/components/Icons";
import type { TeLog } from "./transcript-editor-history";
import { sideBranches, timeline } from "./transcript-editor-history";

type Props<T> = { log: TeLog<T>; onJump: (id: number) => void; onPin: (id: number, name: string | null) => void };

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Every state the edit has been in, newest first. Click one to go there;
 * nothing is lost by going back, and steps undone and then edited over stay
 * reachable under the step they branched from.
 */
export function TeHistory<T>({ log, onJump, onPin }: Props<T>) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [naming, setNaming] = useState<number | null>(null);
  const { done, ahead } = timeline(log);
  const branches = sideBranches(log);
  const row = (id: number, kind: "done" | "ahead" | "branch") => {
    const state = log.states[id];
    const here = id === log.head;
    return <li key={id} className={`cp-te-hist-row is-${kind}${here ? " is-head" : ""}`}>
      <button type="button" className="cp-te-hist-step" aria-current={here ? "step" : undefined} onClick={() => onJump(id)}>
        <span className="cp-te-hist-label">{state.pinned ?? state.label}</span>
        {state.pinned && <span className="cp-te-hist-sub">{state.label}</span>}
        <span className="cp-te-hist-time">{clock(state.at)}</span>
      </button>
      {naming === id
        ? <input className="cp-te-hist-name" aria-label="Pin name" autoFocus defaultValue={state.pinned ?? state.label}
          onBlur={(event) => { onPin(id, event.target.value); setNaming(null); }}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.stopPropagation(); setNaming(null); } }} />
        : <button type="button" className={`cp-icon-btn cp-te-hist-pin${state.pinned ? " active" : ""}`} aria-pressed={!!state.pinned}
          aria-label={state.pinned ? `Unpin ${state.pinned}` : `Pin ${state.label}`} title={state.pinned ? "Unpin" : "Pin"}
          onClick={() => state.pinned ? onPin(id, null) : setNaming(id)}>★</button>}
    </li>;
  };
  const lines = [...done.map((id) => ({ id, kind: "done" as const })), ...ahead.map((id) => ({ id, kind: "ahead" as const }))].reverse();
  return <section className="cp-te-history" aria-label="History">
    <header className="cp-te-pane-head"><IconHistory size={13} /><h2 className="cp-te-pane-title">History</h2>
      <span className="cp-te-pane-note">{log.states.length - 1} steps</span></header>
    <ol className="cp-te-hist-list">
      {lines.map(({ id, kind }) => {
        const off = branches.filter((branch) => branch.from === id);
        return [row(id, kind), ...off.map((branch) => {
          const shown = open.has(branch.states[0]);
          return <li key={`b${branch.states[0]}`} className="cp-te-hist-branch">
            <button type="button" className="cp-te-hist-more" aria-expanded={shown}
              onClick={() => setOpen((state) => { const next = new Set(state); if (!next.delete(branch.states[0])) next.add(branch.states[0]); return next; })}>
              {shown ? "▾" : "▸"} {branch.states.length} undone</button>
            {shown && <ol className="cp-te-hist-list">{[...branch.states].reverse().map((state) => row(state, "branch"))}</ol>}
          </li>;
        })];
      })}
    </ol>
  </section>;
}
