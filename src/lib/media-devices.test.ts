import { describe, expect, it } from "vitest";
import { deviceLabel } from "./media-devices";

/**
 * The one rule for naming a device the browser has not named.
 *
 * It had three copies - DevicePanel, GreenRoomDevices, AvSettingsPane - and an
 * earlier pass consolidated the first two into a shared DeviceSelect while
 * leaving the third, in a pane whose chrome differs enough that sharing the
 * whole control would have been wrong. Sharing the RULE is right regardless:
 * the reasoning behind it (below) is what wants a single home.
 */
describe("deviceLabel", () => {
  const dev = (label: string) => ({ label }) as MediaDeviceInfo;

  it("uses the real name when the browser has given one", () => {
    expect(deviceLabel(dev("FaceTime HD Camera"), 0, "Camera")).toBe("FaceTime HD Camera");
  });

  it("names an unlabelled device by position, one-based", () => {
    // The pre-permission state, which is what every user sees FIRST: the
    // browser withholds device labels until capture is allowed, so without
    // this the picker is a list of blank rows - indistinguishable from broken.
    expect(deviceLabel(dev(""), 0, "Camera")).toBe("Camera 1");
    expect(deviceLabel(dev(""), 2, "Microphone")).toBe("Microphone 3");
    expect(deviceLabel(dev(""), 0, "Speakers")).toBe("Speakers 1");
  });

  it("treats a whitespace-only label as a real one", () => {
    // Deliberately NOT trimmed: a driver that reports " " is reporting
    // something, and second-guessing it here would mean the picker disagrees
    // with what the OS sound panel shows for the same device.
    expect(deviceLabel(dev(" "), 0, "Camera")).toBe(" ");
  });
});
