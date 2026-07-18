import { describe, expect, it, vi } from "vitest";
import { RtcMesh, isOfferer, memberNum, type MeshDeps, type MeshSignalPayload } from "./rtc-mesh";

// ── Fakes (no browser RTC in vitest) ────────────────────────────────────

class FakeSender {
  track: { kind: string } | null;
  replaced: unknown[] = [];
  params: { encodings: Array<Record<string, unknown>> } = { encodings: [] };
  constructor(track: { kind: string }) { this.track = track; }
  replaceTrack(t: unknown) { this.replaced.push(t); return Promise.resolve(); }
  getParameters() { return this.params; }
  setParameters(p: typeof this.params) { this.params = p; return Promise.resolve(); }
}

class FakePc {
  static instances: FakePc[] = [];
  senders: FakeSender[] = [];
  closed = false;
  restartCalls = 0;
  offers = 0;
  answers = 0;
  remoteDescs: unknown[] = [];
  localDescs: unknown[] = [];
  candidates: unknown[] = [];
  connectionState = "new";
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { FakePc.instances.push(this); }
  addTrack(track: { kind: string }) {
    const s = new FakeSender(track);
    this.senders.push(s);
    return s as unknown as RTCRtpSender;
  }
  getSenders() { return this.senders as unknown as RTCRtpSender[]; }
  createOffer() { this.offers++; return Promise.resolve({ type: "offer", sdp: "sdp-offer" }); }
  createAnswer() { this.answers++; return Promise.resolve({ type: "answer", sdp: "sdp-answer" }); }
  setLocalDescription(d: unknown) { this.localDescs.push(d); return Promise.resolve(); }
  setRemoteDescription(d: unknown) { this.remoteDescs.push(d); return Promise.resolve(); }
  addIceCandidate(c: unknown) { this.candidates.push(c); return Promise.resolve(); }
  restartIce() { this.restartCalls++; }
  close() { this.closed = true; }
  fireConnectionState(st: string) {
    this.connectionState = st;
    this.onconnectionstatechange?.();
  }
}

function fakeTrack(kind: string) {
  return { kind, getSettings: () => ({ height: 720 }) };
}
function fakeStream(kinds: string[]) {
  const tracks = kinds.map(fakeTrack);
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
  } as unknown as MediaStream;
}

function makeMesh(selfId: string, overrides: Partial<MeshDeps> = {}) {
  FakePc.instances = [];
  const sent: Array<{ to: string; payload: MeshSignalPayload }> = [];
  const states: Array<{ id: string; state: string }> = [];
  const deps: MeshDeps = {
    selfId,
    iceServers: [],
    createPc: () => new FakePc() as unknown as RTCPeerConnection,
    sendSignal: (to, payload) => sent.push({ to, payload }),
    onRemoteStream: () => {},
    onState: (id, state) => states.push({ id, state }),
    getLocalStream: () => fakeStream(["video", "audio"]),
    log: vi.fn(),
    ...overrides,
  };
  return { mesh: new RtcMesh(deps), sent, states };
}

const flush = () => new Promise<void>((r) => { setTimeout(r, 0); });

// ── The pack's required coverage ────────────────────────────────────────

describe("rtc mesh", () => {
  it("offerer determinism: the lower member id offers, the higher waits", async () => {
    const a = makeMesh("m0");
    a.mesh.setMembers(["m2"]);
    await flush();
    expect(a.sent.some((s) => s.to === "m2" && s.payload.t === "offer")).toBe(true);

    const b = makeMesh("m2");
    b.mesh.setMembers(["m0"]);
    await flush();
    expect(b.sent.some((s) => s.payload.t === "offer")).toBe(false);
    // ...but it answers an incoming offer.
    await b.mesh.handleSignal("m0", { t: "offer", sdp: "sdp-offer" });
    expect(b.sent.some((s) => s.to === "m0" && s.payload.t === "answer")).toBe(true);
  });

  it("member ordering is numeric, not lexicographic", () => {
    expect(memberNum("m10") > memberNum("m9")).toBe(true);
    expect(isOfferer("m9", "m10")).toBe(true);
    expect(isOfferer("m10", "m9")).toBe(false);
  });

  it("device switch replaces every outbound sender track", async () => {
    const { mesh } = makeMesh("m0");
    mesh.setMembers(["m1", "m2"]);
    await flush();
    const next = fakeStream(["video", "audio"]);
    await mesh.replaceLocalStream(next);
    for (const pc of FakePc.instances) {
      for (const s of pc.senders) expect(s.replaced.length).toBe(1);
    }
  });

  it("outbound video is capped via scaleResolutionDownBy", async () => {
    makeMesh("m0").mesh.setMembers(["m1"]);
    await flush();
    const videoSender = FakePc.instances[0].senders.find((s) => s.track?.kind === "video");
    expect(videoSender?.params.encodings[0]?.scaleResolutionDownBy).toBe(2); // 720/360
  });

  it("teardown closes every peer connection and retracts streams", async () => {
    const retracted: string[] = [];
    const { mesh } = makeMesh("m0", { onRemoteStream: (id, s) => { if (s === null) retracted.push(id); } });
    mesh.setMembers(["m1", "m2", "m3"]);
    await flush();
    mesh.close();
    expect(FakePc.instances.every((pc) => pc.closed)).toBe(true);
    expect(retracted.sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("one ICE restart, then failed (avatar + loud log)", async () => {
    const { mesh, states } = makeMesh("m0");
    mesh.setMembers(["m1"]);
    await flush();
    const pc = FakePc.instances[0];
    pc.fireConnectionState("failed");
    await flush();
    expect(pc.restartCalls).toBe(1);
    expect(mesh.peerState("m1")).toBe("connecting"); // still trying
    pc.fireConnectionState("failed");
    await flush();
    expect(pc.restartCalls).toBe(1); // no second restart
    expect(mesh.peerState("m1")).toBe("failed");
    expect(states.some((s) => s.id === "m1" && s.state === "failed")).toBe(true);
  });

  it("a departed member's connection is torn down on roster change", async () => {
    const { mesh } = makeMesh("m0");
    mesh.setMembers(["m1", "m2"]);
    await flush();
    mesh.setMembers(["m2"]);
    expect(FakePc.instances[0].closed).toBe(true);
    expect(FakePc.instances[1].closed).toBe(false);
  });


  it("share override owns video senders through a device switch, camera returns on null", async () => {
    const local = fakeStream(["video", "audio"]);
    const { mesh } = makeMesh("m0", { getLocalStream: () => local });
    mesh.setMembers(["m1"]);
    await flush();
    const share = { kind: "video", getSettings: () => ({ height: 900 }) } as unknown as MediaStreamTrack;
    await mesh.setVideoOverride(share);
    const pc = FakePc.instances[0];
    const vs = pc.senders.find((s) => s.track?.kind === "video");
    expect(vs?.replaced.at(-1)).toBe(share);
    // Device switch mid-share: the share KEEPS the video slot.
    await mesh.replaceLocalStream(fakeStream(["video", "audio"]));
    expect(vs?.replaced.at(-1)).toBe(share);
    // Share ends: the camera track returns.
    await mesh.setVideoOverride(null);
    expect((vs?.replaced.at(-1) as { kind?: string })?.kind).toBe("video");
    expect(vs?.replaced.at(-1)).not.toBe(share);
  });
});
