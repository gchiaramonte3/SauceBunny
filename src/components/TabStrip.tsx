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
export function TabStrip({ tabs, selected, onSelect, label, noun, panelId }: {
  tabs: StripTab[]; selected: string; onSelect: (id: string) => void;
  /** Accessible name of the tablist. */ label: string;
  /** Plural for the menu, as in "12 more people". */ noun: string;
  panelId: string;
}) {
  const prefix = useId(), strip = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null), focusNext = useRef<string | null>(null);
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
  useEffect(() => {
    if (focusNext.current == null) return;
    const id = focusNext.current;
    Array.from(strip.current?.querySelectorAll<HTMLButtonElement>("[data-tab-id]") ?? []).find((tab) => tab.dataset.tabId === id)?.focus();
    focusNext.current = null;
  });
  return <div ref={strip} className="cp-tabstrip">
    <div className="cp-tabstrip-list" role="tablist" aria-label={label} onKeyDown={(event) => {
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "ArrowRight" ? (index + 1) % tabs.length : -1;
      if (next < 0 || !tabs.length) return;
      event.preventDefault(); choose(tabs[next].id);
    }}>{tabs.map((tab, position) => shown.has(position) && <button key={tab.id} type="button" id={`${prefix}-${position}`} role="tab" data-tab-id={tab.id}
      aria-selected={selected === tab.id} aria-controls={panelId} tabIndex={selected === tab.id ? 0 : -1}
      className={`cp-tab${selected === tab.id ? " active" : ""}`} title={tab.label} onClick={() => onSelect(tab.id)}>
      {tab.swatch && <span className="cp-tabstrip-swatch" style={{ background: tab.swatch }} aria-hidden="true" />}{tab.label}
    </button>)}</div>
    <TabOverflowMenu tabs={hidden} selected={selected} noun={noun} buttonRef={more} onSelect={choose} />
    <div ref={measure} className="cp-tabstrip-measure" aria-hidden="true">
      {tabs.map((tab) => <span key={tab.id} className="cp-tab">{tab.swatch && <span className="cp-tabstrip-swatch" />}{tab.label}</span>)}
      <span className="cp-tabstrip-more">{tabs.length} more</span>
    </div>
  </div>;
}
