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

import { createProgramStatsSampler, type ProgramDiagnostics } from "./program-diagnostics";
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
  onRemoteProgram?: (id: string, stream: MediaStream | null) => void;
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
  programVideoSenders: RTCRtpSender[];
  programAudioSenders: RTCRtpSender[];
  programReceivers: Set<RTCRtpReceiver>;
  programRemote: MediaStream;
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
  /** Program tracks never replace the conversation's camera or microphone. */
  private videoOverride: MediaStreamTrack | null = null;
  private audioOverride: MediaStreamTrack | null = null;
  /** Stream identity for placeholder transceivers. Giving them a stream means
   *  the msid rides the offer, so the far side receives all four tracks as ONE
   *  stream instead of four anonymous ones. */
  private outStream: MediaStream;
  private programStream: MediaStream;
  private senderUpdates = new WeakMap<RTCRtpSender, Promise<void>>();
  private trackUpdates = new WeakMap<RTCRtpSender, Promise<void>>();
  private desiredTracks = new WeakMap<RTCRtpSender, MediaStreamTrack | null>();

  private replaceSenderTrack(sender: RTCRtpSender, track: MediaStreamTrack | null, programVideo?: boolean): Promise<void> {
    this.desiredTracks.set(sender, track);
    const update = (this.trackUpdates.get(sender) ?? Promise.resolve()).then(async () => {
      if (this.closed || this.desiredTracks.get(sender) !== track) return;
      try {
        await sender.replaceTrack(track);
        if (programVideo !== undefined && this.desiredTracks.get(sender) === track) {
          this.tuneVideoSender(sender, programVideo, track?.getSettings?.().height ?? 720);
        }
      } catch { /* peer closed or the capture ended during replacement */ }
    });
    this.trackUpdates.set(sender, update);
    return update;
  }
  private statsSamplers = new WeakMap<RTCRtpReceiver, ReturnType<typeof createProgramStatsSampler>>();

  async readProgramDiagnostics(id: string): Promise<ProgramDiagnostics | null> {
    const slot = this.slots.get(id);
    if (!slot || this.closed) return null;
    for (const receiver of slot.programReceivers) {
      if (receiver.track?.kind !== "video" || !receiver.getStats) continue;
      const stats = await receiver.getStats();
      if (this.closed || this.slots.get(id) !== slot) return null;
      let sample: RTCInboundRtpStreamStats | null = null;
      stats.forEach((entry) => {
        if (entry.type === "inbound-rtp" && (entry.kind === "video" || entry.mediaType === "video")) sample = entry;
      });
      if (!sample) continue;
      let sampler = this.statsSamplers.get(receiver);
      if (!sampler) { sampler = createProgramStatsSampler(); this.statsSamplers.set(receiver, sampler); }
      return sampler(sample);
    }
    return null;
  }

  constructor(deps: MeshDeps) {
    this.deps = deps;
    this.outStream = deps.createStream();
    this.programStream = deps.createStream();
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

  /** Device switch affects conversation senders only, without renegotiation. */
  async replaceLocalStream(stream: MediaStream | null): Promise<void> {
    const video = stream?.getVideoTracks()[0] ?? null;
    const audio = stream?.getAudioTracks()[0] ?? null;
    await Promise.all([...this.slots.values()].flatMap((slot) => [
      ...slot.videoSenders.map((sender) => this.replaceSenderTrack(sender, video, false)),
      ...slot.audioSenders.map((sender) => this.replaceSenderTrack(sender, audio)),
    ]));
  }

  /** Program video in/out. Null retracts the program track, not the camera. */
  async setVideoOverride(track: MediaStreamTrack | null): Promise<void> {
    this.videoOverride = track;
    await Promise.all([...this.slots.values()].flatMap((slot) =>
      slot.programVideoSenders.map((sender) => this.replaceSenderTrack(sender, track, true))));
  }

  /** Serialize parameter transactions; concurrent setParameters calls race in WebKit. */
  private tuneVideoSender(sender: RTCRtpSender, sharing: boolean, sourceHeight = 720): void {
    const update = (this.senderUpdates.get(sender) ?? Promise.resolve()).then(async () => {
      if (this.closed) return;
      try {
        const params = sender.getParameters();
        params.encodings = params.encodings?.length ? params.encodings : [{}];
        params.encodings[0].scaleResolutionDownBy = Math.max(1, sourceHeight / (sharing ? 1080 : 360));
        params.encodings[0].maxBitrate = sharing ? 8_000_000 : 500_000;
        params.encodings[0].maxFramerate = sharing ? 30 : 15;
        params.degradationPreference = sharing ? "maintain-framerate" : "balanced";
        await sender.setParameters(params);
      } catch { /* unsupported hints must not break the media track */ }
    });
    this.senderUpdates.set(sender, update);
  }

  /** Program audio in/out. The microphone is never part of this sender. */
  async setAudioOverride(track: MediaStreamTrack | null): Promise<void> {
    this.audioOverride = track;
    await Promise.all([...this.slots.values()].flatMap((slot) =>
      slot.programAudioSenders.map((sender) => this.replaceSenderTrack(sender, track))));
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
    this.deps.onRemoteProgram?.(id, null);
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

  private connectTo(id: string, epoch = 0): PeerSlot | null {
    const pc = this.deps.createPc({ iceServers: this.deps.iceServers });
    const slot: PeerSlot = {
      pc, epoch, state: "connecting", restarted: false,
      pendingIce: [], hasRemote: false, watchdog: null, offers: 0,
      candTypes: new Set<string>(),
      videoSenders: [], audioSenders: [], remote: this.deps.createStream(),
      programVideoSenders: [], programAudioSenders: [], programReceivers: new Set(), programRemote: this.deps.createStream(),
    };
    this.slots.set(id, slot);
    this.deps.onState(id, "connecting");

    // Reserve four stable m-lines up front: camera, mic, program video,
    // program audio. Sharing never replaces the conversation tracks.
    const local = this.deps.getLocalStream();
    const attach = (kind: "video" | "audio", track: MediaStreamTrack | null, program: boolean) => {
      const tx = pc.addTransceiver(kind, { direction: "sendrecv", streams: [program ? this.programStream : this.outStream] });
      const senders = program
        ? kind === "video" ? slot.programVideoSenders : slot.programAudioSenders
        : kind === "video" ? slot.videoSenders : slot.audioSenders;
      senders.push(tx.sender);
      if (program) slot.programReceivers.add(tx.receiver);
      if (track) void tx.sender.replaceTrack(track).catch(() => {});
      if (kind === "video") this.tuneVideoSender(tx.sender, program, track?.getSettings?.().height ?? 720);
    };
    attach("video", local?.getVideoTracks()[0] ?? null, false);
    attach("audio", local?.getAudioTracks()[0] ?? null, false);
    attach("video", this.videoOverride, true);
    attach("audio", this.audioOverride, true);

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
      if (this.closed || this.slots.get(id) !== slot) return;
      const program = !!e.transceiver && slot.programReceivers.has(e.transceiver.receiver);
      const remote = program ? slot.programRemote : slot.remote;
      const publish = () => {
        if (this.closed || this.slots.get(id) !== slot) return;
        if (program) this.deps.onRemoteProgram?.(id, remote);
        else this.deps.onRemoteStream(id, remote);
      };
      if (!remote.getTrackById(e.track.id)) remote.addTrack(e.track);
      e.track.onended = () => {
        // Retain the ended program track/frame until an explicit source
        // change. Falling back to the file would silently change note timing.
        if (!program) { try { remote.removeTrack(e.track); } catch {} }
        publish();
      };
      publish();
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
