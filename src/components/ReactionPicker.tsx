import { HAND_GLYPH, REACTION_EMOTES } from "../lib/reactions";

/**
 * The room cluster's reaction popover (sibling of SharePicker/DevicePanel,
 * same upward anchor): four transient emotes that fire-and-forget, plus
 * Raise hand - the one PERSISTENT state, styled apart and showing its
 * current direction ("Lower hand" while up).
 */
export function ReactionPicker({ onReact, handRaised, onToggleHand, onClose }: {
  onReact: (emote: string) => void;
  handRaised: boolean;
  onToggleHand: () => void;
  onClose: () => void;
}) {
  return (
    <div className="cp-react-pick" role="menu" aria-label="Send a reaction">
      <div className="cp-react-pick-row">
        {REACTION_EMOTES.map((e) => (
          <button
            key={e.key}
            type="button"
            role="menuitem"
            className="cp-react-pick-btn"
            title={e.label}
            aria-label={`React with ${e.label}`}
            onClick={() => { onReact(e.key); onClose(); }}
          >
            {e.glyph}
          </button>
        ))}
      </div>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={handRaised}
        className={"cp-react-pick-hand" + (handRaised ? " up" : "")}
        onClick={() => { onToggleHand(); onClose(); }}
      >
        <span aria-hidden>{HAND_GLYPH}</span> {handRaised ? "Lower hand" : "Raise hand"}
      </button>
    </div>
  );
}
