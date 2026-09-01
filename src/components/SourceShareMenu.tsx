import { useRef } from "react";
import { useDismiss } from "../hooks/use-dismiss";
import { useMenuKeys } from "../hooks/use-menu-keys";

/**
 * Every way of getting the source in front of the room, behind ONE button.
 *
 * The session header used to carry these as four separate controls - a
 * "cannot open this" chip, a live-view button, a preview-copy button and a
 * send-the-original button - plus Copy join code and End session. On a laptop
 * they collided: the labels literally overlapped, and the way OUT of a session
 * was the thing being pushed off the edge.
 *
 * The header's own comment already describes the order in which things are
 * meant to yield, and the mistake was putting these in `.cp-room-title`, the
 * half designed to TRUNCATE. Making them smaller would only have made a
 * cramped row of small things; collapsing four controls into one is what
 * actually gives the header its space back.
 *
 * The options are ordered by how fast they get a picture in front of someone,
 * because that is the question being asked when a guest cannot open something.
 */
export type ShareOption = {
  key: string;
  label: string;
  /** What it costs the person choosing it: "About a second", "2.1 GB". */
  detail: string;
  onSelect: () => void;
};

export function SourceShareMenu({ at, options, onClose }: {
  at: { x: number; y: number };
  options: readonly ShareOption[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // useDismiss, not a hand-rolled outside-click: it brings Escape with it, and
  // dismiss-parity-contract exists because two siblings each implemented half.
  useDismiss(ref, onClose);
  useMenuKeys(ref, true, onClose);

  return (
    <div
      ref={ref}
      className="cp-sharemenu"
      role="menu"
      aria-label="Share this source"
      style={{ left: at.x, top: at.y }}
    >
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="menuitem"
          className="cp-sharemenu-item"
          onClick={() => { o.onSelect(); onClose(); }}
        >
          <span className="cp-sharemenu-label">{o.label}</span>
          {/* The cost, always. "Send the original" and "Show them live" differ
              by about twenty eight minutes on a big master, and a menu that
              hides that is asking people to guess. */}
          <span className="cp-sharemenu-detail">{o.detail}</span>
        </button>
      ))}
    </div>
  );
}
