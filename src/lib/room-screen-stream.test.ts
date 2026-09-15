import { describe, expect, it } from "vitest";
import type { SessionState } from "../bindings/SessionState";
import { selectRoomScreenStream } from "./room-screen-stream";

const stream = (video = true) => ({ getVideoTracks: () => video ? [{ kind: "video", readyState: "live" }] : [] }) as unknown as MediaStream;
const session: SessionState = { role: "host", code: "test-room", selfId: "m0", presenter: "m0", presenterEpoch: 1,
  title: "Review", error: null, peers: [{ id: "m1", name: "Guest", epoch: 1 }] };
const input = () => ({ session, shareState: "sharing" as const, shareStream: stream(),
  sharingMembers: new Set(["m1"]), programStreams: new Map([["m1", stream()]]) });

describe("room screen stage selection", () => {
  it("shows the host's explicitly shared screen without waiting for a self mesh echo", () => {
    const args = input();
    expect(selectRoomScreenStream(args)).toEqual({ stream: args.shareStream, ownerId: "m0", who: "You", isSelf: true });
    expect(selectRoomScreenStream({ ...args, session: { ...session, selfId: null } })?.isSelf).toBe(true);
  });
  it("never starts a picture for a pending/idle share or the presenter's viewer-capture echo", () => {
    const args = input(); args.programStreams.set("m0", stream()); args.sharingMembers.add("m0");
    for (const shareState of ["idle", "starting"] as const) expect(selectRoomScreenStream({ ...args, shareState })).toBeNull();
    expect(selectRoomScreenStream({ ...args, shareStream: null })).toBeNull();
    expect(selectRoomScreenStream({ ...args, shareStream: stream(false) })).toBeNull();
  });
  it("respects the presenter floor for hosts and guests without changing share permission", () => {
    const args = input();
    const guestPresenter = { ...session, role: "peer", selfId: "m1", presenter: "m1" };
    expect(selectRoomScreenStream({ ...args, session: guestPresenter })?.isSelf).toBe(true);
    const result = selectRoomScreenStream({ ...args, session: { ...session, presenter: "m1" } });
    expect(result).toEqual({ stream: args.programStreams.get("m1"), ownerId: "m1", who: "Guest", isSelf: false });
    expect(selectRoomScreenStream({ ...args, session: { ...guestPresenter, presenter: "m0" } })).toBeNull();
  });
  it("requires the current presenter's sharing flag and received video, not a camera or other sharer", () => {
    const args = { ...input(), session: { ...session, presenter: "m1" } };
    expect(selectRoomScreenStream({ ...args, sharingMembers: new Set(["m2"]) })).toBeNull();
    expect(selectRoomScreenStream({ ...args, programStreams: new Map([["m2", stream()]]) })).toBeNull();
    expect(selectRoomScreenStream({ ...args, programStreams: new Map([["m1", stream(false)]]) })).toBeNull();
    expect(selectRoomScreenStream({ ...args, session: { ...session, role: "off" } })).toBeNull();
  });
  it("retains a received last frame until an explicit stop instead of changing source silently", () => {
    const ended = { getVideoTracks: () => [{ kind: "video", readyState: "ended" }] } as unknown as MediaStream;
    const args = { ...input(), session: { ...session, presenter: "m1" }, programStreams: new Map([["m1", ended]]) };
    expect(selectRoomScreenStream(args)?.stream).toBe(ended);
    expect(selectRoomScreenStream({ ...args, sharingMembers: new Set() })).toBeNull();
  });
});
