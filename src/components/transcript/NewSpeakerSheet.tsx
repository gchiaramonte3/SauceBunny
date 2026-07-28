import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SPEAKER_PALETTE } from "./helpers";

/** One speaker already in this transcript, offered as an alternative target. */
export type SpeakerSuggestion = {
  tag: string;
  name: string;
  color: string;
  /** Seconds of speech. The axis the list is ordered by. */
  talkSeconds: number;
  /** The untagged bucket. A valid target — putting lines back is how you undo
   *  a bad split — but not a person, so it never outranks one. */
  untagged?: boolean;
};

/**
 * Name the speaker you just pulled out of someone else's dialogue.
 *
 * Opens immediately after a split, because splitting and naming are one
 * intention: nobody lassoes a stretch of dialogue in order to create
 * "CAST_A". Leaving the tag unnamed and expecting the user to go and find it
 * in the roster would turn one gesture into three.
 *
 * Two ways out, deliberately. Type a name for a person who is not in the
 * transcript yet, or pick one who already is — because the commonest reason a
 * diarizer merges two people is that it also SPLIT one of them somewhere
 * else, and the fix for the second half is to fold the selection into an
 * existing speaker rather than invent another.
 *
 * ORDERING AND SCROLL. The list used to render in the roster's own order,
 * which is first appearance, unbounded. On a twenty-six person cast that is a
 * ragged eight-row cloud of chips in first-heard order — so the lead you
 * actually want is wherever they happened to first speak, and the sheet grows
 * until it runs off the screen. It is now capped and scrolled, and ordered by
 * talk time, because the person you are most likely to be reassigning lines to
 * is the person who does most of the talking.
 *
 * THE NAME FIELD IS ALSO THE FILTER. Typing promotes matching speakers to the
 * front rather than filtering the list down. Promotion beats filtering here
 * for one specific reason: the field's PRIMARY job is naming somebody new, so
 * a filter would empty the list on every ordinary use and read as an error
 * state for the most common action in the sheet. Promotion never empties, and
 * a second search box for a twelve-chip list would be more chrome than the
 * decision deserves.
 */
export function NewSpeakerSheet({ suggestions, initialColor, onName, onPickExisting, onCancel }: {
  suggestions: SpeakerSuggestion[];
  initialColor: string;
  onName: (name: string, color: string) => void;
  onPickExisting: (tag: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(initialColor);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } };
    // Capture, so it beats App's global key map the way the other dialogs do.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const query = name.trim().toLowerCase();
  const ordered = useMemo(() => {
    const matches = (s: SpeakerSuggestion) => query.length > 0 && s.name.toLowerCase().includes(query);
    return [...suggestions].sort((a, b) => {
      // What you are typing wins, so a known name surfaces as you spell it.
      if (matches(a) !== matches(b)) return matches(a) ? -1 : 1;
      // Then people, loudest first. The untagged bucket is not a person and
      // sinks below every one of them however much unattributed speech there is.
      if (!!a.untagged !== !!b.untagged) return a.untagged ? 1 : -1;
      return b.talkSeconds - a.talkSeconds;
    });
  }, [suggestions, query]);

  return createPortal(
    <div className="cp-spk-backdrop" onMouseDown={onCancel}>
      <div
        className="cp-newspk"
        role="dialog"
        aria-modal="true"
        aria-label="Name the new speaker"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="cp-newspk-head">Who is speaking?</div>
        <form
          className="cp-newspk-row"
          onSubmit={(e) => { e.preventDefault(); onName(name.trim(), color); }}
        >
          <button
            type="button"
            className="cp-newspk-pip"
            style={{ background: color }}
            // The colour is chosen by cycling rather than by opening a second
            // dialog on top of this one. A picker-in-a-picker for something
            // this small is more chrome than the decision deserves.
            onClick={() => setColor(nextColor(color))}
            aria-label="Change colour"
            title="Change colour"
          />
          <input
            ref={inputRef}
            className="cp-input cp-newspk-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            spellCheck={false}
            maxLength={60}
          />
          <button type="submit" className="btn btn-ghost btn-compact" disabled={!name.trim()}>
            Name them
          </button>
        </form>

        {ordered.length > 0 && (
          <>
            <div className="cp-newspk-or">
              or give these lines to someone already here
              <span className="cp-newspk-count">{ordered.length}</span>
            </div>
            <div className="cp-newspk-list">
              {ordered.map((s) => {
                const hit = query.length > 0 && s.name.toLowerCase().includes(query);
                return (
                  <button
                    key={s.tag}
                    type="button"
                    className={"cp-newspk-suggest" + (hit ? " hit" : "")}
                    onClick={() => onPickExisting(s.tag)}
                    title={`Give these lines to ${s.name}`}
                  >
                    <span className="cp-newspk-pip sm" style={{ background: s.color }} aria-hidden="true" />
                    <span className="cp-newspk-sname">{s.name}</span>
                    {/* The number is what makes the order legible. Without it
                        "why is this person first?" has no answer on screen. */}
                    <span className="cp-newspk-talk">{formatTalk(s.talkSeconds)}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Talk time, short enough to sit inside a chip. */
function formatTalk(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/**
 * Step to the next palette entry, wrapping.
 *
 * Derived from SPEAKER_PALETTE rather than restated. The list here used to be
 * a hardcoded copy of the OLD six-colour palette, left behind when the palette
 * became twelve searched hues — so two things were broken at once. Six of the
 * twelve real speaker colours were unreachable from this sheet, and because
 * `indexOf` returns -1 for a colour that is not in the stale list, the FIRST
 * click on the pip always landed on entry 0, which was the app's accent green:
 * the one hue the palette deliberately excludes, because a speaker wearing the
 * accent is indistinguishable from a selected control.
 *
 * A comment claiming two lists are in step is not a mechanism. This is.
 */
function nextColor(current: string): string {
  const i = SPEAKER_PALETTE.indexOf(current);
  // An unknown colour (a custom pick, or a tag with no palette slot) starts at
  // the beginning rather than wrapping off the end into a fixed entry.
  return SPEAKER_PALETTE[i < 0 ? 0 : (i + 1) % SPEAKER_PALETTE.length];
}
