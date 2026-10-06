import { invoke as nativeInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import type { PipelineRow } from "../bindings/PipelineRow";
import { formatError } from "./error-format";

/**
 * The Pipeline's page side: what a page is waiting on, and for how long.
 *
 * The backend already journals its own operations (aaf/diagnostics.rs). What
 * it cannot see is the page: a call that never came back, a calculation that
 * held the page's thread for two seconds, an error nothing caught. So every
 * call a page makes through `pipelineInvoke` is timed, a call still running
 * at 2, 10, 30 and 60 seconds says so AS IT WAITS (a hang that ends in Force
 * Quit is then already in the log), and a call that failed, waited or ran
 * long gets a row when it ends. Fast calls only count toward the per-command
 * table the export carries, so the log stays readable.
 *
 * Rows go to the same journal as the backend's, on disk, so the Pipeline is
 * one timeline and survives a relaunch. No transcript text, prompt or person
 * name is ever logged: a call is described by its command and its ids.
 */

export type PipelineLevel = "info" | "ok" | "warn" | "err";

const FLUSH_MS = 400;
let queue: PipelineRow[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
  const rows = queue.splice(0, 200);
  if (rows.length) {
    // The log must never be the thing that fails, and never a traced call itself.
    void Promise.resolve().then(() => nativeInvoke("pipeline_log", { rows })).catch(() => undefined);
  }
  if (queue.length) flushTimer = setTimeout(flush, FLUSH_MS);
}

/** One row in the Pipeline. Warnings and errors are written at once; the rest within half a second. */
export function pipelineLog(stage: string, message: string, level: PipelineLevel = "info", jobId = "") {
  queue.push({ job_id: jobId, level, stage, message });
  if (level === "warn" || level === "err") flush();
  else if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
}

export function msText(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 120_000) return `${Math.round(ms / 1_000)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

type Call = { stage: string; label: string; started: number; warned: number; timer: ReturnType<typeof setTimeout> | null };
export type InFlight = { stage: string; label: string; ms: number; warned: boolean };
export type CallStat = { command: string; calls: number; failed: number; totalMs: number; maxMs: number; lastError: string | null };
/** What the Pipeline's pill shows: whether anything is in flight, and the oldest call that has been waiting. */
export type PipelineActivity = { busy: boolean; waiting: string | null };

const inflight = new Set<Call>();
const stats = new Map<string, CallStat>();
const listeners = new Set<() => void>();
let activity: PipelineActivity = { busy: false, waiting: null };

/** When a call still running earns a row: 2 s, 10 s, 30 s, a minute, then every minute. */
export function waitMilestone(warned: number): number {
  return [2_000, 10_000, 30_000, 60_000][warned] ?? 60_000 * (warned - 2);
}
/** A call this long is worth a row even when it went fine. */
const SLOW_MS = 1_000;
/** Answers that are not failures, however they travel: a waveform nobody has built yet, a call the user stopped. */
const EXPECTED = /has not been built|cancel|abort|stopped/i;

export function inFlight(): InFlight[] {
  const now = performance.now();
  return [...inflight].map((call) => ({ stage: call.stage, label: call.label, ms: now - call.started, warned: call.warned > 0 }))
    .sort((a, b) => b.ms - a.ms);
}

export function callStats(): CallStat[] {
  return [...stats.values()].sort((a, b) => b.totalMs - a.totalMs);
}

/**
 * How long nothing must be in flight before the pill says so. String Outs
 * reads a string out's mics one call after another (121 for eight sequences),
 * and the pill went idle and busy again between every two of them: two
 * renders of the whole Pipeline per call.
 */
const IDLE_AFTER_MS = 150;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function changed() {
  if (inflight.size === 0 && activity.busy) {
    // Going idle waits a moment, and a call that starts meanwhile cancels it.
    if (idleTimer === null) idleTimer = setTimeout(() => { idleTimer = null; publish(); }, IDLE_AFTER_MS);
    return;
  }
  if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
  publish();
}

function publish() {
  const waiting = inFlight().find((call) => call.warned)?.label ?? null;
  const next = { busy: inflight.size > 0, waiting };
  // Only a change the pill can show notifies: a page making hundreds of calls must not re-render the log for each.
  if (next.busy === activity.busy && next.waiting === activity.waiting) return;
  activity = next;
  for (const listener of listeners) listener();
}

export function subscribePipelineActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function pipelineActivity(): PipelineActivity { return activity; }

function settle(call: Call, command: string, cause: unknown) {
  if (call.timer !== null) clearTimeout(call.timer);
  inflight.delete(call);
  const ms = performance.now() - call.started;
  const stat = stats.get(command) ?? { command, calls: 0, failed: 0, totalMs: 0, maxMs: 0, lastError: null };
  stat.calls += 1; stat.totalMs += ms; stat.maxMs = Math.max(stat.maxMs, ms);
  const message = cause === undefined ? null : formatError(cause);
  const expected = message !== null && EXPECTED.test(message);
  if (message !== null && !expected) { stat.failed += 1; stat.lastError = message; }
  stats.set(command, stat);
  if (message !== null && !expected) pipelineLog(call.stage, `${call.label} failed after ${msText(ms)}: ${message}`, "err");
  else if (call.warned) pipelineLog(call.stage, `${call.label} ${expected ? "stopped" : "finished"} after ${msText(ms)}.`, "ok");
  else if (ms >= SLOW_MS) pipelineLog(call.stage, `${call.label} took ${msText(ms)}${expected ? " and stopped" : ""}.`);
  changed();
}

/** Time `work`, say so while it waits, and record how it ended. */
export async function traced<T>(stage: string, label: string, command: string, work: () => Promise<T>): Promise<T> {
  const call: Call = { stage, label, started: performance.now(), warned: 0, timer: null };
  inflight.add(call);
  const arm = () => {
    call.timer = setTimeout(() => {
      call.warned += 1;
      const others = inflight.size - 1;
      pipelineLog(stage, `Still waiting on ${label} after ${msText(performance.now() - call.started)}`
        + `${others ? `; ${others} other ${others === 1 ? "call" : "calls"} in flight` : ""}.`, "warn");
      changed();
      arm();
    }, Math.max(0, waitMilestone(call.warned) - (performance.now() - call.started)));
  };
  arm();
  changed();
  try {
    const value = await work();
    settle(call, command, undefined);
    return value;
  } catch (cause) {
    settle(call, command, cause ?? new Error("Failed"));
    throw cause;
  }
}

/** The ids a call is told, never its text: enough to match a row to the backend's own. */
const SAFE_ARGS = ["documentId", "trackId", "id", "editId", "source", "startFrame", "durationFrames", "build", "jobId"] as const;

export function describeCall(command: string, args?: InvokeArgs): string {
  if (!args || typeof args !== "object" || Array.isArray(args) || args instanceof ArrayBuffer || ArrayBuffer.isView(args)) return command;
  const record = args as Record<string, unknown>;
  const parts = SAFE_ARGS.flatMap((key) => {
    const value = record[key];
    if (typeof value === "string" && value) return [`${key} ${value.length > 12 ? value.slice(0, 8) : value}`];
    if (typeof value === "number" || typeof value === "boolean") return [`${key} ${value}`];
    return [];
  });
  return parts.length ? `${command} (${parts.join(", ")})` : command;
}

/**
 * `invoke`, timed in the Pipeline under `stage`. Import it as `invoke` so the
 * call sites, and the contracts that read them, are unchanged.
 */
export function pipelineInvoke(stage: string) {
  return <T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> =>
    traced(stage, describeCall(command, args), command, () =>
      // Exactly the arguments it was given: a trailing undefined is a different call to a mock that checks them.
      options !== undefined ? nativeInvoke<T>(command, args, options) : args !== undefined ? nativeInvoke<T>(command, args) : nativeInvoke<T>(command));
}

/** Time a calculation on the page's own thread; one that holds it past `thresholdMs` gets a row. */
export function measure<T>(stage: string, label: string, work: () => T, thresholdMs = 100): T {
  const started = performance.now();
  const value = work();
  const ms = performance.now() - started;
  if (ms >= thresholdMs) pipelineLog(stage, `${label} held the page for ${msText(ms)}.`, ms >= 1_000 ? "warn" : "info");
  return value;
}

/** What a page tells the export about itself: a summary in counts and ids, and the AAF Audio documents it reads. */
export type PipelineContext = { text: string; documentIds: string[] };
const contexts = new Map<string, () => PipelineContext | null>();

export function setPipelineContext(page: string, source: (() => PipelineContext | null) | null) {
  if (source) contexts.set(page, source); else contexts.delete(page);
}
export function pipelineContext(page: string): PipelineContext | null {
  try { return contexts.get(page)?.() ?? null; } catch (cause) { return { text: `The page could not describe itself: ${formatError(cause)}`, documentIds: [] }; }
}

const TICK_MS = 250;
const BEAT_MS = 1_000;
/** A tick this late means the page's thread was busy for that long. */
const STALL_MS = 1_000;

/**
 * While a page is showing: tells the backend's watchdog it is alive (so a
 * page that stops answering is logged even if it never recovers), logs any
 * stretch the page's thread was held, and catches what nothing else caught.
 */
export function watchPage(page: string): () => void {
  let last = performance.now();
  let visible = document.visibilityState === "visible";
  const beat = () => { void Promise.resolve().then(() => nativeInvoke("pipeline_heartbeat", { page, visible })).catch(() => undefined); };
  const tick = window.setInterval(() => {
    const now = performance.now(), held = now - last - TICK_MS;
    last = now;
    // A hidden page's timers are throttled on purpose; their lateness is not a stall.
    if (!visible || held < STALL_MS) return;
    const waiting = inFlight().slice(0, 3).map((call) => call.label);
    pipelineLog(page, `The page did not respond for ${msText(held)}${waiting.length ? `. In flight meanwhile: ${waiting.join(", ")}` : ""}.`, held >= 5_000 ? "warn" : "info");
  }, TICK_MS);
  const beats = window.setInterval(beat, BEAT_MS);
  const onVisibility = () => { visible = document.visibilityState === "visible"; last = performance.now(); beat(); };
  const onError = (event: ErrorEvent) => pipelineLog(page, `Uncaught error: ${event.message}${event.filename ? ` (${event.filename.split("/").pop()}:${event.lineno})` : ""}`, "err");
  const onRejection = (event: PromiseRejectionEvent) => pipelineLog(page, `Unhandled rejection: ${formatError(event.reason)}`, "err");
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  beat();
  return () => {
    window.clearInterval(tick); window.clearInterval(beats);
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    visible = false; beat();
  };
}
