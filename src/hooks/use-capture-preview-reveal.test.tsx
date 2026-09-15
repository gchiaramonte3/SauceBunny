// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ObsSelection } from "../bindings/ObsSelection";
import { emptyNdiTelemetry, type NdiLocalProgram } from "../lib/ndi-program-coordinator";
import { copyCaptureSelection } from "../lib/ndi-program-source";
import { useCapturePreviewReveal } from "./use-capture-preview-reveal";

const selection = (): Exclude<ObsSelection, { kind: "display" }> => ({ application: "com.generated.Editor", process: 101, window: 501,
  crop: { x: .1, y: .2, width: .5, height: .6 }, audio: false });
function candidate(overrides: Partial<NdiLocalProgram> = {}, capture = selection()): NdiLocalProgram {
  return { id: "a".repeat(32), name: "Generated editor window", url: "/generated-not-loaded", reviewKey: "generated-review",
    source: { kind: "capture", selection: copyCaptureSelection(capture) }, capture: copyCaptureSelection(capture),
    telemetry: { ...emptyNdiTelemetry(), phase: "live", connectionCount: 1 }, encodedReady: false, decodedReady: false,
    retired: false, roomGeneration: null, ...overrides };
}
const ready = (overrides: Partial<NdiLocalProgram> = {}, capture = selection()) =>
  candidate({ encodedReady: true, decodedReady: true, ...overrides }, capture);
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Props = Parameters<typeof useCapturePreviewReveal>[0];
function harness(initial: Partial<Props> = {}) {
  const onReveal = vi.fn();
  let props: Props = { open: true, candidate: candidate(), busy: false, error: null, onReveal, ...initial };
  const view = renderHook((input: Props) => useCapturePreviewReveal(input), { initialProps: props });
  return { ...view, onReveal,
    update(next: Partial<Props>) { props = { ...props, ...next }; view.rerender(props); },
    begin(capture = selection()) {
      const pending = deferred(), start = vi.fn(() => pending.promise);
      let request!: Promise<void>;
      act(() => { request = view.result.current.preview(capture, start); });
      return { ...pending, start, request,
        async complete() { await act(async () => { pending.resolve(); await request; }); } };
    },
  };
}
afterEach(cleanup);

describe("explicit capture preview reveal", () => {
  it("does not start or reveal merely by opening an already ready candidate", () => {
    const h = harness({ open: false, candidate: ready() });
    h.update({ open: true }); h.update({ candidate: ready() });
    h.update({ open: false }); h.update({ open: true });
    expect(h.onReveal).not.toHaveBeenCalled();
  });

  it("startup completion alone does not prove a decoded and encoded picture", async () => {
    const h = harness(); const start = h.begin();
    expect(start.start).toHaveBeenCalledTimes(1);
    await start.complete();
    expect(h.onReveal).not.toHaveBeenCalled();
    h.update({ candidate: candidate({ encodedReady: true }) });
    expect(h.onReveal).not.toHaveBeenCalled();
    h.update({ candidate: ready() });
    expect(h.onReveal).toHaveBeenCalledTimes(1);
    h.update({ candidate: ready() }); h.update({ busy: true }); h.update({ busy: false });
    expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it.each(["encoded", "decoded"] as const)("accepts independent readiness arriving %s first, only after startup completes", async first => {
    const h = harness(); const start = h.begin();
    h.update({ candidate: candidate(first === "encoded" ? { encodedReady: true } : { decodedReady: true }) });
    expect(h.onReveal).not.toHaveBeenCalled();
    h.update({ candidate: ready() });
    expect(h.onReveal).not.toHaveBeenCalled();
    await start.complete();
    expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it.each(["encoded", "decoded"] as const)("waits for the other readiness signal when %s arrives after startup", async first => {
    const h = harness(); const start = h.begin(); await start.complete();
    h.update({ candidate: candidate(first === "encoded" ? { encodedReady: true } : { decodedReady: true }) });
    expect(h.onReveal).not.toHaveBeenCalled();
    h.update({ candidate: ready() }); expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it("does not reveal while another coordinator action remains busy", async () => {
    const h = harness({ busy: true }); const start = h.begin();
    h.update({ candidate: ready() }); await start.complete();
    expect(h.onReveal).not.toHaveBeenCalled();
    h.update({ busy: false }); expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it.each(["off", "disconnected"] as const)("does not mistake %s telemetry for usable picture readiness", async reason => {
    const telemetry: NdiLocalProgram["telemetry"] = { ...emptyNdiTelemetry(), phase: reason === "off" ? "off" : "live", connectionCount: reason === "off" ? 1 : 0 };
    const h = harness({ candidate: ready({ telemetry }) }); const start = h.begin();
    await start.complete(); expect(h.onReveal).not.toHaveBeenCalled();
    h.update({ candidate: ready() }); expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it.each(["coordinator", "telemetry", "phase", "retired", "missing"] as const)("invalidates a completed request after %s failure rather than closing on later recovery", async failure => {
    const h = harness(); const start = h.begin(); await start.complete();
    if (failure === "coordinator") h.update({ error: "Generated startup error" });
    else if (failure === "missing") h.update({ candidate: null });
    else h.update({ candidate: candidate(failure === "retired" ? { retired: true }
      : { telemetry: { ...emptyNdiTelemetry(), phase: failure === "phase" ? "error" : "live", connectionCount: 1,
        error: failure === "telemetry" ? "Generated decoder error" : null } }) });
    h.update({ error: null, candidate: ready() });
    expect(h.onReveal).not.toHaveBeenCalled();
  });

  it("propagates startup rejection and cannot reveal from its late ready telemetry", async () => {
    const h = harness(); const start = h.begin();
    const failure = new Error("Generated start rejected");
    const outcome = start.request.catch(error => error);
    await act(async () => { start.reject(failure); expect(await outcome).toBe(failure); });
    h.update({ candidate: ready() }); expect(h.onReveal).not.toHaveBeenCalled();
  });

  it.each(["cancel", "selection change", "Done then reopen", "close then reopen"] as const)("%s invalidates a pending result for this visit", async reason => {
    const h = harness(); const start = h.begin();
    if (reason === "close then reopen") { h.update({ open: false }); h.update({ open: true }); }
    else {
      // The panel calls cancel for Done, Cancel preview and edited selections.
      act(() => h.result.current.cancel());
      if (reason === "Done then reopen") { h.update({ open: false }); h.update({ open: true }); }
    }
    h.update({ candidate: ready() }); await start.complete();
    expect(h.onReveal).not.toHaveBeenCalled();
  });

  it("unmount invalidates a pending result without invoking its old close callback", async () => {
    const h = harness(); const start = h.begin(); h.unmount();
    await start.complete(); expect(h.onReveal).not.toHaveBeenCalled();
  });

  it.each(["application", "process", "window", "x", "y", "width", "height", "audio", "kind"] as const)("requires the exact requested %s, not a similar ready source", async field => {
    const capture = selection();
    if (field === "application") capture.application = "com.generated.Other";
    else if (field === "process") capture.process++;
    else if (field === "window") capture.window++;
    else if (field === "audio") capture.audio = true;
    else if (field !== "kind") capture.crop[field] += .01;
    const h = harness(); const start = h.begin(); await start.complete();
    h.update({ candidate: ready(field === "kind" ? { source: { kind: "ndi", name: "Generated editor window" } } : {}, capture) });
    h.update({ candidate: ready() });
    expect(h.onReveal).not.toHaveBeenCalled();
  });

  it("treats omitted audio as enabled, matching the existing capture contract", async () => {
    const requested = selection(); delete requested.audio;
    const h = harness({ candidate: ready({}, { ...requested, audio: true }) }); const start = h.begin(requested);
    await start.complete(); expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it("snapshots the selection so caller mutation cannot redirect a pending request", async () => {
    const requested = selection(); const h = harness(); const start = h.begin(requested);
    requested.window++; requested.crop.x += .1; requested.audio = true;
    h.update({ candidate: ready() }); await start.complete();
    expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it("a new candidate ID cannot fulfill an already matched request, even for the same selection", async () => {
    const h = harness(); const start = h.begin(); await start.complete();
    h.update({ candidate: ready({ id: "b".repeat(32) }) });
    h.update({ candidate: ready() }); expect(h.onReveal).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)("a stale startup %s cannot complete or cancel a later explicit request", async outcome => {
    const h = harness(); const old = h.begin();
    const oldOutcome = old.request.catch(error => error);
    const nextSelection = { ...selection(), window: 601 };
    const next = h.begin(nextSelection);
    h.update({ candidate: ready({ id: "b".repeat(32) }, nextSelection) });
    await act(async () => {
      if (outcome === "resolve") old.resolve(); else old.reject(new Error("Generated obsolete failure"));
      await oldOutcome;
    });
    expect(h.onReveal).not.toHaveBeenCalled();
    await next.complete(); expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it("same-selection candidate replacement during pending startup invalidates the earlier reveal", async () => {
    const h = harness({ candidate: null, busy: true }); const start = h.begin();
    h.update({ candidate: candidate() });
    h.update({ candidate: ready({ id: "b".repeat(32) }) });
    await start.complete(); h.update({ busy: false });
    expect(h.onReveal).not.toHaveBeenCalled();
  });

  it.each(["missing", "retired", "telemetry error", "coordinator error"] as const)("a matched candidate becoming %s during startup invalidates later readiness", async failure => {
    const h = harness({ candidate: null, busy: true }); const start = h.begin();
    h.update({ candidate: candidate() });
    if (failure === "coordinator error") h.update({ error: "Generated capture failure" });
    else h.update({ candidate: failure === "missing" ? null : candidate(failure === "retired" ? { retired: true }
      : { telemetry: { ...emptyNdiTelemetry(), phase: "error", error: "Generated decoder failure" } }) });
    h.update({ candidate: ready(), error: null });
    await start.complete(); h.update({ busy: false });
    expect(h.onReveal).not.toHaveBeenCalled();
  });

  it("does not bind or reject the old unrelated picture retained during replacement startup", async () => {
    const requested = { ...selection(), window: 601 };
    const h = harness({ candidate: ready(), busy: true }); const start = h.begin(requested);
    h.update({ candidate: ready({ retired: true }) });
    h.update({ candidate: candidate({ id: "b".repeat(32) }, requested) });
    await start.complete(); h.update({ busy: false, candidate: ready({ id: "b".repeat(32) }, requested) });
    expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it.each(["retired", "error"] as const)("an already %s candidate does not bind a new explicit retry to the old receiver", async failure => {
    const old = candidate(failure === "retired" ? { retired: true }
      : { telemetry: { ...emptyNdiTelemetry(), phase: "error", error: "Generated old receiver failure" } });
    const h = harness({ candidate: old, busy: true }); const start = h.begin();
    h.update({ candidate: candidate({ id: "b".repeat(32) }) });
    await start.complete(); h.update({ busy: false, candidate: ready({ id: "b".repeat(32) }) });
    expect(h.onReveal).toHaveBeenCalledTimes(1);
  });

  it("late startup from a closed visit cannot reveal or invalidate the new visit's explicit request", async () => {
    const h = harness(); const old = h.begin();
    h.update({ open: false });
    const newReveal = vi.fn(); h.update({ open: true, onReveal: newReveal });
    const next = h.begin(); h.update({ candidate: ready() });
    await old.complete();
    expect(h.onReveal).not.toHaveBeenCalled(); expect(newReveal).not.toHaveBeenCalled();
    await next.complete(); expect(newReveal).toHaveBeenCalledTimes(1);
  });
});
