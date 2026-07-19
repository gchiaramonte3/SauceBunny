/**
 * WebRTC full-mesh core for the session room. Pure orchestration with the
 * platform injected (RTCPeerConnection factory, signal transport, audio
 * side-effects) so vitest drives it with fakes - the browser hook wrapper
 * lives in hooks/use-rtc-mesh.ts.
 *
 * Topology: one RTCPeerConnection per OTHER member. Determinism: the LOWER
 * member id makes the offer (m0 < m1 < ...), so no glare handling is
 * needed. Signaling rides the iroh star as SessionMsg::Rtc lines (opaque
 * JSON payloads: offer / answer / ice).
 */

export type MeshPeerState = "connecting" | "live" | "failed";

export type MeshSignalPayload =
  | { t: "offer"; sdp: string }
  | { t: "answer"; sdp: string }
  | { t: "ice"; candidate: RTCIceCandidateInit | null };

export type MeshDeps = {
  selfId: string;
  iceServers: RTCIceServer[];
  /** DI seam: real RTCPeerConnection in the app, a fake in tests. */
  createPc: (config: RTCConfiguration) => RTCPeerConnection;
  /** Send one signaling payload to a member (host: session_broadcast Rtc,
   *  peer: session_send Rtc - the transport stamps `from`). */
  sendSignal: (to: string, payload: MeshSignalPayload) => void;
  onRemoteStream: (id: string, stream: MediaStream | null) => void;
  onState: (id: string, state: MeshPeerState) => void;
  getLocalStream: () => MediaStream | null;
  log: (tag: "info" | "warn" | "err", msg: string) => void;
};

/** Numeric order of "m<N>" ids; malformed ids sort last (never offer). */
export function memberNum(id: string): number {
  const n = Number(id.replace(/^m/, ""));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** The lower member id offers - one deterministic offerer per pair. */
export function isOfferer(selfId: string, otherId: string): boolean {
  return memberNum(selfId) < memberNum(otherId);
}

type PeerSlot = {
  pc: RTCPeerConnection;
  state: MeshPeerState;
  restarted: boolean;
  /** Senders by kind, recorded at addTrack so replace/override never has
   *  to guess a null-track sender's kind. */
  videoSenders: RTCRtpSender[];
  audioSenders: RTCRtpSender[];
};

export class RtcMesh {
  private deps: MeshDeps;
  private slots = new Map<string, PeerSlot>();
  private closed = false;
  /** Screen share: when set, every video sender carries THIS track instead
   *  of the camera; null restores the capture's video. */
  private videoOverride: MediaStreamTrack | null = null;
  private audioOverride: MediaStreamTrack | null = null;

  constructor(deps: MeshDeps) {
    this.deps = deps;
  }

  /** Reconcile connections against the roster (minus self): connect to new
   *  members, tear down the departed. Call on every PeerList change. */
  setMembers(ids: string[]): void {
    if (this.closed) return;
    const want = new Set(ids.filter((id) => id !== this.deps.selfId));
    for (const [id, slot] of [...this.slots]) {
      if (!want.has(id)) {
        this.dropPeer(id, slot);
      }
    }
    for (const id of want) {
      if (!this.slots.has(id)) this.connectTo(id);
    }
  }

  /** Route one incoming Rtc payload (already addressed to us). */
  async handleSignal(from: string, payload: MeshSignalPayload): Promise<void> {
    if (this.closed) return;
    let slot = this.slots.get(from);
    if (!slot) {
      // An offer can beat the PeerList that announces its sender.
      if (payload.t !== "offer") return;
      slot = this.connectTo(from) ?? undefined;
      if (!slot) return;
    }
    try {
      if (payload.t === "offer") {
        await slot.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        const answer = await slot.pc.createAnswer();
        await slot.pc.setLocalDescription(answer);
        this.deps.sendSignal(from, { t: "answer", sdp: answer.sdp ?? "" });
      } else if (payload.t === "answer") {
        await slot.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      } else if (payload.t === "ice" && payload.candidate) {
        await slot.pc.addIceCandidate(payload.candidate);
      }
    } catch (err) {
      this.deps.log("warn", `rtc signal from ${from} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Device switch: swap every outbound sender track in place (no renegotiation
   *  needed for same-kind replaceTrack). A live share override keeps owning
   *  the video senders; the new camera takes over when the share ends. */
  async replaceLocalStream(stream: MediaStream | null): Promise<void> {
    const video = this.videoOverride ?? stream?.getVideoTracks()[0] ?? null;
    const audio = this.audioOverride ?? stream?.getAudioTracks()[0] ?? null;
    for (const [, slot] of this.slots) {
      for (const sender of slot.videoSenders) {
        try { await sender.replaceTrack(video); } catch { /* sender gone */ }
      }
      for (const sender of slot.audioSenders) {
        try { await sender.replaceTrack(audio); } catch { /* sender gone */ }
      }
    }
  }

  /** Screen share in/out: the share track replaces the camera on every
   *  video sender; null restores the capture's camera track. */
  async setVideoOverride(track: MediaStreamTrack | null): Promise<void> {
    this.videoOverride = track;
    const video = track ?? this.deps.getLocalStream()?.getVideoTracks()[0] ?? null;
    for (const [, slot] of this.slots) {
      for (const sender of slot.videoSenders) {
        try { await sender.replaceTrack(video); } catch { /* sender gone */ }
      }
    }
  }

  /** Share system audio in/out: the share+mic mix replaces the mic on
   *  every audio sender; null restores the capture's mic track. */
  async setAudioOverride(track: MediaStreamTrack | null): Promise<void> {
    this.audioOverride = track;
    const audio = track ?? this.deps.getLocalStream()?.getAudioTracks()[0] ?? null;
    for (const [, slot] of this.slots) {
      for (const sender of slot.audioSenders) {
        try { await sender.replaceTrack(audio); } catch { /* sender gone */ }
      }
    }
  }

  /** Leave/end: every connection closed, every remote stream retracted. */
  close(): void {
    this.closed = true;
    for (const [id, slot] of [...this.slots]) this.dropPeer(id, slot);
    this.slots.clear();
  }

  peerState(id: string): MeshPeerState | null {
    return this.slots.get(id)?.state ?? null;
  }

  private dropPeer(id: string, slot: PeerSlot): void {
    try { slot.pc.close(); } catch { /* already closed */ }
    this.slots.delete(id);
    this.deps.onRemoteStream(id, null);
  }

  private setState(id: string, state: MeshPeerState): void {
    const slot = this.slots.get(id);
    if (!slot || slot.state === state) return;
    slot.state = state;
    this.deps.onState(id, state);
  }

  private connectTo(id: string): PeerSlot | null {
    const pc = this.deps.createPc({ iceServers: this.deps.iceServers });
    const slot: PeerSlot = { pc, state: "connecting", restarted: false, videoSenders: [], audioSenders: [] };
    this.slots.set(id, slot);
    this.deps.onState(id, "connecting");

    // Outbound media: the green-room capture, capped for tile-size viewing
    // (the People tiles are ~220px wide; a full mesh must stay lean).
    const local = this.deps.getLocalStream();
    if (local) {
      for (const track of local.getTracks()) {
        // A live share owns BOTH slots from the first frame a new member
        // sees (they joined mid-share): the share video, and the share+mic
        // audio mix (else a late joiner hears the raw mic, not the shared
        // system audio).
        const outTrack =
          track.kind === "video" ? (this.videoOverride ?? track)
          : (this.audioOverride ?? track);
        const sender = pc.addTrack(outTrack, local);
        if (track.kind === "video") slot.videoSenders.push(sender);
        else slot.audioSenders.push(sender);
        if (track.kind === "video") {
          const h = track.getSettings?.().height ?? 720;
          const down = Math.max(1, h / 360);
          try {
            const params = sender.getParameters();
            params.encodings = params.encodings?.length ? params.encodings : [{}];
            params.encodings[0].scaleResolutionDownBy = down;
            void sender.setParameters(params);
          } catch { /* older engines: full-size tiles still work */ }
        }
      }
    }

    pc.onicecandidate = (e) => {
      this.deps.sendSignal(id, { t: "ice", candidate: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.deps.onRemoteStream(id, stream);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") {
        this.setState(id, "live");
      } else if (st === "failed") {
        if (!slot.restarted) {
          // One ICE restart, then we call it: avatar + loud log.
          slot.restarted = true;
          this.deps.log("warn", `rtc to ${id} failed; one ICE restart`);
          try {
            pc.restartIce();
            if (isOfferer(this.deps.selfId, id)) void this.sendOffer(id, pc);
          } catch {
            this.setState(id, "failed");
          }
        } else {
          this.deps.log("err", `rtc to ${id} failed after restart; showing avatar`);
          this.setState(id, "failed");
        }
      }
    };

    if (isOfferer(this.deps.selfId, id)) void this.sendOffer(id, pc);
    return slot;
  }

  private async sendOffer(id: string, pc: RTCPeerConnection): Promise<void> {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.deps.sendSignal(id, { t: "offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      this.deps.log("warn", `rtc offer to ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
