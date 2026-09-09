import { useCallback, useId, useRef, useState } from "react";
import { IconMore, IconChevronRight, IconHome, IconFolder } from "../src/components/Icons";
import { useMenuKeys } from "../src/hooks/use-menu-keys";
import { useDismiss } from "../src/hooks/use-dismiss";
import { Button } from "./Button";
import { Comparison } from "./Comparison";
import type { ExampleProps } from "./example-types";

export function NavigationExamples({ kind, size }: ExampleProps) {
  const uid = useId();
  const [tab, setTab] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [action, setAction] = useState("Select an action to try the menu.");
  const menuRef = useRef<HTMLDivElement>(null);
  const menuWrap = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setMenuOpen(false), []);
  useMenuKeys(menuRef, menuOpen, close);
  useDismiss(menuWrap, close, menuOpen);
  if (kind === "navigation") return <Comparison same current={<div className="cp-ds-stack"><div className="cp-ds-inline"><IconHome size={14} /><span>Library</span><IconChevronRight size={11} /><IconFolder size={14} /><span>Client review</span></div><small>Location is navigation, not a toggle or a command.</small></div>} proposed={<nav className="cp-ds-breadcrumb" aria-label="Example library breadcrumb"><ol><li><a href="#navigation">Library</a></li><li aria-hidden><IconChevronRight size={11} /></li><li><span aria-current="page">Client review</span></li></ol><p>Retain the shared browse bar, consistent row geometry, and location hierarchy.</p></nav>} />;
  if (kind === "menus") return <Comparison current={<div className="cp-ds-stack"><div className="cp-ds-menu-static"><span>Open in Clip</span><span>Reveal in Finder</span><span>Remove from Library</span></div><small>Appearance reference only. Some nested menus currently lack the keyboard behavior their role promises.</small></div>} proposed={<div className="cp-ds-stack"><div className="cp-ds-menu-wrap" ref={menuWrap}><Button size={size} aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={`${uid}-menu`} onClick={() => setMenuOpen((open) => !open)}><IconMore size={14} />Example actions</Button>{menuOpen && <div className="cp-ds-menu" role="menu" aria-label="Example actions" id={`${uid}-menu`} ref={menuRef}>{["Open in Clip", "Reveal in Finder", "Remove from Library"].map((label) => <button type="button" role="menuitem" key={label} onClick={() => { setAction(`${label} demonstrated. No file was changed.`); close(); }}>{label}</button>)}</div>}</div><small role="status">{action}</small><small>Arrow keys, Home/End, typeahead, Escape, and return focus use the existing menu helper.</small></div>} />;
  const names = ["Transcript", "Review", "Queue"];
  return <Comparison current={<div className="cp-ds-stack"><div className="cp-ds-tab-appearance">{names.map((name, i) => <span key={name} data-selected={i === 0}>{name}</span>)}</div><small>Neutral current tab. Several existing tab families have click behavior without full tab keyboard support.</small></div>} proposed={<div className="cp-ds-stack"><div className="cp-ds-tabs" role="tablist" aria-label="Example drawer tabs">{names.map((name, i) => <button key={name} type="button" role="tab" id={`${uid}-tab-${i}`} aria-controls={`${uid}-panel-${i}`} aria-selected={tab === i} tabIndex={tab === i ? 0 : -1} onClick={() => setTab(i)} onKeyDown={(e) => { const next = e.key === "ArrowRight" ? (i + 1) % names.length : e.key === "ArrowLeft" ? (i + names.length - 1) % names.length : e.key === "Home" ? 0 : e.key === "End" ? names.length - 1 : null; if (next !== null) { e.preventDefault(); setTab(next); document.getElementById(`${uid}-tab-${next}`)?.focus(); } }}>{name}</button>)}</div>{names.map((name, i) => <div key={name} className="cp-ds-tab-panel" role="tabpanel" hidden={tab !== i} id={`${uid}-panel-${i}`} aria-labelledby={`${uid}-tab-${i}`} tabIndex={0}>{name} panel fixture. Selection stays local to this example.</div>)}<small>Arrows change tabs. Tab enters the selected panel. Panel identity and selected state are explicit.</small></div>} />;
}
