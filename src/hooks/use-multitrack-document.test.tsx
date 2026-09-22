// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { multitrackFixture } from "../test/multitrack-fixture";
import { useMultitrackDocument } from "./use-multitrack-document";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
beforeEach(() => {
  vi.clearAllMocks(); mocks.open.mockResolvedValue("/fixtures/Interview.aaf");
  mocks.invoke.mockImplementation((command: string) => Promise.resolve(command === "aaf_sequences" ? [{ id: "sequence", name: "Interview" }] : command === "aaf_list" ? [] : command === "aaf_import" ? multitrackFixture() : command === "aaf_waveform" ? { peaks: [[-.5, .5]] } : undefined));
});

describe("multitrack document ownership", () => {
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
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(1));
    const jobId = mocks.invoke.mock.calls.find(([command]) => command === "aaf_waveform")![1].jobId;
    rerender({ active: false });
    expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId });
    await act(async () => pending.resolve({ peaks: [[-1, 1]] }));
    expect(result.current.waveforms).toEqual({});
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(1);
    mocks.invoke.mockImplementation(base);
    rerender({ active: true });
    await waitFor(() => expect(Object.keys(result.current.waveforms)).toHaveLength(3));
    const completed = mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform").length;
    rerender({ active: false }); rerender({ active: true });
    await act(async () => {});
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "aaf_waveform")).toHaveLength(completed);
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
});
