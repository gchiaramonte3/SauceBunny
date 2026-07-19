/**
 * THE color picker. One swatch language for every color choice in the app
 * (avatar, speaker, pen, captions): round preset dots, a white selection
 * ring (never the accent), and ALWAYS a trailing custom well that opens
 * the native macOS color panel - which includes its own hex-value entry,
 * so every surface can take an exact custom value. Single choice, so the
 * group is a radiogroup.
 */
export function ColorSwatches({ colors, value, onPick, size = 22, ariaLabel }: {
  colors: readonly string[];
  value: string;
  onPick: (hex: string) => void;
  size?: number;
  ariaLabel: string;
}) {
  const picked = (c: string) => c.toLowerCase() === value.toLowerCase();
  const isPreset = colors.some(picked);
  return (
    <div
      className="cp-swatches"
      role="radiogroup"
      aria-label={ariaLabel}
      style={{ ["--swatch-size" as string]: `${size}px` }}
    >
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={picked(c)}
          className={"cp-swatch" + (picked(c) ? " picked" : "")}
          style={{ background: c }}
          title={c}
          aria-label={`Color ${c}`}
          onClick={() => onPick(c)}
        />
      ))}
      <label
        role="radio"
        aria-checked={!isPreset}
        className={"cp-swatch custom" + (isPreset ? "" : " picked")}
        title="Custom color"
        style={isPreset ? undefined : { background: value }}
      >
        <input
          type="color"
          value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"}
          onChange={(e) => onPick(e.target.value)}
          aria-label="Custom color"
        />
      </label>
    </div>
  );
}
