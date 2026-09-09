// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "./ReviewPanel";
import { AUTHOR_KEY, emptyDoc, type ReviewDoc } from "../lib/review";
import { createReviewSession } from "../lib/review-session";
import { createPlaybackSessionController } from "../lib/playback-session-controller";
import { associatePremiereInput, refreshPremiereLink, setPremiereRoom, setPremiereVisibleInput } from "../lib/premiere-link";
import { recordPremiereFrame } from "../lib/premiere-frames";
import type { PremiereBinding } from "../bindings/PremiereBinding";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
const binding: PremiereBinding = { bindingId: "binding", projectId: "project", sequenceId: "sequence",
  projectName: "Editorial", sequenceName: "Cut A", timebaseTicks: "10594584000", displayFormat: "102", zeroPointTicks: "914457600000000" };
const bridge = (bound = binding) => ({ phase: "connected", binding: bound, syncEnabled: true,
  automaticPlacement: false, pendingCount: 0, otherBindingPendingCount: 0, error: null });
beforeEach(async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "premiere_bridge_status" ? bridge() : command === "premiere_marker_notes" ? [] : null);
  localStorage.setItem(AUTHOR_KEY, JSON.stringify("Editor"));
  setPremiereRoom("off", ""); setPremiereVisibleInput(null);
  await refreshPremiereLink();
  setPremiereVisibleInput({ sourceId: "ndi:pass", streamId: "receiver-A", name: "Premiere" });
  associatePremiereInput();
  recordPremiereFrame("receiver-A", "decoder", 42, 1260);
});
afterEach(() => { cleanup(); localStorage.clear(); setPremiereVisibleInput(null); });
function setup() {
  const service = createReviewSession(createPlaybackSessionController(() => null));
  service.setProgramSource({ id: "ndi:pass", ownerId: "m0", kind: "ndi", label: "Premiere" });
  const doc: ReviewDoc = { ...emptyDoc("ndi:pass"), activeVersionId: "v",
    versions: [{ id: "v", label: "V1", path: "ndi:pass", addedAt: 0 }] };
  const post = vi.fn();
  const ui = render(<ReviewPanel sourceKey="ndi:pass" playheadActive={false} fps={24} onSeek={vi.fn()}
    sessionActive sessionDoc={doc} onSessionOp={post} reviewSession={service} />);
  return { ...ui, post, service };
}
describe("Premiere note composition", () => {
  it("holds the displayed moment from first typing across a long typing delay and sequence switch", async () => {
    const h = setup();
    fireEvent.click(h.getByRole("checkbox", { name: "Send this note to Premiere" }));
    fireEvent.change(h.getByRole("textbox", { name: "Comment" }), { target: { value: "Move this edit" } });
    recordPremiereFrame("receiver-A", "decoder", 120, 3600);
    mocks.invoke.mockImplementation(async (command: string) => command === "premiere_bridge_status"
      ? bridge({ ...binding, sequenceId: "another", bindingId: "another" }) : []);
    await act(refreshPremiereLink);
    fireEvent.click(h.getByRole("button", { name: "Post" }));
    expect(h.post).toHaveBeenCalledOnce();
    expect(h.post.mock.calls[0][0].comment).toMatchObject({ timeStart: 0, timeEnd: null,
      premiere: { binding, streamId: "receiver-A", mediaSeconds: 42, verification: "unverified" } });
    expect(h.post.mock.calls[0][0].comment.premiere.sequenceTicks).toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalledWith("premiere_enqueue_note", expect.anything());
  });
  it("leaves general notes alone unless marker intent is explicitly enabled", () => {
    const h = setup();
    fireEvent.change(h.getByRole("textbox", { name: "Comment" }), { target: { value: "General conversation" } });
    fireEvent.click(h.getByRole("button", { name: "Post" }));
    expect(h.post.mock.calls[0][0].comment.premiere).toBeUndefined();
  });
  it("requires a fresh binding after the receiver restarts even when the pass key is unchanged", () => {
    const h = setup();
    act(() => setPremiereVisibleInput({ sourceId: "ndi:pass", streamId: "receiver-B", name: "Premiere" }));
    expect(h.queryByRole("checkbox", { name: "Send this note to Premiere" })).toBeNull();
  });
  it("captures before a dictation request awaits native microphone setup", () => {
    const h = setup();
    fireEvent.click(h.getByRole("checkbox", { name: "Send this note to Premiere" }));
    fireEvent.click(h.getByRole("button", { name: /Dictate/ }));
    expect(mocks.invoke).toHaveBeenCalledWith("dictate_native_start", expect.anything());
    recordPremiereFrame("receiver-A", "decoder", 90, 2700);
    fireEvent.change(h.getByRole("textbox", { name: "Comment" }), { target: { value: "Spoken note" } });
    fireEvent.click(h.getByRole("button", { name: "Post" }));
    expect(h.post.mock.calls[0][0].comment.premiere.mediaSeconds).toBe(42);
  });
});
