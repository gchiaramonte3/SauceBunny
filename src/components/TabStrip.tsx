import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { visibleTabs } from "../lib/tab-overflow";
import { TabOverflowMenu } from "./TabOverflowMenu";

export type StripTab = { id: string; label: string; swatch?: string | null };

/**
 * A tab strip that never scrolls sideways: the tabs that fit, in order, then
 * "N more" for the rest (see lib/tab-overflow). Widths come from an invisible
 * copy of every tab, so a tab behind the menu is measured as exactly as one
 * on screen and the strip settles in one pass instead of shuffling.
 */
export function TabStrip({ tabs, selected, onSelect, onClose, label, noun, panelId }: {
  tabs: StripTab[]; selected: string; onSelect: (id: string) => void;
  /**
   * Closes a tab: the x on it, or Delete on the focused tab. The x is a
   * pointer shortcut for that key (a button cannot hold another button), so
   * it is hidden from assistive technology rather than announced twice.
   * A strip without this has no x.
   */
  onClose?: (id: string) => void;
  /** Accessible name of the tablist. */ label: string;
  /** Plural for the menu, as in "12 more people". */ noun: string;
  panelId: string;
}) {
  const prefix = useId(), strip = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null), focusNext = useRef<string | null>(null), focusChosen = useRef(false);
  const [layout, setLayout] = useState({ widths: [] as number[], available: 0, more: 0 });
  const signature = tabs.map((tab) => tab.label).join("\n");
  useLayoutEffect(() => {
    const read = () => {
      const cells = Array.from(measure.current?.children ?? []) as HTMLElement[];
      const widths = cells.slice(0, -1).map((cell) => Math.ceil(cell.getBoundingClientRect().width));
      const moreWidth = Math.ceil(cells.at(-1)?.getBoundingClientRect().width ?? 0);
      const available = Math.floor(strip.current?.getBoundingClientRect().width ?? 0);
      setLayout((current) => current.available === available && current.more === moreWidth && current.widths.join() === widths.join()
        ? current : { widths, available, more: moreWidth });
    };
    read();
    if (!strip.current) return;
    const observer = new ResizeObserver(read);
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [signature]);
  const index = tabs.findIndex((tab) => tab.id === selected);
  const shown = new Set(visibleTabs(layout.widths.length === tabs.length ? layout.widths : [], layout.available, layout.more, index));
  const hidden = tabs.filter((_, position) => !shown.has(position));
  const choose = (id: string) => { focusNext.current = id; onSelect(id); };
  // After a close the parent chooses what is selected, so focus follows it there.
  const close = (id: string) => { focusChosen.current = true; onClose?.(id); };
  useEffect(() => {
    const id = focusNext.current ?? (focusChosen.current ? selected : null);
    if (!id) { focusNext.current = null; focusChosen.current = false; return; }
    // A strip whose tabs just changed draws none until they are measured again
    // (one pass later), so wait for the tab rather than dropping the focus.
    const tab = Array.from(strip.current?.querySelectorAll<HTMLButtonElement>("[data-tab-id]") ?? []).find((item) => item.dataset.tabId === id);
    if (!tab) return;
    tab.focus();
    focusNext.current = null; focusChosen.current = false;
  });
  // With nothing selected (a list or a form below), the first tab takes the tab stop.
  const stop = index >= 0 ? selected : tabs.find((_, position) => shown.has(position))?.id;
  return <div ref={strip} className="cp-tabstrip">
    <div className="cp-tabstrip-list" role="tablist" aria-label={label} onKeyDown={(event) => {
      // Keys act on the tab that has focus, which is the selected one unless nothing is.
      const focused = (event.target as HTMLElement).closest<HTMLElement>("[data-tab-id]")?.dataset.tabId;
      const from = focused ? tabs.findIndex((tab) => tab.id === focused) : index;
      if (onClose && (event.key === "Delete" || event.key === "Backspace") && from >= 0) { event.preventDefault(); close(tabs[from].id); return; }
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : event.key === "ArrowLeft" ? (from + tabs.length - 1) % tabs.length : event.key === "ArrowRight" ? (from + 1) % tabs.length : -1;
      if (next < 0 || !tabs.length) return;
      event.preventDefault(); choose(tabs[next].id);
    }}>{tabs.map((tab, position) => shown.has(position) && <button key={tab.id} type="button" id={`${prefix}-${position}`} role="tab" data-tab-id={tab.id}
      aria-selected={selected === tab.id} aria-controls={panelId} tabIndex={stop === tab.id ? 0 : -1}
      className={`cp-tab${selected === tab.id ? " active" : ""}${onClose ? " is-closable" : ""}`} title={tab.label} aria-keyshortcuts={onClose ? "Delete" : undefined} onClick={() => onSelect(tab.id)}>
      {tab.swatch && <span className="cp-tabstrip-swatch" style={{ background: tab.swatch }} aria-hidden="true" />}
      {onClose ? <><span className="cp-tabstrip-label">{tab.label}</span>
        <span className="cp-tabstrip-close" aria-hidden="true" title={`Close ${tab.label}`} onClick={(event) => { event.stopPropagation(); close(tab.id); }}>×</span></> : tab.label}
    </button>)}</div>
    <TabOverflowMenu tabs={hidden} selected={selected} noun={noun} buttonRef={more} onSelect={choose} />
    <div ref={measure} className="cp-tabstrip-measure" aria-hidden="true">
      {tabs.map((tab) => <span key={tab.id} className={`cp-tab${onClose ? " is-closable" : ""}`}>{tab.swatch && <span className="cp-tabstrip-swatch" />}
        {onClose ? <><span className="cp-tabstrip-label">{tab.label}</span><span className="cp-tabstrip-close">×</span></> : tab.label}</span>)}
      <span className="cp-tabstrip-more">{tabs.length} more</span>
    </div>
  </div>;
}
