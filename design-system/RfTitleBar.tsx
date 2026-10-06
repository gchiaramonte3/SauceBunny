import { IconLink } from "../src/components/Icons";
import { plural } from "../src/lib/plural";

/**
 * Everything that used to sit above the picture, in one thin line that
 * steps aside with the controls: what the session is, who is in it, and the
 * two things you do to the session itself.
 */
export function RfTitleBar({ shown, title, people, onDemo }: { shown: boolean; title: string; people: number; onDemo: (what: string) => void }) {
  return <header className={`cp-rf-title${shown ? "" : " is-away"}`} data-testid="rf-title">
    <span className="cp-rf-title-name">{title}</span>
    <span className="cp-rf-title-meta">{plural(people, "person", "people")} in the room</span>
    <span className="cp-rf-title-actions">
      <button type="button" className="cp-rf-text-btn" onClick={() => onDemo("Invite")}><IconLink size={13} />Invite</button>
      <button type="button" className="cp-rf-text-btn cp-rf-end" onClick={() => onDemo("End session")}>End session</button>
    </span>
  </header>;
}
