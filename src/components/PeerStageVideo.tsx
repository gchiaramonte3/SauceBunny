import { useEffect, useRef } from "react";

/**
 * A peer's live view, filling the stage.
 *
 * The first version of this feature put the presenter's captured monitor onto
 * the mesh as a camera-track override, which meant it arrived in the guest's
 * PEOPLE TILE - a thumbnail beside their face. That is not where an asset
 * goes, and it is why "show them what I am watching" did not answer the
 * problem it was built for: the guest still had nothing on the stage.
 *
 * The stream itself was always fine. It was being rendered in the wrong place.
 *
 * IT IS A LIVE VIEW AND SAYS SO. This is a real-time encode that degrades to
 * fit the link, which CLAUDE.md excludes as a playback surface because a
 * reviewer judging a grade has to see compression that is in the source and
 * not in the transport. Filling the stage with it makes that MORE important to
 * label, not less: on a tile nobody would mistake it for the master, and here
 * they might.
 */
export function PeerStageVideo({ stream, who }: {
  stream: MediaStream;
  /** Whose monitor this is, for the badge. */
  who: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // srcObject, not src: a MediaStream has no URL, and assigning one through
    // createObjectURL has been deprecated for years and leaks the handle.
    el.srcObject = stream;
    // Muted: the mesh already carries this peer's audio through the people
    // tile. Playing it here as well would double every voice in the room.
    el.muted = true;
    const play = () => { void el.play().catch(() => { /* autoplay refused */ }); };
    play();
    return () => {
      el.srcObject = null;
    };
  }, [stream]);

  return (
    <div className="cp-peerstage">
      <video ref={ref} className="cp-peerstage-video" playsInline autoPlay muted />
      <span className="cp-peerstage-badge">
        {`Live view of ${who}'s screen`}
      </span>
    </div>
  );
}
