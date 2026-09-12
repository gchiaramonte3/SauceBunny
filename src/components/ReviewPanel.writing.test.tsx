// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "./ReviewPanel";
import { AUTHOR_KEY, buildComment, emptyDoc, type ReviewDoc } from "../lib/review";
import { createReviewSession } from "../lib/review-session";
import { createPlaybackSessionController } from "../lib/playback-session-controller";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
beforeEach(() => localStorage.setItem(AUTHOR_KEY, JSON.stringify("Editor")));
afterEach(() => { cleanup(); localStorage.clear(); });

function document(sourceKey = "writing", versionId = "v1"): ReviewDoc {
  return { ...emptyDoc(sourceKey), activeVersionId: versionId,
    versions: [{ id: versionId, label: "V1", path: sourceKey, addedAt: 0 }],
    comments: ["First paragraph\nSecond paragraph", "Another note"].map((body, index) => ({
      ...buildComment({ versionId, timeStart: index + 1, body, author: "Editor" }, index + 1), id: `note-${index}`,
    })),
  };
}

function setup(doc = document()) {
  const post = vi.fn();
  const service = createReviewSession(createPlaybackSessionController(() => null));
  const props = { sourceKey: doc.sourceKey, playheadActive: true, fps: 24, onSeek: vi.fn(),
    sessionActive: true, sessionDoc: doc, onSessionOp: post, reviewSession: service,
    onRegisterRangeHotkeys: service.registerRangeCommands };
  const ui = render(<ReviewPanel {...props} />);
  const row = (index: number) => within(ui.container.querySelectorAll<HTMLElement>(".cp-review-comment")[index]);
  return { ...ui, post, props, service, row };
}

describe("Review writing interactions", () => {
  it("edits a multiline comment without flattening paragraphs, with explicit Save and Cancel", () => {
    const h = setup();
    fireEvent.click(h.row(0).getByRole("button", { name: "Edit" }));
    const edit = h.getByRole("textbox", { name: "Edit comment" }) as HTMLTextAreaElement;
    expect(edit.tagName).toBe("TEXTAREA");
    expect(edit.value).toBe("First paragraph\nSecond paragraph");
    fireEvent.change(edit, { target: { value: "First paragraph\nSecond paragraph edited" } });
    fireEvent.keyDown(edit, { key: "Enter", shiftKey: true });
    expect(h.post).not.toHaveBeenCalled();
    fireEvent.click(h.getByRole("button", { name: "Save" }));
    expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ t: "edit", id: "note-0", body: "First paragraph\nSecond paragraph edited" }));
    fireEvent.click(h.row(0).getByRole("button", { name: "Edit" }));
    fireEvent.change(h.getByRole("textbox", { name: "Edit comment" }), { target: { value: "Discard this change" } });
    fireEvent.click(h.getByRole("button", { name: "Cancel" }));
    expect(h.post).toHaveBeenCalledOnce();
    expect(h.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
  });

  it("uses the same paragraph-safe editor for replies and Escape cancels without an operation", () => {
    const doc = document();
    doc.comments.push(buildComment({ versionId: "v1", parentId: "note-0", timeStart: 1, body: "Reply line one\nReply line two", author: "Guest" }));
    const h = setup(doc);
    const reply = within(h.container.querySelector<HTMLElement>(".cp-review-reply")!);
    fireEvent.click(reply.getByRole("button", { name: "Edit" }));
    const edit = h.getByRole("textbox", { name: "Edit reply" }) as HTMLTextAreaElement;
    expect(edit.value).toBe("Reply line one\nReply line two");
    fireEvent.change(edit, { target: { value: "Changed\nReply" } });
    fireEvent.keyDown(edit, { key: "Escape" });
    expect(h.post).not.toHaveBeenCalled();
    fireEvent.click(reply.getByRole("button", { name: "Edit" }));
    expect((h.getByRole("textbox", { name: "Edit reply" }) as HTMLTextAreaElement).value).toBe("Reply line one\nReply line two");
    fireEvent.keyDown(h.getByRole("textbox", { name: "Edit reply" }), { key: "Enter" });
    expect(h.post).toHaveBeenCalledWith(expect.objectContaining({ t: "editReply", body: "Reply line one\nReply line two" }));
  });

  it("retains separate reply drafts across threads and Escape; Discard clears only its draft", () => {
    const h = setup();
    fireEvent.click(h.row(0).getByRole("button", { name: "Reply" }));
    fireEvent.change(h.getByRole("textbox", { name: "Reply to Editor" }), { target: { value: "Draft A\nSecond line" } });
    fireEvent.click(h.row(1).getByRole("button", { name: "Reply" }));
    fireEvent.change(h.getByRole("textbox", { name: "Reply to Editor" }), { target: { value: "Draft B" } });
    fireEvent.keyDown(h.getByRole("textbox", { name: "Reply to Editor" }), { key: "Escape" });
    fireEvent.click(h.row(0).getByRole("button", { name: "Resume reply" }));
    expect((h.getByRole("textbox", { name: "Reply to Editor" }) as HTMLTextAreaElement).value).toBe("Draft A\nSecond line");
    fireEvent.click(h.row(0).getByRole("button", { name: "Discard draft" }));
    expect(h.row(0).getByRole("button", { name: "Reply" })).toBeTruthy();
    fireEvent.click(h.row(1).getByRole("button", { name: "Resume reply" }));
    expect((h.getByRole("textbox", { name: "Reply to Editor" }) as HTMLTextAreaElement).value).toBe("Draft B");
    expect(h.post).not.toHaveBeenCalled();
  });

  it.each(["source", "version"])("isolates draft and edit state when %s changes, even with matching comment ids", kind => {
    const h = setup();
    fireEvent.click(h.row(0).getByRole("button", { name: "Reply" }));
    fireEvent.change(h.getByRole("textbox", { name: "Reply to Editor" }), { target: { value: "Draft for original" } });
    fireEvent.click(h.row(0).getByRole("button", { name: "Edit" }));
    const changed = document(kind === "source" ? "other-source" : "writing", kind === "version" ? "v2" : "v1");
    h.rerender(<ReviewPanel {...h.props} sourceKey={changed.sourceKey} sessionDoc={changed} />);
    expect(h.queryByRole("textbox", { name: "Edit comment" })).toBeNull();
    expect(h.queryByRole("textbox", { name: "Reply to Editor" })).toBeNull();
    fireEvent.click(h.row(0).getByRole("button", { name: "Reply" }));
    expect((h.getByRole("textbox", { name: "Reply to Editor" }) as HTMLTextAreaElement).value).toBe("");
    h.rerender(<ReviewPanel {...h.props} />);
    fireEvent.click(h.row(0).getByRole("button", { name: "Resume reply" }));
    expect((h.getByRole("textbox", { name: "Reply to Editor" }) as HTMLTextAreaElement).value).toBe("Draft for original");
  });

  it("retains a reply if posting fails, then clears only after successful posting", () => {
    const h = setup();
    h.post.mockImplementationOnce(() => { throw new Error("Save failed"); });
    fireEvent.click(h.row(0).getByRole("button", { name: "Reply" }));
    fireEvent.change(h.getByRole("textbox", { name: "Reply to Editor" }), { target: { value: "Keep until saved" } });
    fireEvent.click(h.row(0).getByRole("button", { name: "Post" }));
    expect((h.getByRole("textbox", { name: "Reply to Editor" }) as HTMLTextAreaElement).value).toBe("Keep until saved");
    fireEvent.click(h.row(0).getByRole("button", { name: "Post" }));
    expect(h.queryByRole("textbox", { name: "Reply to Editor" })).toBeNull();
    fireEvent.click(h.row(0).getByRole("button", { name: "Reply" }));
    expect((h.getByRole("textbox", { name: "Reply to Editor" }) as HTMLTextAreaElement).value).toBe("");
  });

  it("keeps a search while using a result or sort, clearing only on explicit dismissal", () => {
    const h = setup();
    fireEvent.click(h.getByRole("button", { name: "Search comments" }));
    const search = h.getByRole("textbox", { name: "Search comments" }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "Another" } });
    expect(h.container.querySelectorAll(".cp-review-comment")).toHaveLength(1);
    const result = h.container.querySelector<HTMLButtonElement>(".cp-review-tc")!;
    fireEvent.pointerDown(result); fireEvent.click(result);
    expect(h.props.onSeek).toHaveBeenCalledWith(2);
    const sort = h.getByRole("combobox", { name: "Sort comments" });
    fireEvent.pointerDown(sort); fireEvent.change(sort, { target: { value: "newest" } });
    expect(search.value).toBe("Another");
    expect(h.container.querySelectorAll(".cp-review-comment")).toHaveLength(1);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(h.queryByRole("textbox", { name: "Search comments" })).toBeNull();
    expect(h.container.querySelectorAll(".cp-review-comment")).toHaveLength(2);
  });

  it("keeps live source identity visible, hides optional timing and omits a nonfunctional range action", () => {
    const h = setup();
    expect(h.getByRole("button", { name: "Set comment time range" })).toBeTruthy();
    act(() => h.service.setProgramSource({ id: "application:1", ownerId: "m0", kind: "screen", label: "Composer window" }));
    expect(h.getByText("Live input · Composer window")).toBeTruthy();
    expect(h.queryByRole("button", { name: "Set comment time range" })).toBeNull();
    const timing = h.container.querySelector<HTMLDetailsElement>(".cp-review-live-timing")!;
    expect(timing.open).toBe(false);
    expect(h.container.querySelector(".cp-review-composer")).toBeTruthy();
    fireEvent.click(within(timing).getByText("Sequence and timing (optional)"));
    expect(timing.open).toBe(true);
    fireEvent.change(h.getByRole("textbox", { name: "Manual sequence timecode (optional)" }), { target: { value: "01:02:03:04" } });
    expect(timing.querySelector("summary")?.textContent).toContain("01:02:03:04");
  });

  it("registers range shortcuts only for the visible Review tab with a file playhead", () => {
    const h = setup();
    expect(h.service.rangeCommandsRef.current?.markIn).toBeTypeOf("function");
    h.rerender(<ReviewPanel {...h.props} playheadActive={false} />);
    expect(h.service.rangeCommandsRef.current).toBeNull();
    h.rerender(<ReviewPanel {...h.props} />);
    expect(h.service.rangeCommandsRef.current?.markOut).toBeTypeOf("function");
    act(() => h.service.setInspectionBlock("Private preview"));
    expect(h.service.rangeCommandsRef.current).toBeNull();
    act(() => h.service.setInspectionBlock(null));
    expect(h.service.rangeCommandsRef.current?.markIn).toBeTypeOf("function");
    act(() => h.service.setProgramSource({ id: "capture:range", ownerId: "m0", kind: "screen", label: "Composer" }));
    expect(h.service.rangeCommandsRef.current).toBeNull();
    h.unmount();
    expect(h.service.rangeCommandsRef.current).toBeNull();
  });
});
