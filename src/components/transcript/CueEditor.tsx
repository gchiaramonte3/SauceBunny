import { useEffect, useRef, useState } from "react";

/**
 * Inline editor for one transcript cue — swapped in place of the cue <span>
 * on double-click. A textarea (not contenteditable) because the app's other
 * inline renames (queue rows, speaker popover) are all real form fields:
 * native undo, spell-check, and IME behaviour for free.
 *
 * Enter commits · Esc cancels · blur cancels (matches the queue-rename
 * convention: an accidental click elsewhere never writes to disk).
 * Committing an unchanged/empty draft is the parent's job to ignore.
 */

type Props = {
  initialText: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
};

export function CueEditor({ initialText, onCommit, onCancel }: Props) {
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Focus + select on mount, and size the textarea to its content so the
  // paragraph doesn't collapse to a two-line box mid-prose.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  function autosize() {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  return (
    <textarea
      ref={ref}
      className="cp-tx-cue-editor"
      value={text}
      onChange={(e) => { setText(e.target.value); autosize(); }}
      onKeyDown={(e) => {
        // Mid-IME composition, Enter confirms the composed text — it must
        // never commit (and unmount) the editor.
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onCommit(text);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={onCancel}
      /* Don't let the click-to-seek / double-click-to-edit handlers on the
         surrounding cue span re-fire while editing. */
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      rows={1}
      spellCheck
      lang="en"
      aria-label="Edit cue text. Enter saves, Esc cancels"
    />
  );
}
