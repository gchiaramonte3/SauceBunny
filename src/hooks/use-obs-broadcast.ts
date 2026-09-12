import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import type { ObsBroadcastStatus } from "../bindings/ObsBroadcastStatus";

export type ObsBroadcast = {
  sourceId: string | null;
  status: ObsBroadcastStatus | null;
  error: string | null;
  active: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};
export type ObsBroadcastSource = { sourceId: string; sourceName: string };
type Observation = ObsBroadcastSource & {
  status: ObsBroadcastStatus | null;
  error: string | null;
  revision: number;
  pending: number | null;
  reading: boolean;
};
const isActive = (status: ObsBroadcastStatus | null) => status?.phase === "starting" || status?.phase === "live" || status?.phase === "stopping";
const terminal = (item: Observation) => !item.error && item.pending === null && (item.status?.phase === "off"
  || item.status?.phase === "stopped" || (item.status?.phase === "error" && item.status.cleanupConfirmed === true));

/** Native owns sender lifetime. Keep observations of removed sources until a
 * terminal read, not merely until capture/room selection has moved on. */
export function useObsBroadcasts(sources: readonly ObsBroadcastSource[]) {
  const entries = useRef(new Map<string, Observation>()), mounted = useRef(false);
  const desired = useRef(sources); desired.current = sources;
  const [, setVersion] = useState(0);
  const notify = useCallback(() => { if (mounted.current) setVersion(value => value + 1); }, []);
  const reconcile = useCallback(() => {
    const selected = new Map(desired.current.map(source => [source.sourceId, source]));
    for (const source of selected.values()) {
      const existing = entries.current.get(source.sourceId);
      if (existing) existing.sourceName = source.sourceName;
      else entries.current.set(source.sourceId, { ...source, status: null, error: null, revision: 0, pending: null, reading: false });
    }
    for (const [id, item] of entries.current) {
      if (!selected.has(id) && terminal(item)) entries.current.delete(id);
    }
  }, []);
  const isCurrent = useCallback((item: Observation, revision: number) => mounted.current
    && entries.current.get(item.sourceId) === item && item.revision === revision, []);
  const read = useCallback(async (item: Observation) => {
    if (item.reading || item.pending !== null) return;
    item.reading = true;
    const turn = item.revision;
    try {
      const next = await invoke<ObsBroadcastStatus>("obs_broadcast_status", { id: item.sourceId });
      if (!isCurrent(item, turn) || next.sourceId !== item.sourceId) return;
      // Native may prune a completed, unavailable source while another source
      // is polled. Off/0 then means no registered sender, not an old attempt.
      // A read issued before an intent still fails the revision check above.
      if (next.attempt < (item.status?.attempt ?? 0) && !(next.phase === "off" && next.attempt === 0)) return;
      item.status = next; item.error = null;
      reconcile(); notify();
    } catch (cause) {
      if (isCurrent(item, turn)) { item.error = formatError(cause); notify(); }
    } finally { item.reading = false; }
  }, [isCurrent, reconcile, notify]);
  const refresh = useCallback(() => { for (const item of entries.current.values()) void read(item); }, [read]);
  useEffect(() => {
    mounted.current = true;
    const tracked = entries.current;
    const timer = window.setInterval(refresh, 750);
    return () => { mounted.current = false; tracked.clear(); window.clearInterval(timer); };
  }, [refresh]);
  const sourceKey = JSON.stringify(sources);
  useEffect(() => { reconcile(); refresh(); notify(); }, [sourceKey, reconcile, refresh, notify]);
  const act = useCallback(async (item: Observation, stop: boolean) => {
    const previous = item.status, sourceId = item.sourceId;
    if (!mounted.current || entries.current.get(sourceId) !== item || !previous) return;
    if (!stop && (item.error || !desired.current.some(source => source.sourceId === sourceId))) return;
    if (previous.phase === "stopping" || (!stop && (previous.phase === "starting" || previous.phase === "live"))) return;
    if (stop && previous.phase !== "starting" && previous.phase !== "live") return;
    const attempt = stop ? previous.attempt : previous.attempt + 1;
    const turn = ++item.revision;
    item.pending = turn;
    item.status = { sourceId, attempt, phase: stop ? "stopping" : "starting", error: null };
    item.error = null; notify();
    try {
      const result = await invoke<ObsBroadcastStatus>(stop ? "obs_broadcast_stop" : "obs_broadcast_start", { id: sourceId, attempt });
      if (isCurrent(item, turn) && result.sourceId === sourceId && result.attempt === attempt) item.status = result;
    } catch (cause) {
      // A failed IPC is not proof that the native sender stopped.
      if (isCurrent(item, turn)) item.error = formatError(cause);
    } finally {
      if (item.pending === turn) item.pending = null;
      if (isCurrent(item, turn)) { reconcile(); notify(); }
    }
  }, [isCurrent, reconcile, notify]);
  const notices = [...entries.current.values()].map(item => ({ sourceName: item.sourceName, broadcast: {
    sourceId: item.sourceId, status: item.status, error: item.error, active: isActive(item.status),
    start: () => act(item, false), stop: () => act(item, true),
  } satisfies ObsBroadcast }));
  return { notices, forSource: (id: string | null) => notices.find(notice => notice.broadcast.sourceId === id)?.broadcast };
}
