// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SavedReviewSession } from "./SavedReviewSession";
import { newScreening, openSegment, noteComment, type ScreeningDoc } from "../lib/screening";
import { buildComment, emptyDoc, type ReviewDoc } from "../lib/review";
const h = vi.hoisted(() => ({ record: null as ScreeningDoc | null, docs: [] as ReviewDoc[] }));
vi.mock("../lib/screening-store", () => ({ loadScreening: async () => h.record }));
vi.mock("../lib/review-store", () => ({
  allReviewDocs: () => h.docs, getReviewDoc: (key: string) => h.docs.find(d => d.sourceKey === key),
  subscribeReviewDoc: () => () => {},
}));
beforeEach(() => { cleanup(); h.record = null; h.docs = []; });
function seed(kind: "ndi" | "file" = "ndi") {
  const key = kind === "ndi" ? "ndi:pass" : "/cut.mov";
  const c = { ...buildComment({ versionId: "v1", author: "Ada", body: "Fix this ending", timeStart: 12 }),
    ...(kind === "ndi" ? { timing: { kind: "manual" as const, sourceId: key, pass: "Pass 1", timecode: "01:02:03:04" } } : {}) };
  h.record = noteComment(openSegment(newScreening("s1", "Friday", "host"), {
    kind, url: null, fingerprint: null, title: "Adobe Premiere Pro", duration: null, reviewKey: key,
  }, key), c.id);
  h.docs = [{ ...emptyDoc(key), comments: [c] }];
}
it("shows live notes without video or a Premiere connection, with honest timing", async () => {
  seed(); const open = vi.fn(); render(<SavedReviewSession id="s1" onBack={() => {}} onOpenMedia={open} />);
  expect(await screen.findByText("Fix this ending")).toBeTruthy();
  expect(screen.getByText(/Premiere is not required to read them/)).toBeTruthy();
  expect(screen.getByText(/Manual 01:02:03:04 · Unverified/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open source in Clip" })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});
it("keeps media opening explicit", async () => {
  seed("file"); const open = vi.fn(); render(<SavedReviewSession id="s1" onBack={() => {}} onOpenMedia={open} />);
  expect(await screen.findByText("Fix this ending")).toBeTruthy(); expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open source in Clip" })); expect(open).toHaveBeenCalledWith("/cut.mov");
});
it("reports unavailable records and retries", async () => {
  render(<SavedReviewSession id="s1" onBack={() => {}} onOpenMedia={() => {}} />);
  expect(await screen.findByText("Session unavailable")).toBeTruthy();
  seed(); fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Fix this ending")).toBeTruthy();
});
it("keeps the missing-review warning distinct from an empty session", async () => {
  seed(); h.docs = []; render(<SavedReviewSession id="s1" onBack={() => {}} onOpenMedia={() => {}} />);
  expect(await screen.findByText(/review document is unavailable on this Mac/)).toBeTruthy();
});

it("switches sources without mixing their notes", async () => {
  seed();
  const first = h.record!;
  h.record = { ...first, segments: [...first.segments, { ...first.segments[0], id: "seg2", title: "Second source", localSourceKey: "ndi:second", commentIds: ["second-note"] }] };
  h.docs.push({ ...emptyDoc("ndi:second"), comments: [{ ...h.docs[0].comments[0], id: "second-note", body: "Second source note" }] });
  render(<SavedReviewSession id="s1" onBack={() => {}} onOpenMedia={() => {}} />);
  expect(await screen.findByText("Fix this ending")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Source reviewed" }), { target: { value: "1" } });
  expect(await screen.findByText("Second source note")).toBeTruthy();
  expect(screen.queryByText("Fix this ending")).toBeNull();
});
