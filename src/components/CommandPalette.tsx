import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Command, CommandGroup } from "../lib/commands";
import { scoreCommand } from "../lib/commands";

type Props = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
};

/**
 * Spotlight/Linear/VS Code-style command palette. Mounts a centered
 * modal via portal (so it sits above the canvas/queue/notification stacks).
 *
 * UX rules:
 *  - ⌘K toggles open/close from anywhere (wired in App.tsx, not here).
 *  - Esc closes. Click outside closes. Click a row runs it.
 *  - ↑/↓ navigate. Enter runs the active row.
 *  - Search is fuzzy + match-aware; the active row stays the highest-
 *    scored match across keystrokes.
 *  - Empty query shows all commands grouped by category — pure browser.
 *  - Disabled commands render but are non-selectable.
 */
export function CommandPalette({ open, onClose, commands }: Props) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset query + active index whenever the palette opens. Without this
  // the second time you open it you'd land on the last query / row.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // Autofocus the search input on the next paint so the open
      // animation doesn't steal the cursor before mount completes.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Build the filtered + grouped list each render. Cheap (~25 commands).
  const filtered = useMemo(() => {
    if (!open) return [] as Command[];
    return commands
      .map((c) => ({ cmd: c, score: scoreCommand(c, query) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => {
        // Disabled rows sink. Among the rest: higher score wins; ties
        // broken by label so the order is stable.
        if (a.cmd.disabled !== b.cmd.disabled) return a.cmd.disabled ? 1 : -1;
        if (b.score !== a.score) return b.score - a.score;
        return a.cmd.label.localeCompare(b.cmd.label);
      })
      .map((x) => x.cmd);
  }, [open, commands, query]);

  // Group preserving the sorted order. We bucket by `group` but keep
  // the first appearance order so the highest-scoring group sits at top.
  const grouped = useMemo(() => {
    const byGroup = new Map<CommandGroup, Command[]>();
    for (const c of filtered) {
      const arr = byGroup.get(c.group);
      if (arr) arr.push(c);
      else byGroup.set(c.group, [c]);
    }
    return Array.from(byGroup.entries());
  }, [filtered]);

  // Flat selectable list (skips disabled) — drives ↑/↓ navigation.
  const selectable = useMemo(() => filtered.filter((c) => !c.disabled), [filtered]);

  // Clamp the active index when the filter result shrinks below it.
  useEffect(() => {
    if (activeIdx >= selectable.length) setActiveIdx(Math.max(0, selectable.length - 1));
  }, [selectable.length, activeIdx]);

  // Scroll the active row into view as the user arrow-keys past the
  // visible window. `nearest` minimises scroll jumps.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-cmd-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  // Global keyboard handler — bound while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(selectable.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = selectable[activeIdx];
        if (cmd) {
          onClose();
          // Defer so the close animation can start before we hand
          // control to the run handler (which may open another modal
          // or push a notification).
          requestAnimationFrame(() => cmd.run());
        }
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, selectable, activeIdx, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="cp-palette-scrim"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="cp-palette" onClick={(e) => e.stopPropagation()}>
        <div className="cp-palette-input-wrap">
          <span className="cp-palette-search-icon">⌘</span>
          <input
            ref={inputRef}
            className="cp-palette-input"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            placeholder="Type a command…"
            spellCheck={false}
            autoComplete="off"
          />
          <span className="cp-palette-count">
            {selectable.length} {selectable.length === 1 ? "command" : "commands"}
          </span>
        </div>
        <div className="cp-palette-list" ref={listRef}>
          {grouped.length === 0 ? (
            <div className="cp-palette-empty">
              No commands match &quot;{query}&quot;
            </div>
          ) : grouped.map(([group, cmds]) => (
            <div key={group} className="cp-palette-group">
              <div className="cp-palette-group-label">{group}</div>
              {cmds.map((cmd) => {
                const idx = selectable.indexOf(cmd);
                const active = idx === activeIdx && !cmd.disabled;
                return (
                  <div
                    key={cmd.id}
                    data-cmd-idx={idx >= 0 ? idx : undefined}
                    className={
                      "cp-palette-row" +
                      (active ? " active" : "") +
                      (cmd.disabled ? " disabled" : "")
                    }
                    onMouseEnter={() => {
                      if (!cmd.disabled && idx >= 0) setActiveIdx(idx);
                    }}
                    onClick={() => {
                      if (cmd.disabled) return;
                      onClose();
                      requestAnimationFrame(() => cmd.run());
                    }}
                  >
                    <div className="cp-palette-row-text">
                      <span className="cp-palette-row-label">{cmd.label}</span>
                      {cmd.description && (
                        <span className="cp-palette-row-desc">{cmd.description}</span>
                      )}
                    </div>
                    {cmd.hotkey && <kbd className="cp-palette-row-key">{cmd.hotkey}</kbd>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cp-palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
