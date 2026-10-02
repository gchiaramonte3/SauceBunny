import type { TimelineLane } from "../lib/edit-model";

type Props = { people: TimelineLane[]; next: number; onPatch: (lane: string, position: number) => void };

/**
 * The patch panel's empty track under the last one in use: choose someone
 * and they are patched to it, as Avid adds the next track down. Only people
 * not on a track are offered; the tracks above are re-patched in their own
 * headers.
 */
export function EditPatchRow({ people, next, onPatch }: Props) {
  const free = people.filter((person) => person.track === 0);
  if (!free.length) return null;
  return <div className="cp-te-tl-row cp-te-tl-patch-row">
    <div className="cp-te-tl-head">
      <span className="cp-te-tl-track is-static" aria-hidden="true">A{next + 1}</span>
      <select className="cp-select xs cp-te-tl-patch" aria-label={`Patch someone to A${next + 1}`} title={`Patch someone to A${next + 1}`} value=""
        onChange={(event) => { if (event.target.value) onPatch(event.target.value, next); }}>
        <option value="">Patch someone…</option>
        {free.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
    </div>
    <div className="cp-te-tl-lane" aria-hidden="true" />
  </div>;
}
