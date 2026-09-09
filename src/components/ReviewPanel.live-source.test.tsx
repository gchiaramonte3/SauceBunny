// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "./ReviewPanel";
import { AUTHOR_KEY, buildComment, emptyDoc, type ReviewDoc } from "../lib/review";
import { createReviewSession } from "../lib/review-session";
import { createPlaybackSessionController } from "../lib/playback-session-controller";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
afterEach(() => { cleanup(); localStorage.clear(); });

describe("live review note identity", () => {
  it("preserves the named pass when the receiver reconnects or the panel remounts", () => {
    localStorage.setItem(AUTHOR_KEY, JSON.stringify("Editor"));
    const doc = { ...emptyDoc("ndi:review"), activeVersionId: "v", versions: [{ id: "v", label: "V1", path: "ndi", addedAt: 0 }] };
    const service = createReviewSession(createPlaybackSessionController(() => null));
    service.setProgramSource({ id: "ndi:review", ownerId: "m0", kind: "ndi", label: "Premiere" });
    const props = { sourceKey: "ndi:review", playheadActive: false, fps: 24, onSeek: vi.fn(), sessionActive: true, sessionDoc: doc, reviewSession: service };
    const h = render(<ReviewPanel {...props}/>);
    fireEvent.change(h.getByRole("textbox", { name: "Sequence / pass" }), { target: { value: "Sequence A / pass 4" } });
    act(() => service.setProgramSource(null));
    act(() => service.setProgramSource({ id: "ndi:review", ownerId: "m0", kind: "ndi", label: "Premiere reconnected" }));
    expect((h.getByRole("textbox", { name: "Sequence / pass" }) as HTMLInputElement).value).toBe("Sequence A / pass 4");
    h.unmount();
    const reopened = render(<ReviewPanel {...props}/>);
    expect((reopened.getByRole("textbox", { name: "Sequence / pass" }) as HTMLInputElement).value).toBe("Sequence A / pass 4");
  });
  it("retains drafts and incoming comments while private preview blocks composition", () => {
    localStorage.setItem(AUTHOR_KEY, JSON.stringify("Editor"));
    const doc: ReviewDoc = { ...emptyDoc("file-review"), activeVersionId: "v",
      versions: [{ id: "v", label: "V1", path: "file", addedAt: 0 }] };
    const service = createReviewSession(createPlaybackSessionController(() => null)), post = vi.fn();
    const props = { sourceKey: "file-review", playheadActive: true, fps: 24, onSeek: vi.fn(),
      sessionActive: true, sessionDoc: doc, onSessionOp: post, reviewSession: service };
    const h = render(<ReviewPanel {...props}/>);
    const composer = h.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Keep this draft" } });
    act(() => service.setProgramSource({ id: "ndi:private", ownerId: "m0", kind: "ndi", label: "Private Premiere", privatePreview: true }));
    expect(composer.closest("fieldset")?.disabled).toBe(true);
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(post).not.toHaveBeenCalled(); expect(composer.value).toBe("Keep this draft");
    h.rerender(<ReviewPanel {...props} sessionDoc={{ ...doc, comments: [buildComment({ versionId: "v", timeStart: 12, body: "Room note arrived", author: "Guest" })] }}/>);
    expect(h.getByText("Room note arrived")).toBeTruthy();
    expect(composer.value).toBe("Keep this draft");
    act(() => service.setProgramSource({ id: "ndi:room", ownerId: "m0", kind: "ndi", label: "Room Premiere", notesBlocked: "Waiting for the room picture" }));
    expect(composer.closest("fieldset")?.disabled).toBe(true);
    expect(h.getByText("Waiting for the room picture")).toBeTruthy();
  });
  it("disables file-time actions in memoized rows while a program feed is visible", () => {
    localStorage.setItem(AUTHOR_KEY, JSON.stringify("Editor"));
    const doc: ReviewDoc = { ...emptyDoc("file-review"), activeVersionId: "v",
      versions: [{ id: "v", label: "V1", path: "file", addedAt: 0 }], comments: [
        buildComment({ versionId: "v", timeStart: 12, timeEnd: 15, body: "File range", author: "Editor" }),
      ] };
    const service = createReviewSession(createPlaybackSessionController(() => null));
    const seek = vi.fn();
    const h = render(<ReviewPanel sourceKey="file-review" playheadActive fps={24} onSeek={seek}
      onMarkRange={vi.fn()} onQueueRange={vi.fn()} sessionActive sessionDoc={doc}
      onSessionOp={vi.fn()} reviewSession={service} />);
    const chip = h.container.querySelector<HTMLButtonElement>(".cp-review-tc")!;
    expect(chip.disabled).toBe(false);
    act(() => service.setProgramSource({ id: "program-1", ownerId: "m0", kind: "screen", label: "Editor" }));
    expect(chip.disabled).toBe(true);
    expect((h.getByRole("button", { name: "Mark" }) as HTMLButtonElement).disabled).toBe(true);
    expect((h.getByRole("button", { name: "Queue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(chip);
    expect(seek).not.toHaveBeenCalled();
    act(() => service.setProgramSource(null));
    expect(chip.disabled).toBe(false);
  });

  it("retains a draft across program changes and requires explicit re-anchoring", () => {
    localStorage.setItem(AUTHOR_KEY, JSON.stringify("Editor"));
    const doc: ReviewDoc = { ...emptyDoc("file-review"), activeVersionId: "v",
      versions: [{ id: "v", label: "V1", path: "file", addedAt: 0 }] };
    const service = createReviewSession(createPlaybackSessionController(() => null));
    const post = vi.fn();
    const h = render(<ReviewPanel sourceKey="file-review" playheadActive fps={24} onSeek={vi.fn()}
      sessionActive sessionDoc={doc} onSessionOp={post} reviewSession={service} />);
    const composer = h.getByRole("textbox", { name: "Comment" });
    fireEvent.change(composer, { target: { value: "A note about this picture" } });
    act(() => service.setProgramSource({ id: "program-1", ownerId: "m0", kind: "screen", label: "Editor" }));
    fireEvent.click(h.getByRole("button", { name: "Post" }));
    expect(post).not.toHaveBeenCalled();
    expect(h.getByRole("alert").textContent).toContain("monitor source changed");
    expect((composer as HTMLTextAreaElement).value).toBe("A note about this picture");
    fireEvent.click(h.getByRole("button", { name: "Use current picture for this draft" }));
    fireEvent.click(h.getByRole("button", { name: "Post" }));
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0][0].comment).toMatchObject({ timeStart: 0, timeEnd: null,
      timing: { kind: "general", sourceId: "program-1", pass: "Review pass 1" } });
    expect((composer as HTMLTextAreaElement).value).toBe("");
  });
});
