import { IconFolder, IconPlus, IconTranscript } from "../src/components/Icons";

export type TeLibraryItem = { id: string; name: string; detail: string; ready: boolean };
export type TeLibraryGroup = { title: string; items: TeLibraryItem[] };

type Props = { groups: TeLibraryGroup[]; current: string; onOpen: (item: TeLibraryItem) => void; onNew: () => void };

/**
 * The leading sidebar: where an edit comes from. Sequences from AAF Audio
 * (already relinked and transcribed per mic) and edits made from them. It is
 * navigation only, so it is the first pane to step aside when space runs out.
 */
export function TeSidebar({ groups, current, onOpen, onNew }: Props) {
  return <nav className="cp-te-sidebar" aria-label="Sequences and edits">
    {groups.map((group) => <section key={group.title} className="cp-te-side-group" aria-label={group.title}>
      <h2 className="cp-te-side-title">{group.title}</h2>
      <ul className="cp-te-side-list">
        {group.items.map((item) => <li key={item.id}>
          <button type="button" className={`cp-te-side-item${item.id === current ? " is-current" : ""}`} aria-current={item.id === current ? "true" : undefined}
            onClick={() => onOpen(item)} title={item.ready ? item.name : `${item.name}. A placeholder in this prototype.`}>
            {group.title === "Edits" ? <IconTranscript size={13} /> : <IconFolder size={13} />}
            <span className="cp-te-side-text"><span className="cp-te-side-name">{item.name}</span><span className="cp-te-side-detail">{item.detail}</span></span>
          </button>
        </li>)}
      </ul>
    </section>)}
    <button type="button" className="btn btn-ghost cp-te-btn cp-te-side-new" onClick={onNew} title="Start a new edit from the whole scene">
      <IconPlus size={12} />New edit from this sequence</button>
  </nav>;
}
