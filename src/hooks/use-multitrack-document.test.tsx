// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { multitrackFixture, multitrackLinkedFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { useMultitrackDocument } from "./use-multitrack-document";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => { mocks.listeners.set(name, handler); return () => { if (mocks.listeners.get(name) === handler) mocks.listeners.delete(name); }; }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.open.mockResolvedValue("/fixtures/Interview.aaf");
  mocks.listeners.clear();
  mocks.invoke.mockImplementation((command: string) => Promise.resolve(command === "aaf_sequences" ? [{ id: "sequence", name: "Interview" }] : command === "aaf_list" ? [] : command === "aaf_import" ? multitrackFixture() : command === "aaf_waveform" ? { peaks: [[-.5, .5]] } : undefined));
});

describe("multitrack document ownership", () => {
  it.each([false, true])("opens %s saved/imported timeline before linked media finishes and only resolves once", async (saved) => {
    const disk = multitrackLinkedFixture(); disk.transcripts = [multitrackTranscript()];
    const pending = deferred<typeof disk>(), base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_resolve_media" ? pending.promise
      : command === "aaf_open" || command === "aaf_import" ? Promise.resolve(structuredClone(disk)) : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true));
    await act(async () => result.current.load(saved ? disk.id : undefined));
    expect(result.current.loading).toBe(false); expect(result.current.document?.transcripts).toHaveLength(1);
    expect(result.current.resolving).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "aaf_resolve_media")).toHaveLength(1);
    const { jobId } = mocks.invoke.mock.calls.find(([c]) => c === "aaf_resolve_media")![1];
    act(() => mocks.listeners.get("aaf-progress")?.({ payload: { job_id: jobId, phase: "resolving", completed_frames: 1, total_frames: 3 } }));
    expect(result.current.mediaProgress?.completed_frames).toBe(1);
    await act(async () => pending.resolve(disk));
    expect(result.current.resolving).toBe(false);
  });

  it("shows committed batches, retains ready waveforms and preserves owner edits across Stop", async () => {
    let disk = multitrackLinkedFixture(); const pending = deferred<typeof disk>(), base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "aaf_open" || command === "aaf_import") return Promise.resolve(structuredClone(disk));
      if (command === "aaf_resolve_media") return pending.promise;
      if (command === "aaf_save_labels") { disk.labels = args.labels; return Promise.resolve(structuredClone(disk)); }
      return base(command, args);
    });
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    act(() => result.current.setWaveformsOn(disk.id, true));
    const ready = multitrackLinkedFixture(true);
    disk.manifest.graph!.sources[0] = ready.manifest.graph!.sources[0]; disk.manifest.graph!.lanes[0].availability = "ready";
    await act(async () => mocks.listeners.get("saucebunny:multitrack-changed")?.({ payload: disk.id }));
    await waitFor(() => expect(result.current.waveforms["track-1"]).toBeDefined());
    act(() => result.current.rename("track-1", "Saved owner"));
    await waitFor(() => expect(result.current.labelStatus).toBe("Labels saved locally"));
    disk.transcripts = [multitrackTranscript()];
    disk.manifest.graph!.sources[1] = ready.manifest.graph!.sources[1]; disk.manifest.graph!.lanes[1].availability = "ready";
    const stale = multitrackLinkedFixture();
    // Native saved this batch but its event was lost. Stop must reconcile disk.
    act(() => result.current.stopResolution());
    await act(async () => pending.resolve(stale));
    expect(result.current.document?.labels[0].owner_name).toBe("Saved owner");
    expect(result.current.document?.transcripts).toHaveLength(1);
    expect(result.current.document?.manifest.graph?.lanes[1].availability).toBe("ready");
    expect(result.current.waveforms["track-1"]).toBeDefined();
    expect(mocks.invoke.mock.calls.filter(([c, a]) => c === "aaf_waveform" && a.trackId === "track-1")).toHaveLength(1);
    const { jobId } = mocks.invoke.mock.calls.find(([c]) => c === "aaf_resolve_media")![1];
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId });
  });

  it("a checkpoint that readies another mic does not cancel an in-flight waveform build", async () => {
    const disk = multitrackLinkedFixture(), ready = multitrackLinkedFixture(true), base = mocks.invoke.getMockImplementation()!;
    const first = deferred<{ peaks: number[][] }>();
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "aaf_open" || command === "aaf_import") return Promise.resolve(structuredClone(disk));
      if (command === "aaf_resolve_media") return new Promise(() => {});
      if (command === "aaf_waveform" && args.trackId === "track-1") return first.promise;
      return base(command, args);
    });
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    act(() => { result.current.showTracks(["track-1", "track-2"]); result.current.setWaveformsOn(disk.id, true); });
    disk.manifest.graph!.sources[0] = ready.manifest.graph!.sources[0]; disk.manifest.graph!.lanes[0].availability = "ready";
    await act(async () => mocks.listeners.get("saucebunny:multitrack-changed")?.({ payload: disk.id }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([c, a]) => c === "aaf_waveform" && a.trackId === "track-1")).toHaveLength(1));
    const { jobId } = mocks.invoke.mock.calls.find(([c, a]) => c === "aaf_waveform" && a.trackId === "track-1")![1];
    // The next checkpoint changes the document but not track-1's media.
    disk.manifest.graph!.sources[1] = ready.manifest.graph!.sources[1]; disk.manifest.graph!.lanes[1].availability = "ready";
    await act(async () => mocks.listeners.get("saucebunny:multitrack-changed")?.({ payload: disk.id }));
    expect(mocks.invoke).not.toHaveBeenCalledWith("cancel_job", { jobId });
    await act(async () => first.resolve({ peaks: [[-.25, .25]] }));
    await waitFor(() => expect(result.current.waveforms["track-1"]).toEqual([[-.25, .25]]));
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([c, a]) => c === "aaf_waveform" && a.trackId === "track-2")).toBe(true));
    expect(mocks.invoke.mock.calls.filter(([c, a]) => c === "aaf_waveform" && a.trackId === "track-1")).toHaveLength(1);
  });

  it("cancels background checks on navigation and ignores their late responses", async () => {
    const disk = multitrackLinkedFixture(), other = { ...multitrackFixture(), id: "other" };
    const pending = deferred<typeof disk>(), base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_resolve_media" ? pending.promise
      : command === "aaf_import" ? Promise.resolve(disk)
      : command === "aaf_open" ? Promise.resolve(args.documentId === other.id ? other : disk) : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    const { jobId } = mocks.invoke.mock.calls.find(([c]) => c === "aaf_resolve_media")![1];
    await act(async () => result.current.load(other.id));
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId });
    await act(async () => pending.resolve(multitrackLinkedFixture(true)));
    expect(result.current.document?.id).toBe("other"); expect(result.current.resolving).toBe(false);
  });

  it("offers multiple top-level sequences and imports only the user's choice", async () => {
    const base=mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command,args)=>command==="aaf_sequences"?Promise.resolve([{id:"one",name:"First"},{id:"two",name:"Second"}]):base(command,args));
    const {result}=renderHook(()=>useMultitrackDocument(true)); await act(async()=>result.current.load());
    expect(result.current.sequenceChoices?.choices).toHaveLength(2); expect(result.current.document).toBeNull();
    expect(mocks.invoke.mock.calls.some(([command])=>command==="aaf_import")).toBe(false);
    act(()=>result.current.chooseSequence("two"));
    await waitFor(()=>expect(result.current.document).not.toBeNull());
    expect(mocks.invoke).toHaveBeenCalledWith("aaf_import",expect.objectContaining({sequenceId:"two",path:"/fixtures/Interview.aaf"}));
  });
  it("keeps queued owner edits when another sequence is opened before returning", async () => {
    let disk = multitrackFixture();
    const other = { ...multitrackFixture(), id: "other-sequence" }, gate = deferred<void>();
    let writes = 0;
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "aaf_list") return [];
      if (command === "aaf_sequences") return [{ id: "sequence", name: "Interview" }];
      if (command === "aaf_import") return structuredClone(disk);
      if (command === "aaf_open") return structuredClone(args.documentId === other.id ? other : disk);
      if (command === "aaf_waveform") return { peaks: [[-.5, .5]] };
      if (command === "aaf_save_labels") {
        if (++writes === 1) await gate.promise;
        disk = { ...disk, labels: structuredClone(args.labels) }; return structuredClone(disk);
      }
    });
    const { result } = renderHook(() => useMultitrackDocument(true));
    await act(async () => result.current.load());
    act(() => result.current.rename("track-1", "Renamed Owner"));
    await waitFor(() => expect(writes).toBe(1));
    await act(async () => result.current.load(other.id));
    let reopening!: Promise<void>;
    act(() => { reopening = result.current.load(disk.id); });
    await act(async () => { gate.resolve(); await reopening; });
    expect(result.current.document?.labels.find(label => label.track_id === "track-1")?.owner_name).toBe("Renamed Owner");
    act(() => result.current.rename("track-2", "Second Owner"));
    await waitFor(() => expect(writes).toBe(2));
    expect(disk.labels.find(label => label.track_id === "track-1")?.owner_name).toBe("Renamed Owner");
  });

  it("rejects a reopen snapshot if an owner edit was queued while it was being read", async () => {
    let disk = multitrackFixture(); const staleRead = deferred<ReturnType<typeof multitrackFixture>>(); let reads = 0;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "aaf_open") return ++reads === 1 ? staleRead.promise : Promise.resolve(structuredClone(disk));
      if (command === "aaf_save_labels") { disk = { ...disk, labels: structuredClone(args.labels) }; return Promise.resolve(structuredClone(disk)); }
      return base(command, args);
    });
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    const old = structuredClone(disk); let reopening!: Promise<void>;
    act(() => { reopening = result.current.load(disk.id); });
    await waitFor(() => expect(reads).toBe(1));
    act(() => result.current.rename("track-1", "Newest Owner"));
    await act(async () => { staleRead.resolve(old); await reopening; });
    expect(result.current.document?.labels.find(label => label.track_id === "track-1")?.owner_name).toBe("Newest Owner");
  });

  it("a run's change event and its result read the document once, and the words keep their identity", async () => {
    const disk = multitrackFixture(), base = mocks.invoke.getMockImplementation()!;
    const read = deferred<ReturnType<typeof multitrackFixture>>(); let reads = 0;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "aaf_open") return ++reads === 1 ? read.promise : Promise.resolve(structuredClone(disk));
      return base(command, args);
    });
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    // The run commits, says so, and then returns its result while the re-read is out.
    disk.transcripts = [multitrackTranscript()];
    act(() => { void mocks.listeners.get("saucebunny:multitrack-changed")?.({ payload: disk.id }); });
    await waitFor(() => expect(reads).toBe(1));
    act(() => result.current.acceptTranscript(structuredClone(disk.transcripts[0])));
    const words = result.current.document?.transcripts;
    await act(async () => read.resolve(structuredClone(disk)));
    expect(reads).toBe(1);
    expect(result.current.document?.transcripts).toBe(words);
  });

  it("a result the change event already delivered is not merged a second time", async () => {
    const disk = multitrackFixture(), base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_open" ? Promise.resolve(structuredClone(disk)) : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    disk.transcripts = [multitrackTranscript()];
    await act(async () => mocks.listeners.get("saucebunny:multitrack-changed")?.({ payload: disk.id }));
    const words = result.current.document?.transcripts;
    expect(words).toHaveLength(1);
    act(() => result.current.acceptTranscript(structuredClone(disk.transcripts[0])));
    expect(result.current.document?.transcripts).toBe(words);
    // A different result for the track is still taken.
    const rerun = { ...structuredClone(disk.transcripts[0]), model_id: "another-model" };
    act(() => result.current.acceptTranscript(rerun));
    expect(result.current.document?.transcripts.find((item) => item.track_id === "track-1")?.model_id).toBe("another-model");
  });

  it("a label edit during the change event's read still reads again", async () => {
    let disk = multitrackFixture(); const base = mocks.invoke.getMockImplementation()!;
    const read = deferred<ReturnType<typeof multitrackFixture>>(); let reads = 0;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "aaf_open") return ++reads === 1 ? read.promise : Promise.resolve(structuredClone(disk));
      if (command === "aaf_save_labels") { disk = { ...disk, labels: structuredClone(args.labels) }; return Promise.resolve(structuredClone(disk)); }
      return base(command, args);
    });
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    const old = structuredClone(disk);
    act(() => { void mocks.listeners.get("saucebunny:multitrack-changed")?.({ payload: disk.id }); });
    await waitFor(() => expect(reads).toBe(1));
    act(() => result.current.rename("track-1", "Newest Owner"));
    await act(async () => read.resolve(old));
    await waitFor(() => expect(reads).toBe(2));
    expect(result.current.document?.labels.find(label => label.track_id === "track-1")?.owner_name).toBe("Newest Owner");
  });

  it("a legacy metadata inspection cannot restore labels older than an overlapping save", async () => {
    let disk = multitrackFixture(); const metadata = deferred<ReturnType<typeof multitrackFixture>>();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "aaf_open") return Promise.resolve(structuredClone(disk));
      if (command === "aaf_read_recording_dates") return metadata.promise;
      if (command === "aaf_save_labels") { disk = { ...disk, labels: structuredClone(args.labels) }; return Promise.resolve(structuredClone(disk)); }
      return base(command, args);
    });
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    delete disk.manifest.recording_dates;
    const stale = structuredClone(disk); let reopening!: Promise<void>;
    act(() => { reopening = result.current.load(disk.id); });
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("aaf_read_recording_dates", expect.anything()));
    act(() => result.current.rename("track-1", "Saved during inspection", undefined, undefined, { gender: "woman", marker_color: "pink" }));
    await act(async () => { metadata.resolve(stale); await reopening; });
    expect(result.current.document?.labels[0]).toMatchObject({ owner_name: "Saved during inspection", gender: "woman", marker_color: "pink" });
  });

  it("Stop cancels a reopen waiting for labels without cancelling the save", async () => {
    const gate = deferred<void>(), base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_save_labels" ? gate.promise : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    act(() => result.current.rename("track-1", "Keep this edit"));
    let reopening!: Promise<void>;
    act(() => { reopening = result.current.load(multitrackFixture().id); });
    act(() => result.current.cancelImport());
    await act(async () => { gate.resolve(); await reopening; });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_open")).toHaveLength(0);
    expect(result.current.document?.labels.find(label => label.track_id === "track-1")?.owner_name).toBe("Keep this edit");
    expect(result.current.loading).toBe(false);
  });

  it("does not start work while hidden and cancels waveform reading on departure", async () => {
    const pending = deferred<{ peaks: number[][] }>();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_waveform" ? pending.promise : base(command, args));
    const { result, rerender } = renderHook(({ active }) => useMultitrackDocument(active), { initialProps: { active: false } });
    expect(mocks.invoke).not.toHaveBeenCalled();
    rerender({ active: true });
    await act(async () => result.current.load());
    act(() => result.current.setWaveformsOn(result.current.document!.id, true));
    // Two builds at once, never more.
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(2));
    const jobIds = mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform").map(([, args]) => args.jobId);
    rerender({ active: false });
    for (const jobId of jobIds) expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId });
    await act(async () => pending.resolve({ peaks: [[-1, 1]] }));
    expect(result.current.waveforms).toEqual({});
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(2);
    mocks.invoke.mockImplementation(base);
    rerender({ active: true });
    await waitFor(() => expect(Object.keys(result.current.waveforms)).toHaveLength(3));
    const completed = mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform").length;
    rerender({ active: false }); rerender({ active: true });
    await act(async () => {});
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(completed);
  });

  it("builds nothing until Waveforms is turned on, and turning it off stops the build", async () => {
    const pending = deferred<{ peaks: number[][] }>();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_waveform" ? pending.promise : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true));
    await act(async () => result.current.load());
    await act(async () => {});
    // Opening a sequence reads its timeline and nothing else.
    expect(mocks.invoke.mock.calls.some(([command]) => command === "aaf_waveform")).toBe(false);
    const id = result.current.document!.id;
    // Another sequence's choice is not this one's.
    act(() => result.current.setWaveformsOn("another-sequence", true));
    await act(async () => {});
    expect(mocks.invoke.mock.calls.some(([command]) => command === "aaf_waveform")).toBe(false);
    act(() => result.current.setWaveformsOn(id, true));
    await waitFor(() => expect(result.current.waveformsBuilding).toEqual(["track-1", "track-2"]));
    const jobIds = mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform").map(([, args]) => args.jobId);
    act(() => result.current.setWaveformsOn(id, false));
    for (const jobId of jobIds) expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId });
    await act(async () => pending.resolve({ peaks: [[-1, 1]] }));
    expect(result.current.waveforms).toEqual({});
    expect(result.current.waveformsBuilding).toEqual([]);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(2);
  });

  it("builds two at a time and starts the next as each one finishes", async () => {
    const answers = new Map<string, ReturnType<typeof deferred<{ peaks: number[][] }>>>();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => {
      if (command !== "aaf_waveform") return base(command, args);
      const answer = deferred<{ peaks: number[][] }>(); answers.set(args.trackId, answer); return answer.promise;
    });
    const { result } = renderHook(() => useMultitrackDocument(true));
    await act(async () => result.current.load());
    act(() => result.current.setWaveformsOn(result.current.document!.id, true));
    await waitFor(() => expect([...answers.keys()]).toEqual(["track-1", "track-2"]));
    await act(async () => answers.get("track-2")!.resolve({ peaks: [[-.5, .5]] }));
    await waitFor(() => expect([...answers.keys()]).toEqual(["track-1", "track-2", "track-3"]));
    expect(result.current.waveformsBuilding).toEqual(["track-1", "track-3"]);
    expect(result.current.waveforms["track-2"]).toEqual([[-.5, .5]]);
  });

  it("a failed build blocks only its own track, even where tracks look alike", async () => {
    // The fixture's three tracks have identical clips, so identical media revisions.
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_waveform" && args.trackId === "track-1"
      ? Promise.reject(new Error("Decoder failed")) : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true));
    await act(async () => result.current.load());
    act(() => result.current.setWaveformsOn(result.current.document!.id, true));
    await waitFor(() => expect(Object.keys(result.current.waveforms).sort()).toEqual(["track-2", "track-3"]));
    expect(result.current.waveformErrors["track-1"]).toMatch(/Decoder failed/);
    expect(mocks.invoke.mock.calls.filter(([c, a]) => c === "aaf_waveform" && a.trackId === "track-1")).toHaveLength(1);
  });

  it("a build stopped by Waveforms off and straight back on is not a failure: it builds again", async () => {
    const rejects: ((cause: unknown) => void)[] = [];
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_waveform" && args.trackId === "track-1" && rejects.length === 0
      ? new Promise((_done, fail) => { rejects.push(fail); }) : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true));
    await act(async () => result.current.load());
    const id = result.current.document!.id;
    act(() => result.current.setWaveformsOn(id, true));
    await waitFor(() => expect(rejects).toHaveLength(1));
    // Off and on again before the cancel lands: the old job is still building.
    act(() => { result.current.setWaveformsOn(id, false); result.current.setWaveformsOn(id, true); });
    await act(async () => rejects[0]({ kind: "Cancelled" }));
    await waitFor(() => expect(result.current.waveforms["track-1"]).toEqual([[-.5, .5]]));
    expect(result.current.waveformErrors["track-1"]).toBeUndefined();
  });

  it("a track that failed in one sequence builds again after the sequence is reopened", async () => {
    let fail = true;
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_waveform" && args.trackId === "track-1" && fail
      ? Promise.reject(new Error("Media offline")) : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true));
    await act(async () => result.current.load());
    const id = result.current.document!.id;
    act(() => result.current.setWaveformsOn(id, true));
    await waitFor(() => expect(result.current.waveformErrors["track-1"]).toMatch(/Media offline/));
    fail = false;
    const other = multitrackFixture(); other.id = "other-sequence";
    mocks.invoke.mockImplementation((command, args) => command === "aaf_open" && args.documentId === "other-sequence" ? Promise.resolve(other)
      : command === "aaf_open" ? Promise.resolve(multitrackFixture()) : base(command, args));
    await act(async () => result.current.load("other-sequence"));
    await act(async () => result.current.load(id));
    act(() => result.current.setWaveformsOn(result.current.document!.id, true));
    await waitFor(() => expect(result.current.waveforms["track-1"]).toEqual([[-.5, .5]]));
  });

  it("ignores a cancelled import that completes late", async () => {
    const pending = deferred<ReturnType<typeof multitrackFixture>>();
    const base = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_import" ? pending.promise : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true));
    let work!: Promise<void>;
    act(() => { work = result.current.load(); });
    await waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "aaf_import")).toBe(true));
    act(() => result.current.cancelImport());
    await act(async () => { pending.resolve(multitrackFixture()); await work; });
    expect(result.current.document).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(mocks.invoke.mock.calls.some(([command]) => command === "aaf_waveform")).toBe(false);
  });

  it("normalizes Unicode mic names and serializes label snapshots", async () => {
    const first = deferred<void>();
    const base = mocks.invoke.getMockImplementation()!;
    let saves = 0;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_save_labels" && ++saves === 1 ? first.promise : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true));
    await act(async () => result.current.load());
    act(() => result.current.rename("track-1", " Jose\u0301 "));
    await waitFor(() => expect(saves).toBe(1));
    act(() => result.current.rename("track-2", 'Sam, "Room"'));
    expect(saves).toBe(1);
    expect(result.current.document?.labels.find((label) => label.track_id === "track-1")?.owner_name).toBe("José");
    await act(async () => first.resolve());
    await waitFor(() => expect(saves).toBe(2));
    const last = mocks.invoke.mock.calls.filter(([command]) => command === "aaf_save_labels").at(-1)!;
    expect(last[1].labels).toEqual(expect.arrayContaining([expect.objectContaining({ owner_name: "José" }), expect.objectContaining({ owner_name: 'Sam, "Room"' })]));
    expect(result.current.labelStatus).toBe("Labels saved locally");
  });

  it("an unreadable AAF stops every lane's waveform after the first answer, once, and Retry asks again", async () => {
    // The original AAF on an unmounted drive: every lane's overview needs it,
    // so one NotFound stands for all of them instead of a failure per lane.
    const base = mocks.invoke.getMockImplementation()!;
    let reachable = false;
    mocks.invoke.mockImplementation((command, args) => command === "aaf_waveform" && !reachable
      ? Promise.reject({ kind: "NotFound", data: "The original AAF is unavailable. Reconnect its drive or import it again." }) : base(command, args));
    const { result } = renderHook(() => useMultitrackDocument(true)); await act(async () => result.current.load());
    const doc = result.current.document!;
    act(() => { result.current.showTracks(doc.manifest.tracks.map((track) => track.id)); result.current.setWaveformsOn(doc.id, true); });
    await waitFor(() => expect(result.current.sourceOffline).toContain("The original AAF is unavailable"));
    const asked = mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform").length;
    expect(asked, "every lane was asked after the AAF was known to be offline").toBeLessThanOrEqual(2);
    expect(result.current.waveformErrors).toEqual({});
    reachable = true;
    await act(async () => result.current.retrySource());
    await waitFor(() => expect(Object.keys(result.current.waveforms).length).toBeGreaterThan(0));
    expect(result.current.sourceOffline).toBeNull();
  });
});
