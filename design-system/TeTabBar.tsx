import { useLayoutEffect, useRef, useState } from "react";
import { IconMore } from "../src/components/Icons";
import { TabOverflowMenu } from "../src/components/TabOverflowMenu";
import { visibleTabs } from "../src/lib/tab-overflow";
import { useDismiss } from "../src/hooks/use-dismiss";
import { useMenuKeys } from "../src/hooks/use-menu-keys";
import { neighbour, teColumnNames, teColumns, type TeColumn } from "./transcript-editor-dock";

export type TeTab = { id: string; label: string; closable: boolean; movable: boolean; home: TeColumn };

type Props = {
  column: TeColumn; tabs: TeTab[]; active: string | null; panelId: string;
  /** Where a dragged tab would land in this strip, or null when it is not the target. */
  dropIndex: number | null;
  onActivate: (id: string) => void; onClose: (id: string) => void; onMove: (id: string, to: TeColumn) => void;
  onDrag: (id: string, x: number, y: number) => void; onDrop: (x: number, y: number) => void; onCancel: () => void;
};

/**
 * A panel column's tabs. Drag a tab onto another column's tabs to move it
 * there, or use the ⋯ menu (or ⌥⌘← ⌥⌘→) to do the same without a pointer.
 * The strip never scrolls sideways: what does not fit goes behind "N more".
 * Dragging is pointer-based on purpose; an HTML5 drag would open a macOS drag
 * session the window treats as a file being dropped on the app.
 */
export function TeTabBar(props: Props) {
  const { column, tabs, active } = props;
  const strip = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null), more = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState({ tabs: [] as number[], available: 0, more: 0 });
  const [menuOpen, setMenuOpen] = useState(false);
  const press = useRef<{ id: string; x: number; y: number; dragging: boolean } | null>(null);
  const signature = tabs.map((tab) => tab.label).join("\n");
  useLayoutEffect(() => {
    const read = () => {
      const cells = Array.from(measure.current?.children ?? []) as HTMLElement[];
      const next = { tabs: cells.slice(0, -1).map((cell) => Math.ceil(cell.getBoundingClientRect().width)),
        more: Math.ceil(cells.at(-1)?.getBoundingClientRect().width ?? 0), available: Math.floor(strip.current?.getBoundingClientRect().width ?? 0) - 32 };
      setWidths((current) => current.available === next.available && current.more === next.more && current.tabs.join() === next.tabs.join() ? current : next);
    };
    read();
    const observer = new ResizeObserver(read);
    if (strip.current) observer.observe(strip.current);
    return () => observer.disconnect();
  }, [signature]);
  useDismiss(menu, () => setMenuOpen(false), menuOpen);
  useMenuKeys(menu, menuOpen, () => setMenuOpen(false));
  const index = tabs.findIndex((tab) => tab.id === active);
  const shown = new Set(visibleTabs(widths.tabs.length === tabs.length ? widths.tabs : [], widths.available, widths.more, index));
  const hidden = tabs.filter((_, position) => !shown.has(position));
  const current = tabs[index];
  const moveBy = (direction: -1 | 1) => {
    const to = current && neighbour(column, direction);
    if (to && current.movable) props.onMove(current.id, to);
  };
  return <div ref={strip} className="cp-te-tabbar" data-dock-strip={column}>
    <div className="cp-te-tablist" role="tablist" aria-label={teColumnNames[column]} onKeyDown={(event) => {
      if (event.altKey && event.metaKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); return moveBy(event.key === "ArrowLeft" ? -1 : 1); }
      if (event.metaKey && event.key.toLowerCase() === "w" && current?.closable) { event.preventDefault(); return props.onClose(current.id); }
      const next = event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "ArrowRight" ? (index + 1) % tabs.length : -1;
      if (next < 0 || event.altKey || event.metaKey) return;
      event.preventDefault();
      props.onActivate(tabs[next].id);
      requestAnimationFrame(() => strip.current?.querySelector<HTMLElement>(`[data-dock-tab="${CSS.escape(tabs[next].id)}"]`)?.focus());
    }}>
      {tabs.map((tab, position) => shown.has(position) && <button key={tab.id} type="button" role="tab" data-dock-tab={tab.id} data-dock-index={position}
        aria-selected={tab.id === active} aria-controls={props.panelId} tabIndex={tab.id === active ? 0 : -1}
        className={`cp-tab cp-te-tab${tab.id === active ? " active" : ""}${tab.home !== column ? " is-guest" : ""}${props.dropIndex === position ? " is-drop-before" : ""}`}
        title={tab.movable ? `${tab.label}. Drag to another panel to move it.` : tab.label}
        onPointerDown={(event) => {
          if (event.button === 1 && tab.closable) { event.preventDefault(); return props.onClose(tab.id); }
          if (event.button !== 0 || !tab.movable) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          press.current = { id: tab.id, x: event.clientX, y: event.clientY, dragging: false };
        }}
        onPointerMove={(event) => {
          const held = press.current;
          if (!held) return;
          if (!held.dragging && Math.hypot(event.clientX - held.x, event.clientY - held.y) < 5) return;
          held.dragging = true;
          props.onDrag(held.id, event.clientX, event.clientY);
        }}
        onPointerUp={(event) => {
          const held = press.current;
          press.current = null;
          if (held?.dragging) props.onDrop(event.clientX, event.clientY);
          else props.onActivate(tab.id);
        }}
        onPointerCancel={() => { if (press.current?.dragging) props.onCancel(); press.current = null; }}
        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onActivate(tab.id); } }}>
        {tab.label}
      </button>)}
      {props.dropIndex === tabs.length && <span className="cp-te-drop-end" aria-hidden="true" />}
    </div>
    <TabOverflowMenu tabs={hidden.map((tab) => ({ id: tab.id, label: tab.label }))} selected={active ?? ""} noun="panels" buttonRef={more} onSelect={props.onActivate} />
    {current && (current.movable || current.closable) && <div ref={menu} className="cp-te-tabmenu-wrap">
      <button type="button" className="cp-icon-btn cp-te-tabmenu-btn" aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label={`${current.label} panel options`} title={`${current.label}: move to another panel or close`} onClick={() => setMenuOpen((value) => !value)}><IconMore size={14} /></button>
      {menuOpen && <div className="cp-tabstrip-menu cp-te-tabmenu" role="menu" aria-label={`${current.label} panel options`}>
        {current.movable && teColumns.filter((to) => to !== column).map((to) => <button key={to} type="button" role="menuitem"
          onClick={() => { setMenuOpen(false); props.onMove(current.id, to); }}>Move to {teColumnNames[to]}</button>)}
        {current.closable && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); props.onClose(current.id); }}>Close {current.label}</button>}
      </div>}
    </div>}
    <div ref={measure} className="cp-tabstrip-measure" aria-hidden="true">
      {tabs.map((tab) => <span key={tab.id} className="cp-tab cp-te-tab">{tab.label}</span>)}
      <span className="cp-tabstrip-more">{tabs.length} more</span>
    </div>
  </div>;
}
