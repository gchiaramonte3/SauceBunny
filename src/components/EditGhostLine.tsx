import type { Ghost } from "../lib/edit-model";

/** A removed line, shown where it was cut, with a way to put it back on every track. */
export function EditGhostLine({ ghost, color, name, onRestore }: { ghost: Ghost; color: string | undefined; name: string; onRestore: (ghost: Ghost) => void }) {
  const text = ghost.words.map((word) => word.text).join(" ");
  return <div className="cp-te-ghost-line" style={{ "--te-speaker": color } as React.CSSProperties}>
    <div className="cp-te-para-head"><span className="cp-te-swatch" aria-hidden="true" /><span className="cp-te-para-name">{name}</span>
      <span className="cp-te-ghost-tag">Removed</span>
      <button type="button" className="btn btn-ghost cp-te-btn cp-te-ghost-restore" onClick={() => onRestore(ghost)}
        aria-label={`Restore ${name}'s line “${text}”`} title="Put this line back on every track">↺ Restore</button></div>
    <p className="cp-te-para-text cp-te-ghost-text">{text}</p>
  </div>;
}
