import { describe, expect, it, vi } from "vitest";
import {
  RtcMesh, isOfferer, memberNum, MESH_MAX_OFFERS, MESH_WATCHDOG_MS,
  type MeshDeps, type MeshSignalPayload,
} from "./rtc-mesh";
import { selectRoomScreenStream } from "./room-screen-stream";

// ── Fakes (no browser RTC in vitest) ────────────────────────────────────

class FakeSender {
  track: { kind: string } | null;
  replaced: unknown[] = [];
  params: { encodings: Array<Record<string, unknown>> } = { encodings: [] };
  constructor(track: { kind: string }) { this.track = track; }
  replaceTrack(t: unknown) { this.track = t as { kind: string } | null; this.replaced.push(t); return Promise.resolve(); }
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
  transceivers: { kind: string; direction: string; streams: unknown[]; receiver: object }[] = [];
  addTransceiver(kind: string, init?: { direction?: string; streams?: unknown[] }) {
    const receiver = {};
    this.transceivers.push({
      receiver, kind, direction: init?.direction ?? "sendrecv", streams: init?.streams ?? [],
    });
    const s = new FakeSender({ kind });
    s.track = null; // a placeholder sender carries no track yet
    this.senders.push(s);
    return { sender: s as unknown as RTCRtpSender, receiver };
  }
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

/** A mutable stand-in for the accumulating per-peer MediaStream (node has no
 *  MediaStream, which is why the mesh takes createStream as a dep). */
function fakeMutableStream() {
  const tracks: Array<{ kind: string; id?: string }> = [];
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getTrackById: (id: string) => tracks.find((t) => t.id === id) ?? null,
    addTrack: (t: { kind: string; id?: string }) => { tracks.push(t); },
    removeTrack: (t: { kind: string }) => {
      const i = tracks.indexOf(t);
      if (i >= 0) tracks.splice(i, 1);
    },
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
    createStream: () => fakeMutableStream(),
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
    a.mesh.setMembers([{ id: "m2", epoch: 1 }]);
    await flush();
    expect(a.sent.some((s) => s.to === "m2" && s.payload.t === "offer")).toBe(true);

    const b = makeMesh("m2");
    b.mesh.setMembers([{ id: "m0", epoch: 1 }]);
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
    mesh.setMembers([{ id: "m1", epoch: 1 }, { id: "m2", epoch: 1 }]);
    await flush();
    const next = fakeStream(["video", "audio"]);
    await mesh.replaceLocalStream(next);
    for (const pc of FakePc.instances) {
      for (const s of pc.senders.slice(0, 2)) expect(s.replaced.length).toBe(2);
      for (const s of pc.senders.slice(2)) expect(s.replaced.length).toBe(0);
    }
  });

  it("outbound video is capped via scaleResolutionDownBy", async () => {
    makeMesh("m0").mesh.setMembers([{ id: "m1", epoch: 1 }]);
    await flush();
    const videoSender = FakePc.instances[0].senders.find((s) => s.track?.kind === "video");
    expect(videoSender?.params.encodings[0]?.scaleResolutionDownBy).toBe(2); // 720/360
  });

  it("a stalled sender cannot hold up another peer and obsolete track changes coalesce", async () => {
    const { mesh } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 1 }, { id: "m2", epoch: 1 }]);
    await flush();
    const [slow, fast] = FakePc.instances.map((pc) => pc.senders[2]);
    let release!: () => void;
    const replace = slow.replaceTrack.bind(slow);
    vi.spyOn(slow, "replaceTrack").mockImplementationOnce((track) => {
      void replace(track);
      return new Promise<void>((resolve) => { release = resolve; });
    });
    const first = fakeTrack("video") as unknown as MediaStreamTrack;
    const obsolete = fakeTrack("video") as unknown as MediaStreamTrack;
    const latest = fakeTrack("video") as unknown as MediaStreamTrack;
    const p1 = mesh.setVideoOverride(first);
    await flush();
    expect(fast.track).toBe(first);
    const p2 = mesh.setVideoOverride(obsolete);
    const p3 = mesh.setVideoOverride(latest);
    await flush();
    expect(fast.track).toBe(latest);
    expect(slow.track).toBe(first);
    release();
    await Promise.all([p1, p2, p3]);
    expect(slow.track).toBe(latest);
    expect(slow.replaced).not.toContain(obsolete);
    mesh.close();
  });

  it("teardown closes every peer connection and retracts streams", async () => {
    const retracted: string[] = [];
    const { mesh } = makeMesh("m0", { onRemoteStream: (id, s) => { if (s === null) retracted.push(id); } });
    mesh.setMembers([{ id: "m1", epoch: 1 }, { id: "m2", epoch: 1 }, { id: "m3", epoch: 1 }]);
    await flush();
    mesh.close();
    expect(FakePc.instances.every((pc) => pc.closed)).toBe(true);
    expect(retracted.sort()).toEqual(["m1", "m2", "m3"]);
  });

  it("one ICE restart, then failed (avatar + loud log)", async () => {
    const { mesh, states } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
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
    mesh.setMembers([{ id: "m1", epoch: 1 }, { id: "m2", epoch: 1 }]);
    await flush();
    mesh.setMembers([{ id: "m2", epoch: 1 }]);
    expect(FakePc.instances[0].closed).toBe(true);
    expect(FakePc.instances[1].closed).toBe(false);
  });


  it("program sharing leaves the camera and microphone intact through device switches", async () => {
    const local = fakeStream(["video", "audio"]);
    const { mesh } = makeMesh("m0", { getLocalStream: () => local });
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    await flush();
    const share = { kind: "video", getSettings: () => ({ height: 900 }) } as unknown as MediaStreamTrack;
    await mesh.setVideoOverride(share);
    const pc = FakePc.instances[0];
    const vs = pc.senders[2];
    const camera = pc.senders[0];
    expect(camera.track).toBe(local.getVideoTracks()[0]);
    expect(vs?.replaced.at(-1)).toBe(share);
    // Device switch mid-share: the share KEEPS the video slot.
    await mesh.replaceLocalStream(fakeStream(["video", "audio"]));
    expect(vs?.replaced.at(-1)).toBe(share);
    // Share ends: the camera track returns.
    await mesh.setVideoOverride(null);
    expect(vs?.replaced.at(-1)).toBeNull();
    expect(camera.track?.kind).toBe("video");
    expect(vs?.replaced.at(-1)).not.toBe(share);
  });
});

describe("camera that arrives after connect (r124)", () => {
  it("reserves a video sender even when joining with the camera off", () => {
    // The bug: addTrack only ran for tracks that existed at connect time, so
    // joining camera-off left NO video sender - and replaceLocalStream then
    // looped over an empty list. Turning the camera on reached nobody, with
    // no error to catch.
    const { mesh } = makeMesh("m0", { getLocalStream: () => fakeStream(["audio"]) });
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    expect(FakePc.instances[0].transceivers.some((t) => t.kind === "video")).toBe(true);
  });

  it("a camera turned on later reaches every peer", async () => {
    const { mesh } = makeMesh("m0", { getLocalStream: () => fakeStream(["audio"]) });
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    const withCam = fakeStream(["video"]);
    const cam = withCam.getVideoTracks()[0];
    await mesh.replaceLocalStream(withCam);
    const landed = FakePc.instances[0].senders.some((s) => s.replaced.includes(cam));
    expect(landed, "the camera track must land on a sender").toBe(true);
  });
});

describe("a member who reconnects (r124)", () => {
  it("rebuilds the connection when the same id comes back at a higher epoch", () => {
    // Same id, new socket. Without the epoch check the mesh kept the old
    // PeerConnection and the tile sat on "Connecting" forever.
    const { mesh } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    const first = FakePc.instances[0];
    mesh.setMembers([{ id: "m1", epoch: 2 }]);
    expect(first.closed, "the stale connection must be torn down").toBe(true);
    expect(FakePc.instances.length, "and a fresh one built").toBe(2);
  });

  it("leaves an unchanged member's connection alone", () => {
    const { mesh } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    expect(FakePc.instances.length).toBe(1);
    expect(FakePc.instances[0].closed).toBe(false);
  });
});

describe("program and camera encoding budgets", () => {
  it("keeps program resolution separate from the camera tile cap", async () => {
    const { mesh } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    await flush();
    const pc = FakePc.instances[0];
    await mesh.setVideoOverride(fakeTrack("video") as unknown as MediaStreamTrack);
    await flush();
    expect(pc.senders[0].params.encodings[0].scaleResolutionDownBy).toBe(2);
    expect(pc.senders[2].params.encodings[0].scaleResolutionDownBy).toBe(1);
    expect(pc.senders[2].params.encodings[0].maxBitrate).toBe(8_000_000);
    await mesh.setVideoOverride(null);
    expect(pc.senders[2].track).toBeNull();
    expect(pc.senders[0].track?.kind).toBe("video");
  });

  it("does not mix program audio into the microphone sender", async () => {
    const { mesh } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    const pc = FakePc.instances[0];
    const mic = pc.senders[1].track;
    const program = fakeTrack("audio") as unknown as MediaStreamTrack;
    await mesh.setAudioOverride(program);
    expect(pc.senders[1].track).toBe(mic);
    expect(pc.senders[3].track).toBe(program);
    await mesh.setAudioOverride(null);
    expect(pc.senders[1].track).toBe(mic);
    expect(pc.senders[3].track).toBeNull();
  });
});

// ── r131: joining mid-share, and remote tracks arriving one at a time ────
//
// The 0.2.0 build shipped with screen share and camera video both broken in a
// live two-machine session. Both traced to the SAME half-finished mechanism:
// placeholder transceivers reserved a sender slot but never seeded it, and
// never gave it a stream identity. Every test here fails against that build.

describe("a peer who joins mid-share (r131)", () => {
  // Camera off is the ordinary way to screen share ("I'll just show my
  // screen"), and it is exactly the case with no camera track to addTrack -
  // so the newcomer's video rode a placeholder that carried nothing.
  const cameraOff = { getLocalStream: () => fakeStream(["audio"]) };

  it("hands the newcomer the live share, not an empty sender", async () => {
    const { mesh } = makeMesh("m0", cameraOff);
    const share = fakeTrack("video") as unknown as MediaStreamTrack;
    await mesh.setVideoOverride(share);      // sharing before anyone joins
    mesh.setMembers([{ id: "m1", epoch: 1 }]); // ...then they join

    const pc = FakePc.instances[0];
    const placeholder = pc.senders[2];
    expect(placeholder.replaced,
      "a peer joining mid-share must receive the share track").toContain(share);
  });

  it("sends that share at full size, not capped to camera tile size", async () => {
    const { mesh } = makeMesh("m0", cameraOff);
    await mesh.setVideoOverride(fakeTrack("video") as unknown as MediaStreamTrack);
    mesh.setMembers([{ id: "m1", epoch: 1 }]);

    const pc = FakePc.instances[0];
    await flush();
    const sender = pc.senders[2];
    expect(sender.params.encodings[0]?.scaleResolutionDownBy,
      "a late joiner must get the same readable picture as everyone else").toBe(1);
  });

  it("hands the newcomer the share+mic audio mix too", async () => {
    const { mesh } = makeMesh("m0", { getLocalStream: () => null });
    const mix = fakeTrack("audio") as unknown as MediaStreamTrack;
    await mesh.setAudioOverride(mix);
    mesh.setMembers([{ id: "m1", epoch: 1 }]);

    const pc = FakePc.instances[0];
    const audio = pc.senders.find((s) => s.track?.kind === "audio" || s.track === null)!;
    expect(pc.senders.some((s) => s.replaced.includes(mix)),
      "else a late joiner hears the raw mic instead of the shared audio").toBe(true);
    expect(audio).toBeDefined();
  });

  it("still caps a plain camera to tile size (the share path must not leak)", async () => {
    const { mesh } = makeMesh("m0"); // camera on, no share
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    await flush();
    const sender = FakePc.instances[0].senders[0];
    expect(sender.params.encodings[0].scaleResolutionDownBy,
      "a full mesh of camera tiles must stay lean").toBeGreaterThan(1);
  });

  it("gives placeholder transceivers a stream identity", () => {
    // Without `streams`, each track reaches the far side as its own anonymous
    // MediaStream - which is what let the receiver keep only the last one.
    const { mesh } = makeMesh("m0", { getLocalStream: () => null });
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    const tx = FakePc.instances[0].transceivers;
    expect(tx.length, "camera/mic and program video/audio get separate slots").toBe(4);
    for (const t of tx) {
      expect(t.streams.length, `${t.kind} placeholder needs an msid`).toBe(1);
    }
    // ...and all of them share ONE stream, so they arrive as one peer.
    expect(tx[0].streams[0]).toBe(tx[1].streams[0]);
    expect(tx[2].streams[0]).toBe(tx[3].streams[0]);
    expect(tx[0].streams[0]).not.toBe(tx[2].streams[0]);
  });
});

describe("remote tracks arriving separately (r131)", () => {
  it("accumulates both halves instead of keeping whichever landed last", () => {
    // ontrack fires once per track. Publishing a fresh stream per track gave
    // the tile either picture with no audio (permanent "muted" badge, no
    // speaking ring) or audio with no picture, depending on m-line order.
    const seen: Array<MediaStream | null> = [];
    const { mesh } = makeMesh("m0", { onRemoteStream: (_id, s) => seen.push(s) });
    mesh.setMembers([{ id: "m1", epoch: 1 }]);

    const pc = FakePc.instances[0];
    const video = { kind: "video", id: "v1" };
    const audio = { kind: "audio", id: "a1" };
    // WebKit delivers placeholder-transceiver tracks with NO stream at all.
    pc.ontrack?.({ track: video, streams: [] });
    pc.ontrack?.({ track: audio, streams: [] });

    const last = seen[seen.length - 1]!;
    expect(last.getVideoTracks().length, "video must survive the audio track").toBe(1);
    expect(last.getAudioTracks().length, "audio must survive the video track").toBe(1);
  });

  it("keeps one stream object per peer across tracks", () => {
    const seen: Array<MediaStream | null> = [];
    const { mesh } = makeMesh("m0", { onRemoteStream: (_id, s) => seen.push(s) });
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    const pc = FakePc.instances[0];
    pc.ontrack?.({ track: { kind: "video", id: "v1" }, streams: [] });
    pc.ontrack?.({ track: { kind: "audio", id: "a1" }, streams: [] });
    expect(seen[0]).toBe(seen[1]);
  });

  it("drops a track that ends so the tile falls back to the avatar", () => {
    const seen: Array<MediaStream | null> = [];
    const { mesh } = makeMesh("m0", { onRemoteStream: (_id, s) => seen.push(s) });
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    const pc = FakePc.instances[0];
    const video: { kind: string; id: string; onended?: () => void } = { kind: "video", id: "v1" };
    pc.ontrack?.({ track: video, streams: [] });
    expect(seen[seen.length - 1]!.getVideoTracks().length).toBe(1);
    video.onended?.();
    expect(seen[seen.length - 1]!.getVideoTracks().length,
      "a frozen last frame is worse than an avatar").toBe(0);
  });
});

// ── Connecting forever: the failures that produced no event at all ──────
//
// A real two-person session sat on "Connecting" for its whole length. The
// label is the ABSENCE of an event, and every one of these paths used to
// produce exactly that and nothing else.

describe("a candidate that overtakes the offer", () => {
  it("is queued and applied, not thrown away", async () => {
    // addIceCandidate REJECTS while there is no remote description. The offer
    // and its trickled candidates ride ONE ordered stream, so a candidate can
    // arrive while setRemoteDescription is still awaiting. Dropping it does
    // not fail loudly - it just quietly removes a path to the peer.
    const { mesh } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 0 }]);
    const pc = FakePc.instances[0];

    await mesh.handleSignal("m1", { t: "ice", candidate: { candidate: "cand-early" } as RTCIceCandidateInit });
    expect(pc.candidates, "a candidate before the remote description must be held, not applied").toEqual([]);

    await mesh.handleSignal("m1", { t: "answer", sdp: "sdp" });
    expect(pc.candidates, "the queued candidate was dropped instead of flushed").toEqual([{ candidate: "cand-early" }]);

    // After the flush, later candidates go straight through.
    await mesh.handleSignal("m1", { t: "ice", candidate: { candidate: "cand-late" } as RTCIceCandidateInit });
    expect(pc.candidates).toHaveLength(2);
  });

  it("one bad queued candidate does not discard the rest", async () => {
    const { mesh } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 0 }]);
    const pc = FakePc.instances[0];
    let n = 0;
    pc.addIceCandidate = (c: unknown) => {
      n += 1;
      if (n === 1) return Promise.reject(new Error("bad candidate"));
      pc.candidates.push(c);
      return Promise.resolve();
    };
    await mesh.handleSignal("m1", { t: "ice", candidate: { candidate: "bad" } as RTCIceCandidateInit });
    await mesh.handleSignal("m1", { t: "ice", candidate: { candidate: "good" } as RTCIceCandidateInit });
    await mesh.handleSignal("m1", { t: "answer", sdp: "sdp" });
    expect(pc.candidates, "a rejected candidate aborted the whole flush").toEqual([{ candidate: "good" }]);
  });
});

describe("an answerer that fails", () => {
  it("asks the offerer to re-offer instead of restarting itself", async () => {
    // m1 answers m0 (the LOWER id offers). restartIce() on an answerer only
    // raises `negotiationneeded`, which nothing listens for - so this branch
    // used to spend its single recovery chance on a no-op and wait forever.
    const { mesh, sent } = makeMesh("m1");
    mesh.setMembers([{ id: "m0", epoch: 0 }]);
    await flush();
    expect(sent.some((s) => s.payload.t === "offer"), "an answerer must not offer").toBe(false);

    FakePc.instances[0].fireConnectionState("failed");
    expect(
      sent.filter((s) => s.to === "m0" && s.payload.t === "reoffer"),
      "the answerer had no way to ask for recovery",
    ).toHaveLength(1);
  });

  it("the offerer honours a reoffer request; a non-offerer ignores it", async () => {
    const { mesh, sent } = makeMesh("m0");
    mesh.setMembers([{ id: "m1", epoch: 0 }]);
    await flush();
    const before = sent.filter((s) => s.payload.t === "offer").length;
    await mesh.handleSignal("m1", { t: "reoffer" });
    await flush();
    expect(sent.filter((s) => s.payload.t === "offer").length, "the offerer ignored a reoffer request").toBe(before + 1);

    // m2 is not the offerer for m1 (m1 < m2), so it must not answer the call.
    const other = makeMesh("m2");
    other.mesh.setMembers([{ id: "m1", epoch: 0 }]);
    await flush();
    const n = other.sent.filter((s) => s.payload.t === "offer").length;
    await other.mesh.handleSignal("m1", { t: "reoffer" });
    await flush();
    expect(other.sent.filter((s) => s.payload.t === "offer").length, "a non-offerer re-offered and caused glare").toBe(n);
  });
});

describe("the watchdog", () => {
  it("re-offers a silent peer and eventually stops saying Connecting", async () => {
    // The decisive case: an offer that is never answered fires NO event at
    // all. connectionState stays "new", so before the watchdog there was
    // nothing to end the wait.
    vi.useFakeTimers();
    try {
      const { mesh, sent, states } = makeMesh("m0");
      mesh.setMembers([{ id: "m1", epoch: 0 }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(states.at(-1)).toEqual({ id: "m1", state: "connecting" });

      const offersAt = () => sent.filter((s) => s.payload.t === "offer").length;
      const first = offersAt();
      await vi.advanceTimersByTimeAsync(MESH_WATCHDOG_MS + 10);
      expect(offersAt(), "the watchdog did not re-offer").toBeGreaterThan(first);

      // Keep it silent: it must give up rather than retry forever.
      for (let i = 0; i < MESH_MAX_OFFERS + 2; i += 1) {
        await vi.advanceTimersByTimeAsync(MESH_WATCHDOG_MS + 10);
      }
      expect(states.at(-1), "a peer that never answers still says Connecting").toEqual({ id: "m1", state: "failed" });
      expect(offersAt(), "the watchdog re-offered without bound").toBeLessThanOrEqual(MESH_MAX_OFFERS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stands down the moment the peer goes live", async () => {
    vi.useFakeTimers();
    try {
      const { mesh, sent, states } = makeMesh("m0");
      mesh.setMembers([{ id: "m1", epoch: 0 }]);
      await vi.advanceTimersByTimeAsync(0);
      FakePc.instances[0].fireConnectionState("connected");
      const after = sent.filter((s) => s.payload.t === "offer").length;
      await vi.advanceTimersByTimeAsync(MESH_WATCHDOG_MS * (MESH_MAX_OFFERS + 2));
      expect(sent.filter((s) => s.payload.t === "offer").length, "a live peer was re-offered").toBe(after);
      expect(states.at(-1)).toEqual({ id: "m1", state: "live" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("program receive routing", () => {
  it("keeps program video/audio out of the camera and voice stream", () => {
    const cameras: MediaStream[] = [];
    const programs: MediaStream[] = [];
    const { mesh } = makeMesh("m0", {
      onRemoteStream: (_, stream) => { if (stream) cameras.push(stream); },
      onRemoteProgram: (_, stream) => { if (stream) programs.push(stream); },
    });
    mesh.setMembers([{ id: "m1", epoch: 1 }]);
    const pc = FakePc.instances[0];
    pc.ontrack?.({ track: { kind: "video", id: "camera" }, transceiver: pc.transceivers[0] });
    pc.ontrack?.({ track: { kind: "audio", id: "mic" }, transceiver: pc.transceivers[1] });
    pc.ontrack?.({ track: { kind: "video", id: "program" }, transceiver: pc.transceivers[2] });
    pc.ontrack?.({ track: { kind: "audio", id: "soundtrack" }, transceiver: pc.transceivers[3] });
    expect(cameras.at(-1)?.getTracks().map((t) => t.id)).toEqual(["camera", "mic"]);
    expect(programs.at(-1)?.getTracks().map((t) => t.id)).toEqual(["program", "soundtrack"]);
    // Feed the stream actually emitted by RTC routing to the same room-stage
    // selector as App, not a second fabricated stream or the camera route.
    const selected = selectRoomScreenStream({
      session: { role: "host", code: "room", selfId: "m0", presenter: "m1", presenterEpoch: 1,
        peers: [{ id: "m1", name: "Guest", epoch: 1 }], title: null, error: null },
      shareState: "idle", shareStream: null, sharingMembers: new Set(["m1"]),
      programStreams: new Map([["m1", programs.at(-1)!]]),
    });
    expect(selected?.stream).toBe(programs.at(-1)); expect(selected?.isSelf).toBe(false);
    expect(selected?.stream.getTracks().map(t => t.id)).toEqual(["program", "soundtrack"]);
    mesh.close();
  });
});
