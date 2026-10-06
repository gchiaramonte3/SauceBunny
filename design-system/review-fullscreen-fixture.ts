import type { CatalogParticipant } from "./ParticipantTile";

/** What fills the stage. A shared window and a program feed are live and have
 *  no timeline; a file the room plays together has one. */
export type RfSourceKind = "window" | "program" | "file";
/** Where the people go in full screen: the three layouts offered for a pick. */
export type RfLayout = "right" | "bottom" | "float";

export type RfSource = { kind: RfSourceKind; title: string; detail: string; aspect: number; live: boolean; frames: number };

export const RF_SOURCES: Record<RfSourceKind, RfSource> = {
  window: { kind: "window", title: "Jordan's screen", detail: "Application window", aspect: 16 / 10, live: true, frames: 0 },
  program: { kind: "program", title: "Program", detail: "From the edit suite", aspect: 16 / 9, live: true, frames: 0 },
  file: { kind: "file", title: "Cut 3", detail: "Shared with the room", aspect: 16 / 9, live: false, frames: 24 * 60 * 4 },
};

export const RF_LAYOUTS: { id: RfLayout; label: string; note: string }[] = [
  { id: "right", label: "A · Strip on the right", note: "People down the right edge. The picture takes the rest of the window." },
  { id: "bottom", label: "B · Strip along the bottom", note: "People in a row under the picture, which sits above them." },
  { id: "float", label: "C · Floating over the picture", note: "The picture fills the window. People float at a corner and fade with the controls." },
];

const PEOPLE: [string, string, string][] = [
  ["Avery", "AV", "#7c6cf0"], ["Jordan", "JO", "#e0794f"], ["Sam", "SA", "#3fa7d6"], ["Riley", "RI", "#d65db1"],
  ["Morgan", "MO", "#5cb85c"], ["Casey", "CA", "#e5b53a"], ["Quinn", "QU", "#9b8ea9"], ["Devon", "DE", "#4fb3a9"],
];
const LONG = "Jordan Alexandrina Featherstonehaugh-Montgomery";

/** The room: you first, the presenter second, then whoever else is there. */
export function rfPeople(count: number, options: { longNames: boolean; handRaised: boolean; camerasOff: boolean }): CatalogParticipant[] {
  return PEOPLE.slice(0, count).map(([name, initials, color], index) => ({
    id: name.toLowerCase(), name: options.longNames && index === 1 ? LONG : name, initials, color,
    self: index === 0, host: index === 0, presenting: index === 1, sharing: index === 1,
    muted: index === 3, cameraOff: options.camerasOff ? index !== 1 : index === 2,
    handRaised: options.handRaised && index === 2, speaking: index === 1, connection: "connected" as const,
  }));
}
