// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DeviceSelect } from "./DeviceSelect";

/**
 * This replaced four byte-identical copies of the same markup (camera and mic,
 * in DevicePanel and GreenRoomDevices). The refactor is only safe if what it
 * renders is what they rendered, and nothing else here can check that — the
 * class names are the entire contract with room.css, and a component test is
 * the only thing standing between a rename and an unstyled control.
 */
const dev = (deviceId: string, label = ""): MediaDeviceInfo =>
  ({ deviceId, label, kind: "videoinput", groupId: "g", toJSON: () => ({}) }) as MediaDeviceInfo;

afterEach(cleanup);

describe("DeviceSelect", () => {
  it("keeps the class names room.css styles it by", () => {
    const { container } = render(
      <DeviceSelect kind="camera" devices={[dev("a", "FaceTime HD")]} value="a" onPick={() => {}} />,
    );
    expect(container.querySelector("label.cp-colobby-field")).not.toBe(null);
    expect(container.querySelector("span.cp-colobby-field-label")).not.toBe(null);
    expect(container.querySelector("select.cp-colobby-input")).not.toBe(null);
  });

  it("names a device the browser has not labelled yet by position", () => {
    // The browser withholds device labels until permission is granted, so
    // this is what the picker looks like BEFORE the user says yes. Without
    // the fallback it is a list of blank rows, which reads as broken.
    render(<DeviceSelect kind="camera" devices={[dev("a"), dev("b")]} value={null} onPick={() => {}} />);
    expect(screen.getByRole("option", { name: "Camera 1" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Camera 2" })).toBeTruthy();
  });

  it("prefers a real label when there is one", () => {
    render(<DeviceSelect kind="microphone" devices={[dev("a", "Shure MV7")]} value="a" onPick={() => {}} />);
    expect(screen.getByRole("option", { name: "Shure MV7" })).toBeTruthy();
  });

  it("offers Default only when there is nothing to choose from", () => {
    const empty = render(<DeviceSelect kind="camera" devices={[]} value={null} onPick={() => {}} />);
    expect(screen.getByRole("option", { name: "Default" })).toBeTruthy();
    empty.unmount();
    render(<DeviceSelect kind="camera" devices={[dev("a", "Cam")]} value="a" onPick={() => {}} />);
    expect(screen.queryByRole("option", { name: "Default" })).toBe(null);
  });

  it("reports the system default as null, not as an empty string", () => {
    // `e.target.value || null`. The capture layer treats null as "let the OS
    // decide"; an empty string would be a deviceId that matches nothing.
    const onPick = vi.fn();
    render(<DeviceSelect kind="camera" devices={[dev("a", "Cam")]} value="a" onPick={onPick} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } });
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("labels each kind with its own word", () => {
    const cam = render(<DeviceSelect kind="camera" devices={[]} value={null} onPick={() => {}} />);
    expect(cam.container.textContent).toContain("Camera");
    cam.unmount();
    render(<DeviceSelect kind="microphone" devices={[]} value={null} onPick={() => {}} />);
    expect(screen.getByText(/Microphone/)).toBeTruthy();
  });
});
