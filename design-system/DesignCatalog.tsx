import { useState } from "react";
import { IconSearch, IconChevronRight } from "../src/components/Icons";
import logoUrl from "../src/assets/saucebunny.svg";
import { catalogEntries } from "./catalog-data";
import { CatalogExamples } from "./CatalogExamples";
import type { PreviewState } from "./example-types";

const groups = ["Controls", "Specialty", "Content", "Navigation", "Surfaces", "Review"];
const workspaces = ["Home", "Library", "Clip", "Review", "Transcripts", "Settings", "Dialogs", "Detached"];

export function DesignCatalog() {
  const [search, setSearch] = useState("");
  const [workspace, setWorkspace] = useState("All workspaces");
  const [group, setGroup] = useState("All families");
  const [state, setState] = useState<PreviewState>("rest");
  const [size, setSize] = useState<"standard" | "compact">("standard");
  const [enlarged, setEnlarged] = useState(false);
  const filtered = catalogEntries.filter((entry) =>
    (workspace === "All workspaces" || entry.workspaces.some((name) => name === workspace)) &&
    (group === "All families" || entry.group === group) &&
    [entry.title, entry.current, entry.proposed, entry.classification, ...entry.rules, ...entry.workspaces, ...entry.sources.map((s) => s.path)]
      .join(" ").toLowerCase().includes(search.trim().toLowerCase()),
  );

  return <div className="cp-ds-catalog" data-testid="design-catalog" data-enlarged={enlarged}>
    <a className="cp-ds-skip" href="#catalog-content">Skip to examples</a>
    <aside className="cp-ds-sidebar" aria-label="Catalog navigation">
      <a className="cp-ds-brand" href="#catalog-content"><img className="cp-ds-brand-mark" src={logoUrl} alt="" draggable={false} /><span>Sauce Bunny<small>Design catalog</small></span></a>
      <div className="cp-ds-nav-label">Component families</div>
      <nav aria-label="Component families">
        {groups.map((family) => <div key={family} className="cp-ds-nav-group"><h2>{family}</h2>
          {catalogEntries.filter((entry) => entry.group === family).map((entry) => <a key={entry.id} href={`#${entry.id}`} onClick={() => { setGroup("All families"); setWorkspace("All workspaces"); setSearch(""); }}>
            {entry.title}<IconChevronRight size={11} />
          </a>)}
        </div>)}
      </nav>
      <p className="cp-ds-sidebar-note">Local fixtures only.<br />No sessions, devices, or saved reviews.</p>
      <a className="cp-ds-doc-link" href="/design-system.html?prototype=transcript-editor" target="_blank" rel="noreferrer">Transcript Editor prototype ↗</a>
      <a className="cp-ds-doc-link" href="/docs/DESIGN-CATALOG.md" target="_blank" rel="noreferrer">Rules & migration checklist ↗</a>
      <a className="cp-ds-doc-link" href="/docs/DESIGN-SYSTEM-AUDIT.md" target="_blank" rel="noreferrer">Application coverage audit ↗</a>
    </aside>
    <main id="catalog-content" className="cp-ds-main" tabIndex={-1} aria-label="Design catalog">
      <header className="cp-ds-header">
        <div><div className="cp-ds-heading-row"><h1>Design catalog</h1><span className="cp-ds-review-label">For review</span></div>
          <p>Production recipes and proposed refinements. Fixtures never change application state.</p></div>
        <div className="cp-ds-filter-row">
          <label className="cp-ds-search"><IconSearch size={15} /><span className="cp-visually-hidden">Search catalog</span><input data-testid="catalog-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a control, rule, or source…" /></label>
          <label className="cp-ds-filter"><span>Workspace</span><select className="cp-select" data-testid="catalog-workspace" value={workspace} onChange={(e) => setWorkspace(e.target.value)}><option>All workspaces</option>{workspaces.map((w) => <option key={w}>{w}</option>)}</select></label>
          <label className="cp-ds-filter"><span>Family</span><select className="cp-select" data-testid="catalog-group" value={group} onChange={(e) => setGroup(e.target.value)}><option>All families</option>{groups.map((g) => <option key={g}>{g}</option>)}</select></label>
        </div>
        <div className="cp-ds-controls">
          <label>Command state<select className="cp-select" data-testid="catalog-state" value={state} onChange={(e) => setState(e.target.value as PreviewState)}>{["rest", "hover", "focus", "pressed", "disabled", "busy"].map((s) => <option value={s} key={s}>{s === "rest" ? "Default" : s.charAt(0).toUpperCase() + s.slice(1)}</option>)}</select></label>
          <label>Command size<select className="cp-select" data-testid="catalog-density" value={size} onChange={(e) => setSize(e.target.value as "standard" | "compact")}><option value="standard">Standard · 30px</option><option value="compact">Compact · 26px</option></select></label>
          <label className="cp-ds-check"><input type="checkbox" data-testid="catalog-text-scale" checked={enlarged} onChange={(e) => setEnlarged(e.target.checked)} />Enlarged text · 125%</label>
          <span className="cp-ds-results" role="status">{filtered.length} of {catalogEntries.length} families</span>
        </div>
      </header>
      <div className="cp-ds-intro"><strong>Preserve the editing workspace.</strong><p>Nunito Sans, neutral controls, violet selection, and the existing monitor stay. Green remains live or success, never a generic action color. These examples separate visual consistency from changes to playback or session behavior.</p></div>
      <div className="cp-ds-entries">
        {filtered.map((entry) => <article key={entry.id} id={entry.id} className="cp-ds-entry" data-testid={`catalog-entry-${entry.id}`}>
          <header className="cp-ds-entry-head"><div><h2>{entry.title}</h2><p>{entry.workspaces.join(" · ")}</p></div><span className="cp-ds-classification" data-classification={entry.classification}>{entry.classification}</span></header>
          <CatalogExamples kind={entry.id} state={state} size={size} />
          <div className="cp-ds-rationale"><p><strong>Now</strong>{entry.current}</p><p><strong>Direction</strong>{entry.proposed}</p></div>
          <details className="cp-ds-rules"><summary>Usage rules & source references</summary>
            <ul>{entry.rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
            <dl>{entry.sources.map((source) => <div key={source.path}><dt><a href={`/${source.path}`} target="_blank" rel="noreferrer">{source.path}</a></dt><dd>{source.note}</dd></div>)}</dl>
          </details>
        </article>)}
        {filtered.length === 0 && <section className="cp-ds-empty"><h2>No matching patterns</h2><p>Try a control name such as “button”, a workspace, or a source filename.</p><button className="btn" type="button" onClick={() => { setSearch(""); setWorkspace("All workspaces"); setGroup("All families"); }}>Clear filters</button></section>}
      </div>
      <footer className="cp-ds-footer">People and Preview show their approved production fixes. Other proposals still require approval before adoption.</footer>
    </main>
  </div>;
}
