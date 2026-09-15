import type { SessionState } from "../bindings/SessionState";
import type { ShareState } from "./share-machine";

export type RoomScreenStream = {
  stream: MediaStream;
  ownerId: string;
  who: string;
  /** Local screen preview is always silent; the outgoing track stays intact. */
  isSelf: boolean;
};

/** Select an already-shared screen for the room stage, never start/publish it.
 * External screen capture needs a local monitor; the presenter's existing
 * film/viewer capture must NOT feed itself back into its own monitor. Only
 * ShareController's explicit screen stream is accepted for the self path.
 * Private OBS/NDI preview is a separate surface with its existing precedence.
 */
export function selectRoomScreenStream({ session, shareState, shareStream, sharingMembers, programStreams }: {
  session: SessionState;
  shareState: ShareState;
  shareStream: MediaStream | null;
  sharingMembers: ReadonlySet<string>;
  programStreams: ReadonlyMap<string, MediaStream>;
}): RoomScreenStream | null {
  if (session.role !== "host" && session.role !== "peer") return null;
  const self = session.selfId ?? (session.role === "host" ? "m0" : null);
  const presenter = session.presenter || "m0";
  if (presenter === self) {
    return shareState === "sharing" && shareStream && shareStream.getVideoTracks().length > 0
      ? { stream: shareStream, ownerId: presenter, who: "You", isSelf: true }
      : null;
  }
  if (!sharingMembers.has(presenter)) return null;
  const stream = programStreams.get(presenter);
  // Preserve the remote last frame until sharing is explicitly retracted;
  // an ended track must not quietly substitute the underlying file/timing.
  if (!stream || stream.getVideoTracks().length === 0) return null;
  return { stream, ownerId: presenter, who: session.peers.find(peer => peer.id === presenter)?.name ?? "them", isSelf: false };
}
