import { IconFolder, IconPlus, IconTranscript } from "../src/components/Icons";

export type TeLibraryItem = { id: string; name: string; detail: string; ready: boolean; open?: boolean };
export type TeLibraryGroup = { title: string; items: TeLibraryItem[] };

type Props = { groups: TeLibraryGroup[]; current: string; onOpen: (item: TeLibraryItem) => void; onNew: (empty: boolean) => void };

/**
 * The library panel: where an edit's material comes from. Sequences from AAF
 * Audio (already relinked and transcribed per mic), clips from the Library,
 * and edits made from them. Choosing a source opens it as a tab beside the
 * sources already open.
 */
export function TeSidebar({ groups, current, onOpen, onNew }: Props) {
  return <nav className="cp-te-sidebar" aria-label="Library">
    {groups.map((group) => <section key={group.title} className="cp-te-side-group" aria-label={group.title}>
      <h2 className="cp-te-side-title">{group.title}</h2>
      <ul className="cp-te-side-list">
        {group.items.map((item) => <li key={item.id}>
          <button type="button" className={`cp-te-side-item${item.id === current ? " is-current" : ""}${item.open ? " is-open" : ""}`} aria-current={item.id === current || item.open ? "true" : undefined}
            onClick={() => onOpen(item)} title={item.ready ? undefined : "Placeholder"}>
            {group.title === "Edits" ? <IconTranscript size={13} /> : <IconFolder size={13} />}
            <span className="cp-te-side-text"><span className="cp-te-side-name">{item.name}</span><span className="cp-te-side-detail">{item.detail}</span></span>
          </button>
        </li>)}
      </ul>
    </section>)}
    <div className="cp-te-side-new">
      <button type="button" className="btn btn-ghost cp-te-btn" onClick={() => onNew(true)} title="New empty edit (⇧⌘N)"><IconPlus size={12} />New edit</button>
      <button type="button" className="btn btn-ghost cp-te-btn" onClick={() => onNew(false)} title="New edit from the whole scene">From scene</button>
    </div>
  </nav>;
}
