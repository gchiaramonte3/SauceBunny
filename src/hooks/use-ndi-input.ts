import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SessionMsg } from "../bindings/SessionMsg";
import type { SessionState } from "../bindings/SessionState";
import type { NdiDiscoveryResult } from "../bindings/NdiDiscoveryResult";
import type { NdiStarted } from "../bindings/NdiStarted";
import type { NdiStatusResult } from "../bindings/NdiStatusResult";
import type { NdiTelemetry } from "../bindings/NdiTelemetry";
import type { NdiSessionsResult } from "../bindings/NdiSessionsResult";
import type { NdiRoomProgram } from "../bindings/NdiRoomProgram";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { ObsStarted } from "../bindings/ObsStarted";
import { canPublishNdi, emptyNdiTelemetry, NdiProgramCoordinator, type NdiLocalProgram } from "../lib/ndi-program-coordinator";
import { captureSourceIdentity, copyCaptureSelection } from "../lib/ndi-program-source";
import { loadJson, saveJson } from "../lib/storage";
import { formatError } from "../lib/error-format";

export type NdiProgram = NdiStarted & { local: boolean; ownerId: string; reviewKey: string; stopped?: boolean; capture?: ObsSelection };
export type NdiState = NdiTelemetry;
export type NdiDiscovery = NdiDiscoveryResult;
export const emptyNdiState = emptyNdiTelemetry;

/** Reconnects reuse the same local pass. Capture ids are deliberately excluded. */
function programReviewKey(name: string) {
  return reviewPass("saucebunny.ndiReviewPasses", name);
}
function captureReviewKey(selection: ObsSelection) {
  // A separate local map prevents borrowing an NDI pass with the same title.
  // Its private selection keys never cross IPC; publication receives only the opaque value.
  return reviewPass("saucebunny.captureReviewPasses", captureSourceIdentity(selection));
}
function reviewPass(storageKey: string, identity: string) {
  const saved = loadJson<unknown>(storageKey, {});
  const passes: Record<string, string> = Object.create(null);
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [source, key] of Object.entries(saved)) {
      if (typeof key === "string" && /^ndi:[a-z0-9-]+$/i.test(key)) passes[source] = key;
    }
  }
  if (!passes[identity]) { passes[identity] = `ndi:${crypto.randomUUID()}`; saveJson(storageKey, passes); }
  return passes[identity];
}
const asLocalProgram = (program: NdiStarted & { reviewKey: string; capture?: ObsSelection }): NdiProgram => ({
  id: program.id, name: program.name, url: program.url, reviewKey: program.reviewKey, local: true, ownerId: "m0",
  ...(program.capture ? { capture: copyCaptureSelection(program.capture) } : {}),
});
type RemoteProgram = { program: NdiProgram | null; source: NdiRoomProgram | null; ready: boolean; error: string | null };
const noRemote = (): RemoteProgram => ({ program: null, source: null, ready: false, error: null });

export function useNdiInput() {
  const [controller] = useState(() => new NdiProgramCoordinator({
    start: name => invoke<NdiStarted>("ndi_start", { name }),
    startCapture: selection => invoke<ObsStarted>("obs_start", { selection }),
    status: id => invoke<NdiStatusResult>("ndi_status", { id }),
    stop: id => invoke("ndi_stop", { id }),
    publish: (source, room) => invoke<number>("ndi_publish", { id: source.id, reviewKey: source.reviewKey,
      generation: room.generation, epoch: room.presenterEpoch }),
    unpublish: lease => invoke("ndi_unpublish", lease),
    reviewKey: programReviewKey,
    captureReviewKey,
  }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [remote, setRemote] = useState<RemoteProgram>(noRemote);
  const [visibleDecodedId,setVisibleDecodedId]=useState<string|null>(null);
  // A stopped publication still owns the room's last picture, even when its
  // private receiver is cancelled or replaced. A candidate never owns it.
  const lastPublication = useRef<NdiLocalProgram | null>(null);
  useEffect(() => {
    if (snapshot.published) lastPublication.current = snapshot.published;
    else if (!snapshot.roomSource) lastPublication.current = null;
  }, [snapshot.published, snapshot.roomSource]);
  const currentRemote = useRef(remote); currentRemote.current = remote;
  const room = useRef<SessionState | null>(null);
  const mounted = useRef(false), syncTurn = useRef(0), remoteTurn = useRef(0);
  const statusReads = useRef(new Set<string>());
  const sync = useCallback(async () => {
    const turn = ++syncTurn.current;
    const next = await invoke<NdiSessionsResult>("ndi_sessions");
    if (mounted.current && turn === syncTurn.current) controller.restore(next);
  }, [controller]);
  const refresh = useCallback((id: string) => {
    if (statusReads.current.has(id)) return;
    statusReads.current.add(id);
    void controller.refreshStatus(id).catch(() => {}).finally(() => statusReads.current.delete(id));
  }, [controller]);
  const frameDecoded = useCallback((id: string) => {
    const current=controller.getSnapshot();
    const visibleId=current.published?.id ?? current.roomSource?.id ?? currentRemote.current.program?.id;
    if(id!==visibleId)return;
    if (current.published?.id === id) {
      controller.frameDecoded(id); refresh(id);
    }
    if (currentRemote.current.program?.id === id) {
      const next = { ...currentRemote.current, ready: true, error: null };
      currentRemote.current = next; setRemote(next);
    }
    setVisibleDecodedId(id);
  }, [controller, refresh]);
  const pictureFailed = useCallback((id: string) => {
    const current = controller.getSnapshot();
    if (current.published?.id !== id && current.roomSource?.id !== id && currentRemote.current.program?.id !== id) return;
    if (current.published?.id === id) controller.pictureFailed(id);
    setVisibleDecodedId(previous => previous === id ? null : previous);
    if (currentRemote.current.program?.id === id) {
      const next = { ...currentRemote.current, ready: false };
      currentRemote.current = next; setRemote(next);
    }
  }, [controller]);
  const previewFrameDecoded = useCallback((id: string) => {
    if (controller.getSnapshot().candidate?.id !== id) return;
    controller.frameDecoded(id); refresh(id);
  }, [controller, refresh]);
  const previewPictureFailed = useCallback((id: string) => {
    if (controller.getSnapshot().candidate?.id === id) controller.pictureFailed(id);
  }, [controller]);
  const start = useCallback(async (name: string) => {
    ++syncTurn.current;
    await controller.preview(name);
  }, [controller]);
  const startCapture = useCallback(async (selection: ObsSelection) => {
    ++syncTurn.current;
    await controller.previewCapture(selection);
  }, [controller]);
  const cancelPreview = useCallback(async () => { ++syncTurn.current; await controller.cancelPreview(); }, [controller]);
  const share = useCallback(async () => { ++syncTurn.current; await controller.publish(); }, [controller]);
  const stopSharing = useCallback(async () => { ++syncTurn.current; await controller.stopSharing(); }, [controller]);
  const stop = useCallback(async () => {
    ++syncTurn.current; ++remoteTurn.current;
    const generation = controller.getSnapshot().room?.generation;
    await controller.stopSharing(); await controller.cancelPreview();
    if (controller.getSnapshot().room?.generation !== generation) throw new Error("The review session changed. Choose the source again.");
    controller.clearStoppedRoomSource(); currentRemote.current = noRemote(); setRemote(noRemote());
  }, [controller]);

  useEffect(() => {
    let disposed = false; mounted.current = true;
    const status = listen<NdiState>("ndi:state", ({ payload }) => {
      if (disposed) return;
      controller.telemetry(payload);
      const candidate = controller.getSnapshot().candidate;
      if (candidate?.id === payload.sourceId && !candidate.encodedReady && payload.phase !== "error") refresh(payload.sourceId);
    });
    const messages = listen<SessionMsg>("session:msg", ({ payload: m }) => {
      if (disposed || m.kind !== "loadSource" || m.from !== "m0" || room.current?.role !== "peer" || room.current.presenter !== "m0") return;
      const turn = ++remoteTurn.current;
      if (m.sourceKind !== "ndi" || !m.url || !/^[a-f0-9]{32}$/i.test(m.url)) {
        currentRemote.current = noRemote(); setRemote(noRemote()); return;
      }
      const id = m.url, name = m.title || "NDI source", reviewKey = m.reviewKey || `ndi:${id}`;
      const stopped = m.liveState === "stopped";
      const source: NdiRoomProgram = { id, name, reviewKey, state: stopped ? "stopped" : "live" };
      const previous = currentRemote.current;
      if (previous.program?.id === id && !!previous.program.stopped === stopped) return;
      if (stopped) {
        const program = { id, name, reviewKey, local: false, ownerId: "m0", stopped,
          url: previous.program?.id === id ? previous.program.url : "" };
        const next = { program, source, ready: previous.program?.id === id && previous.ready, error: null };
        currentRemote.current = next; setRemote(next); return;
      }
      // The review document can arrive before the local URL/picture. Keep
      // receiving it, but block composition against the held outgoing image.
      const waiting={...previous,source,ready:false,error:null};
      currentRemote.current=waiting;setRemote(waiting);
      void invoke<string>("ndi_remote_source", { id }).then(url => {
        if (disposed || turn !== remoteTurn.current) return;
        const program = { id, name, url, reviewKey, local: false, ownerId: "m0", stopped: false };
        const next = { program, source, ready: false, error: null };
        currentRemote.current = next; setRemote(next);
      }).catch(cause => {
        if (disposed || turn !== remoteTurn.current) return;
        const next = { ...previous, source, error: formatError(cause), ready: false };
        currentRemote.current = next; setRemote(next);
      });
    });
    const sessions = listen<SessionState>("session:state", ({ payload: next }) => {
      if (disposed) return;
      const previous = room.current; room.current = next;
      if (next.role === "off" || previous?.code !== next.code || previous.presenterEpoch !== next.presenterEpoch || next.presenter !== "m0") {
        ++remoteTurn.current; currentRemote.current = noRemote(); setRemote(noRemote());
      }
      if (next.role !== "host" || next.presenter !== "m0") controller.setRoom(null);
      void sync().catch(() => {});
    });
    void invoke<SessionState>("session_state").then(next => { if (!disposed && !room.current) room.current = next; }).catch(() => {});
    void sync().catch(() => {});
    return () => {
      disposed = true; mounted.current = false;
      // Invalidate replies, not just the counter that existed on mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++syncTurn.current;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++remoteTurn.current;
      void status.then(f => f()); void messages.then(f => f()); void sessions.then(f => f());
      // StrictMode rehearses effect cleanup/setup without discarding state.
      // Only a real app unmount disposes the app-level coordinator.
      queueMicrotask(() => { if (!mounted.current) void controller.dispose().catch(() => {}); });
    };
  }, [controller, refresh, sync]);
  const local = snapshot.published ?? (snapshot.roomSource?.state === "stopped"
    && lastPublication.current?.id === snapshot.roomSource.id ? lastPublication.current : null);
  const program = local ? { ...asLocalProgram(local), stopped: snapshot.roomSource?.state === "stopped" } : remote.program;
  const roomSource = snapshot.roomSource ?? remote.source;
  const reviewBlocked=!!(program && program.id!==visibleDecodedId)
    || !!(remote.source && (!remote.ready || remote.source.id!==remote.program?.id));
  return {
    previewProgram: snapshot.candidate ? asLocalProgram(snapshot.candidate) : null,
    previewState: snapshot.candidate?.telemetry ?? emptyNdiState(),
    program, state: local?.telemetry ?? { ...emptyNdiState(), sourceId: remote.program?.id ?? "",
      phase: remote.error ? "error" as const : remote.ready ? "live" as const : remote.program ? "connecting" as const : "off" as const,
      error: remote.error },
    snapshot, roomSource, published: snapshot.published ? asLocalProgram(snapshot.published) : null,
    privatePreview: !!snapshot.candidate, canShare: canPublishNdi(snapshot),
    reviewBlocked,
    start, startCapture, stop, cancelPreview, share, stopSharing, frameDecoded, pictureFailed,
    previewFrameDecoded, previewPictureFailed,
  };
}
export type NdiInput = ReturnType<typeof useNdiInput>;
