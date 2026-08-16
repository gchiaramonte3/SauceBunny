import { IconMic, IconVideo } from "./Icons";
import { deviceLabel } from "../lib/media-devices";

/**
 * One labelled device picker: camera or microphone.
 *
 * The same thirteen lines of markup existed four times — camera and mic, in
 * both DevicePanel and GreenRoomDevices — byte for byte identical down to the
 * class names, because both surfaces are the same control in two places the
 * user reaches it from (the green room before joining, the panel once inside).
 *
 * That is the kind of duplicate that stays correct right up until one copy
 * gets an aria-label or a disabled state and the other does not, and nobody
 * notices because both still render.
 *
 * A DEVICE WITH NO LABEL IS THE NORMAL CASE, not an edge one: the browser
 * withholds device labels until permission is granted, so before the user
 * says yes every option here is empty. Hence the positional fallback
 * ("Camera 1", "Camera 2") rather than a blank row — a picker of blank rows
 * is indistinguishable from a broken one.
 */
export function DeviceSelect({ kind, devices, value, onPick }: {
  kind: "camera" | "microphone";
  devices: readonly MediaDeviceInfo[];
  /** Chosen deviceId, or null for the system default. */
  value: string | null;
  onPick: (deviceId: string | null) => void;
}) {
  const isCamera = kind === "camera";
  const title = isCamera ? "Camera" : "Microphone";
  return (
    <label className="cp-colobby-field">
      <span className="cp-colobby-field-label">
        {isCamera ? <IconVideo size={12} /> : <IconMic size={12} />} {title}
      </span>
      <select
        className="cp-colobby-input"
        value={value ?? ""}
        onChange={(e) => onPick(e.target.value || null)}
      >
        {devices.length === 0 && <option value="">Default</option>}
        {devices.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {deviceLabel(d, i, title)}
          </option>
        ))}
      </select>
    </label>
  );
}
