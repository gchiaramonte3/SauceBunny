import { ParticipantTile, type CatalogParticipant } from "./ParticipantTile";
import type { RfLayout } from "./review-fullscreen-fixture";

/**
 * The people in a film strip along one edge, or floating at a corner over
 * the picture. Every layout draws the same tiles as the approved theater
 * strip (168px, presenter and raised hand as badges on the tile, the same
 * details menu), so a pick between layouts is a pick of placement only.
 */
export function RfPeople({ people, layout, shown, onToggleMic, onToggleCamera }: {
  people: CatalogParticipant[]; layout: RfLayout; shown: boolean; onToggleMic: () => void; onToggleCamera: () => void;
}) {
  return <section className={`cp-rf-people${layout === "float" && !shown ? " is-away" : ""}`} data-edge={layout} aria-label="People" data-testid="rf-people">
    <div className="cp-people strip"><div className="cp-people-list">
      {people.map((person) => <ParticipantTile key={person.id} participant={person} density="theater"
        onToggleMic={person.self ? onToggleMic : undefined} onToggleCamera={person.self ? onToggleCamera : undefined} />)}
    </div></div>
  </section>;
}
