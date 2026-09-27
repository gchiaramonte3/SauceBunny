import { useId, useRef, useState } from "react";
import { IconSettings } from "../src/components/Icons";
import { useDismiss } from "../src/hooks/use-dismiss";

export type TeTextStyle = { family: "serif" | "sans"; size: number; leading: "tight" | "normal" | "loose" };
export const teTextSizes = { min: 11, max: 24 };
export const teLeading: Record<TeTextStyle["leading"], number> = { tight: 1.35, normal: 1.6, loose: 1.9 };

/** The style as CSS variables for the pane that owns it. */
export const teTextVars = (style: TeTextStyle) => ({
  "--te-text-size": `${style.size}px`,
  "--te-text-leading": teLeading[style.leading],
  "--te-text-family": style.family === "serif" ? "var(--te-prose)" : "var(--font-ui)",
}) as React.CSSProperties;

type Props = { pane: string; style: TeTextStyle; onChange: (style: TeTextStyle) => void };

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (value: T) => void }) {
  const active = options.findIndex(([option]) => option === value);
  return <div className="cp-te-set-row"><span className="cp-te-set-label" aria-hidden="true">{label}</span>
    <div className="cp-segmented cp-te-set-seg" role="radiogroup" aria-label={label} style={{ "--seg-count": options.length, "--seg-active": active } as React.CSSProperties}>
      {options.map(([option, name]) => <button key={option} type="button" role="radio" aria-checked={option === value}
        className={option === value ? "active" : undefined} onClick={() => onChange(option)}>{name}</button>)}
    </div>
  </div>;
}

/**
 * The gear on a transcript pane: typeface, size and line spacing, for that
 * pane only, so the source can stay compact while the edit reads large.
 */
export function TeTextSettings({ pane, style, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useDismiss(box, () => setOpen(false), open);
  const size = (next: number) => onChange({ ...style, size: Math.max(teTextSizes.min, Math.min(teTextSizes.max, next)) });
  return <div ref={box} className="cp-te-set">
    <button type="button" className={`cp-icon-btn cp-te-set-btn${open ? " active" : ""}`} aria-expanded={open} aria-controls={id}
      aria-label={`${pane} text settings`} title={`${pane} text settings: typeface, size and spacing`} onClick={() => setOpen((value) => !value)}>
      <IconSettings size={14} /></button>
    {open && <div id={id} className="cp-te-set-pop" role="dialog" aria-label={`${pane} text settings`}>
      <Choice label="Typeface" value={style.family} options={[["serif", "Serif"], ["sans", "Sans"]]} onChange={(family) => onChange({ ...style, family })} />
      <div className="cp-te-set-row"><label className="cp-te-set-label" htmlFor={`${id}-size`}>Size</label>
        <div className="cp-te-set-size">
          <button type="button" className="cp-icon-btn" aria-label="Smaller text" title="Smaller text" disabled={style.size <= teTextSizes.min} onClick={() => size(style.size - 1)}>A−</button>
          <input id={`${id}-size`} type="range" min={teTextSizes.min} max={teTextSizes.max} step={1} value={style.size} onChange={(event) => size(Number(event.target.value))} />
          <button type="button" className="cp-icon-btn" aria-label="Larger text" title="Larger text" disabled={style.size >= teTextSizes.max} onClick={() => size(style.size + 1)}>A+</button>
          <output className="cp-te-set-value" htmlFor={`${id}-size`}>{style.size} pt</output>
        </div>
      </div>
      <Choice label="Spacing" value={style.leading} options={[["tight", "Tight"], ["normal", "Normal"], ["loose", "Loose"]]} onChange={(leading) => onChange({ ...style, leading })} />
      <p className="cp-te-set-sample" style={teTextVars(style)}>Let's go, guys, dig in deep.</p>
    </div>}
  </div>;
}
