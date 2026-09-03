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

/** How long an offerer waits for a peer to go live before offering again. */
export const MESH_WATCHDOG_MS = 8000;
/** Total offers per peer, including the first. Bounded so a genuinely
 *  unreachable peer settles on "No connection" instead of retrying forever. */
export const MESH_MAX_OFFERS = 4;

export type MeshSignalPayload =
  | { t: "offer"; sdp: string }
  | { t: "answer"; sdp: string }
  | { t: "ice"; candidate: RTCIceCandidateInit | null }
  /** "I cannot fix this from my side; please offer again."
   *
   *  Only the LOWER member id offers (see isOfferer), so an answerer whose
   *  connection dies has no legal way to restart it: restartIce() on a
   *  non-offerer only raises `negotiationneeded`, which nothing listens for.
   *  It burned its one recovery chance on a no-op and then waited forever.
   *  Frontend-only addition - this rides the same opaque `rtc` payload the
   *  Rust relay forwards as a string, so no backend change and no build-ID
   *  bump. An older peer hits handleSignal's `default` and ignores it. */
  | { t: "reoffer" };

export type MeshDeps = {
  selfId: string;
  iceServers: RTCIceServer[];
  /** DI seam: real RTCPeerConnection in the app, a fake in tests. */
  createPc: (config: RTCConfiguration) => RTCPeerConnection;
  /** DI seam for the same reason as createPc: this module stays free of
   *  browser globals so vitest can drive it under node. */
  createStream: () => MediaStream;
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
  /** Roster claim count for this member id. A HIGHER epoch on the same id
   *  means the person behind it reconnected, so this connection is stale. */
  epoch: number;
  state: MeshPeerState;
  restarted: boolean;
  /** Candidates that arrived before setRemoteDescription resolved.
   *
   *  addIceCandidate REJECTS with InvalidStateError while there is no remote
   *  description, and the offer plus its trickled candidates ride one ordered
   *  stream - so a candidate overtaking the setRemoteDescription await was
   *  thrown away with a single warn line. Losing candidates does not fail the
   *  connection loudly; it fails it SILENTLY, which is how a tile sits on
   *  "Connecting" forever. */
  pendingIce: RTCIceCandidateInit[];
  /** Candidate types this connection managed to gather (host/srflx/relay).
   *  "host only" is the signature of a peer that can never be reached from
   *  another network. */
  candTypes: Set<string>;
  /** True once setRemoteDescription has resolved, so the queue can flush. */
  hasRemote: boolean;
  /** Offerer-side re-offer timer, and how many times we have tried. */
  watchdog: ReturnType<typeof setTimeout> | null;
  offers: number;
  /** Senders by kind, recorded at addTrack so replace/override never has
   *  to guess a null-track sender's kind. */
  videoSenders: RTCRtpSender[];
  audioSenders: RTCRtpSender[];
  /** ONE stream per peer for the life of the connection. `ontrack` fires once
   *  per track, and a track arriving on a placeholder transceiver carries no
   *  stream association at all - so building a stream per track handed the
   *  tile whichever half landed last, and silently dropped the other. */
  remote: MediaStream;
};

export class RtcMesh {
  private deps: MeshDeps;
  private slots = new Map<string, PeerSlot>();
  private closed = false;
  /** Screen share: when set, every video sender carries THIS track instead
   *  of the camera; null restores the capture's video. */
  private videoOverride: MediaStreamTrack | null = null;
  private audioOverride: MediaStreamTrack | null = null;
  /** Stream identity for placeholder transceivers. Giving them a stream means
   *  the msid rides the offer, so the far side receives all four tracks as ONE
   *  stream instead of four anonymous ones. */
  private outStream: MediaStream;

  constructor(deps: MeshDeps) {
    this.deps = deps;
    this.outStream = deps.createStream();
  }

  /** Reconcile connections against the roster (minus self): connect to new
   *  members, tear down the departed. Call on every PeerList change. */
  setMembers(members: { id: string; epoch: number }[]): void {
    if (this.closed) return;
    const want = new Map(
      members.filter((m) => m.id !== this.deps.selfId).map((m) => [m.id, m.epoch]),
    );
    for (const [id, slot] of [...this.slots]) {
      if (!want.has(id)) {
        this.dropPeer(id, slot);
        continue;
      }
      // Same id, HIGHER epoch: that member dropped and reconnected, so this
      // PeerConnection is talking to a socket that no longer exists. Rebuild
      // it - this is what left a rejoined friend's tile on "Connecting"
      // forever, because nothing ever noticed the peer behind it had changed.
      const epoch = want.get(id) ?? 0;
      if (epoch > slot.epoch) {
        this.dropPeer(id, slot);
      }
    }
    for (const [id, epoch] of want) {
      if (!this.slots.has(id)) this.connectTo(id, epoch);
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
        await this.flushIce(from, slot);
        const answer = await slot.pc.createAnswer();
        await slot.pc.setLocalDescription(answer);
        this.deps.sendSignal(from, { t: "answer", sdp: answer.sdp ?? "" });
      } else if (payload.t === "answer") {
        await slot.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        await this.flushIce(from, slot);
      } else if (payload.t === "reoffer") {
        // Only the offerer may act on this; anyone else ignores it.
        if (isOfferer(this.deps.selfId, from)) {
          this.deps.log("info", `rtc ${from} asked for a fresh offer`);
          void this.sendOffer(from, slot.pc);
        }
      } else if (payload.t === "ice" && payload.candidate) {
        if (!slot.hasRemote) slot.pendingIce.push(payload.candidate);
        else await slot.pc.addIceCandidate(payload.candidate);
      }
    } catch (err) {
      this.deps.log("warn", `rtc signal from ${from} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Apply the candidates that arrived before the remote description did.
   *  One bad candidate must not discard the rest, so each is applied
   *  individually and a failure is logged rather than thrown. */
  private async flushIce(from: string, slot: PeerSlot): Promise<void> {
    slot.hasRemote = true;
    if (slot.pendingIce.length === 0) return;
    const queued = slot.pendingIce.splice(0);
    this.deps.log("info", `rtc ${from}: applying ${queued.length} early candidate(s)`);
    for (const c of queued) {
      try { await slot.pc.addIceCandidate(c); }
      catch (err) {
        this.deps.log("warn", `rtc ${from}: queued candidate rejected: ${err instanceof Error ? err.message : String(err)}`);
      }
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
        this.tuneVideoSender(sender, !!track, video?.getSettings?.().height ?? 720);
      }
    }
  }

  /** A share and a camera want OPPOSITE encodings, and the two places that set
   *  one had drifted apart: `connectTo` capped whatever it found to tile size,
   *  so a peer joining mid-share got the share at half resolution even though
   *  `setVideoOverride` had just made it full size for everyone else. One
   *  method now decides, so the two paths cannot disagree again. */
  private tuneVideoSender(sender: RTCRtpSender, sharing: boolean, sourceHeight = 720): void {
    if (!sharing) {
      // scaleResolutionDownBy is a SENDER property and survives replaceTrack,
      // so a camera returning after a share must be capped back down here.
      this.capTileResolution(sender, sourceHeight);
      return;
    }
    this.setSenderScale(sender, 1);
    // Screen content is detail, not motion: hold resolution and let the frame
    // rate absorb congestion, rather than blurring the pixels someone is
    // trying to read.
    try {
      const p = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      p.degradationPreference = "maintain-resolution";
      void sender.setParameters(p);
    } catch { /* older engines ignore the hint */ }
  }

  /** Set (or clear) a sender's resolution downscale. */
  private setSenderScale(sender: RTCRtpSender, factor: number): void {
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].scaleResolutionDownBy = factor;
      void sender.setParameters(params);
    } catch { /* older engines: full-size is the safe direction */ }
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
    this.clearWatchdog(slot);
    try { slot.pc.close(); } catch { /* already closed */ }
    this.slots.delete(id);
    this.deps.onRemoteStream(id, null);
  }

  private clearWatchdog(slot: PeerSlot): void {
    if (slot.watchdog === null) return;
    clearTimeout(slot.watchdog);
    slot.watchdog = null;
  }

  /**
   * Offerer-side only: end the silence.
   *
   * Every way this mesh could fail to connect produced the SAME screen - the
   * word "Connecting", forever - because the label is the ABSENCE of an event
   * and there was no timeout anywhere. An offer that is never answered fires
   * nothing at all: connectionState sits at "new" and no failure ever arrives.
   * So the offerer re-offers a bounded number of times and then says so.
   *
   * Offerer-side ONLY, deliberately: two peers re-offering at once is glare,
   * and the answerer has the `reoffer` signal for the case where it is the one
   * that noticed.
   */
  private armWatchdog(id: string, slot: PeerSlot): void {
    this.clearWatchdog(slot);
    slot.watchdog = setTimeout(() => {
      slot.watchdog = null;
      if (this.closed || this.slots.get(id) !== slot || slot.state === "live") return;
      if (slot.offers >= MESH_MAX_OFFERS) {
        this.deps.log("err",
          `rtc to ${id}: no connection after ${slot.offers} offers. `
          + `If you are on different networks this usually needs a TURN server (Settings > General).`);
        this.setState(id, "failed");
        return;
      }
      this.deps.log("warn", `rtc to ${id}: still not connected, offering again (${slot.offers + 1}/${MESH_MAX_OFFERS})`);
      void this.sendOffer(id, slot.pc);
      this.armWatchdog(id, slot);
    }, MESH_WATCHDOG_MS);
  }

  private setState(id: string, state: MeshPeerState): void {
    const slot = this.slots.get(id);
    if (!slot || slot.state === state) return;
    slot.state = state;
    this.deps.onState(id, state);
  }

  /** People tiles are ~220px wide; a full mesh must stay lean. Applied to a
   *  placeholder sender too, so a camera that arrives later is capped from
   *  its first frame rather than blasting full resolution at every peer. */
  private capTileResolution(sender: RTCRtpSender, sourceHeight: number): void {
    this.setSenderScale(sender, Math.max(1, sourceHeight / 360));
  }

  private connectTo(id: string, epoch = 0): PeerSlot | null {
    const pc = this.deps.createPc({ iceServers: this.deps.iceServers });
    const slot: PeerSlot = {
      pc, epoch, state: "connecting", restarted: false,
      pendingIce: [], hasRemote: false, watchdog: null, offers: 0,
      candTypes: new Set<string>(),
      videoSenders: [], audioSenders: [], remote: this.deps.createStream(),
    };
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
        if (track.kind === "video") {
          slot.videoSenders.push(sender);
          // Tune for what this sender ACTUALLY carries (outTrack), not for the
          // camera track we happened to be iterating: reading `track` here
          // capped a live share to camera tile size for anyone joining
          // mid-share, quietly undoing the readable-picture fix.
          this.tuneVideoSender(sender, outTrack === this.videoOverride, outTrack.getSettings?.().height ?? 720);
        } else {
          slot.audioSenders.push(sender);
        }
      }
    }
    // PLACEHOLDER TRANSCEIVERS (r124) - the camera-reconnect fix.
    //
    // addTrack above only runs for tracks that exist RIGHT NOW. Join with the
    // camera off (or with the mic denied) and that kind gets no sender at all,
    // so replaceLocalStream later loops over an empty list and turning the
    // camera on never reaches a single peer - a silent no-op with no error to
    // catch. Reserving a sendrecv transceiver up front means there is ALWAYS a
    // sender to replaceTrack into, for the whole life of the connection, with
    // no renegotiation (which would need glare handling this mesh has never
    // had). The m-line rides the very first offer, so both directions work
    // even if the camera comes on much later.
    //
    // A placeholder must also be SEEDED with whatever is live right now. The
    // block above only runs for tracks the capture owns, so joining mid-share
    // with the camera off left the share sitting in `videoOverride` with no
    // sender carrying it - the newcomer saw a blank tile forever while the
    // host's UI said "sharing". Same for the share+mic audio mix.
    //
    // `streams: [this.outStream]` gives the m-line an msid, so the far side
    // receives every track as ONE stream rather than several anonymous ones.
    if (slot.videoSenders.length === 0) {
      try {
        const tx = pc.addTransceiver("video", { direction: "sendrecv", streams: [this.outStream] });
        slot.videoSenders.push(tx.sender);
        if (this.videoOverride) void tx.sender.replaceTrack(this.videoOverride);
        this.tuneVideoSender(tx.sender, !!this.videoOverride);
      } catch { /* engine without addTransceiver: camera-on still needs a rejoin */ }
    }
    if (slot.audioSenders.length === 0) {
      try {
        const tx = pc.addTransceiver("audio", { direction: "sendrecv", streams: [this.outStream] });
        slot.audioSenders.push(tx.sender);
        if (this.audioOverride) void tx.sender.replaceTrack(this.audioOverride);
      } catch { /* as above */ }
    }

    pc.onicecandidate = (e) => {
      // Record the TYPE as we go: the gathering-complete summary above is what
      // tells a failed session apart from a NAT it could never cross.
      const c = e.candidate?.candidate;
      if (c) {
        const m = / typ (host|srflx|prflx|relay)/.exec(c);
        if (m) slot.candTypes.add(m[1]);
      }
      this.deps.sendSignal(id, { t: "ice", candidate: e.candidate ? e.candidate.toJSON() : null });
    };
    pc.ontrack = (e) => {
      // ACCUMULATE into the slot's one stream. `ontrack` fires once per track,
      // and a track on a placeholder transceiver arrives with e.streams empty,
      // so publishing a per-track stream here handed the tile whichever half
      // fired last: camera with no audio (permanent "muted" badge and no
      // speaking ring), or audio with no picture.
      if (!slot.remote.getTrackById(e.track.id)) slot.remote.addTrack(e.track);
      // A track the peer replaces with null ends; drop it so the tile falls
      // back to the avatar instead of holding a frozen last frame.
      e.track.onended = () => {
        try { slot.remote.removeTrack(e.track); } catch { /* already gone */ }
        this.deps.onRemoteStream(id, slot.remote);
      };
      this.deps.onRemoteStream(id, slot.remote);
    };
    // ── Diagnostics ──────────────────────────────────────────────────
    // Only connectionState was ever observed, so a session that never
    // connected left NO record of why: whether STUN answered, whether any
    // routable candidate existed, whether checks even started. A failed call
    // is unreproducible without this.
    pc.oniceconnectionstatechange = () => {
      this.deps.log("info", `rtc ${id}: ice ${pc.iceConnectionState}`);
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState !== "complete") return;
      const kinds = [...slot.candTypes].sort().join(", ") || "none";
      this.deps.log("info", `rtc ${id}: gathering complete (${kinds})`);
      // The single most useful line in a failed session. Only host candidates
      // means STUN never answered, so anyone not on this LAN is unreachable
      // and no amount of waiting will change it.
      if (!slot.candTypes.has("srflx") && !slot.candTypes.has("relay")) {
        this.deps.log("warn",
          `rtc ${id}: only local-network candidates. A peer on another network needs `
          + `a reachable STUN server, or a TURN server for strict NATs (Settings > General).`);
      }
    };
    pc.onicecandidateerror = (e: Event) => {
      // Where an unreachable STUN/TURN server actually surfaces.
      const ev = e as Event & { url?: string; errorText?: string; errorCode?: number };
      this.deps.log("warn", `rtc ${id}: ice server error ${ev.errorCode ?? ""} ${ev.url ?? ""} ${ev.errorText ?? ""}`.trim());
    };

    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") {
        this.clearWatchdog(slot);
        this.setState(id, "live");
      } else if (st === "failed") {
        if (!slot.restarted) {
          slot.restarted = true;
          this.deps.log("warn", `rtc to ${id} failed; recovering`);
          try {
            pc.restartIce();
            if (isOfferer(this.deps.selfId, id)) {
              void this.sendOffer(id, pc);
            } else {
              // AN ANSWERER CANNOT RESTART ITSELF. restartIce() here only
              // raises `negotiationneeded`, which nothing listens for, so this
              // branch used to burn its one recovery chance on nothing and
              // then wait forever. Ask the offerer instead.
              this.deps.sendSignal(id, { t: "reoffer" });
            }
          } catch {
            this.setState(id, "failed");
          }
        } else {
          this.deps.log("err", `rtc to ${id} failed after restart; showing avatar`);
          this.clearWatchdog(slot);
          this.setState(id, "failed");
        }
      }
    };

    if (isOfferer(this.deps.selfId, id)) {
      void this.sendOffer(id, pc);
      this.armWatchdog(id, slot);
    }
    return slot;
  }

  private async sendOffer(id: string, pc: RTCPeerConnection): Promise<void> {
    const slot = this.slots.get(id);
    if (slot) slot.offers += 1;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.deps.sendSignal(id, { t: "offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      this.deps.log("warn", `rtc offer to ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
