import { useCallback, useState } from "react";
import type { Ghost } from "../lib/edit-model";
import { EditGhostMenu } from "./EditGhostMenu";

/**
 * A removed line where it was cut, read in the flow: struck through and quiet,
 * with Restore on hover or focus and in the right-click menu, as a text
 * editor shows a deletion. Between paragraphs it is a line of its own; inside
 * one, a phrase. It used to be a row with its own header, a "Removed" tag and
 * a Restore button, eleven elements for what was often one word.
 */
export function EditGhost({ ghost, who, color, onRestore, line = false }: {
  /** The speaker's name when it differs from the text around it. */
  ghost: Ghost; who: string | null; color: string | undefined; onRestore: (ghost: Ghost) => void; line?: boolean;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const text = ghost.words.map((word) => word.text).join(" ");
  const Tag = line ? "p" : "span";
  return <Tag className={`cp-te-ghost${line ? " is-line" : ""}`} style={{ "--te-speaker": color } as React.CSSProperties}
    onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
    {who && <span className="cp-te-ghost-who">{who}:</span>}
    <s className="cp-te-ghost-text">{text}</s>
    <button type="button" className="cp-te-restore" aria-label={`Restore ${who ? `${who}'s line ` : ""}“${text}”`} title="Restore this line on every track"
      onClick={() => onRestore(ghost)}>↺</button>{" "}
    {menu && <EditGhostMenu at={menu} onRestore={() => onRestore(ghost)} onClose={close} />}
  </Tag>;
}
