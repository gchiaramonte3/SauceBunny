// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ instances: [] as Array<{ close: ReturnType<typeof vi.fn>; setMembers: ReturnType<typeof vi.fn> }> }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("./use-media-capture", () => ({ getSessionCapture: () => null, subscribeSessionCapture: () => () => {} }));
vi.mock("../lib/rtc-mesh", () => ({ RtcMesh: class {
  close = vi.fn();
  setMembers = vi.fn();
  constructor() { mocks.instances.push(this); }
} }));
import { useRtcMesh } from "./use-rtc-mesh";

afterEach(() => { cleanup(); mocks.instances.length = 0; });
describe("RTC room lifecycle", () => {
  it("rebuilds for a different room even when all member identities are reused", () => {
    const args = { active: true, sessionKey: "room-a", selfId: "m1", role: "peer",
      memberIds: [{ id: "m0", epoch: 0 }], turn: { url: "", username: "", password: "" },
      stunUrl: "", onLog: vi.fn() };
    const h = renderHook((props) => useRtcMesh(props), { initialProps: args });
    expect(mocks.instances).toHaveLength(1);
    h.rerender({ ...args, turn: { ...args.turn, password: "editing-settings" } });
    expect(mocks.instances).toHaveLength(1);
    h.rerender({ ...args, sessionKey: "room-b" });
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[0].close).toHaveBeenCalledOnce();
    expect(mocks.instances[1].setMembers).toHaveBeenCalledWith(args.memberIds);
    h.unmount();
    expect(mocks.instances[1].close).toHaveBeenCalledOnce();
  });
});
