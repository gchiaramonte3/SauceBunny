/** Room metadata sharing was held at the implementation permission gate.
 * Enable only after approval to send project/sequence names and identifiers
 * to active room participants. Local pairing and the diagnostic proof work
 * without this; no pairing secret or project path belongs on the room wire. */
export const PREMIERE_ROOM_MARKERS_ENABLED: boolean = false;
