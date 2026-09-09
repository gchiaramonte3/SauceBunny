// @vitest-environment jsdom
import { Profiler } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewPanel } from "./ReviewPanel";
import { buildComment, emptyDoc, AUTHOR_KEY, type ReviewDoc } from "../lib/review";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn(async () => {}) }));
afterEach(cleanup);

// Opt-in React/DOM interaction profile, not a native video or layout benchmark.
// SAUCE_REVIEW_PROFILE=1 npx vitest run src/components/ReviewPanel.performance.test.tsx --maxWorkers=1
describe.runIf(process.env.SAUCE_REVIEW_PROFILE === "1")("review interaction profile", () => {
  it.each([1000, 10000])("profiles %i comments without rerendering the list while composing", (count) => {
    localStorage.setItem(AUTHOR_KEY, JSON.stringify("Editor"));
    const doc: ReviewDoc = { ...emptyDoc("profile"), activeVersionId: "v",
      versions: [{ id: "v", label: "V1", path: "profile", addedAt: 0 }],
      comments: Array.from({ length: count }, (_, i) => buildComment({
        versionId: "v", timeStart: i / 24, body: `Note ${i}`, author: "Editor",
      }, i + 1)),
    };
    const measurements: Array<{ phase: string; duration: number }> = [];
    const onSessionOp = vi.fn();
    const h = render(<Profiler id="review" onRender={(_id, phase, duration) => measurements.push({ phase, duration })}>
      <ReviewPanel sourceKey="profile" playheadActive={false} fps={24} onSeek={vi.fn()}
        sessionActive sessionDoc={doc} onSessionOp={onSessionOp} />
    </Profiler>);
    expect(h.container.querySelectorAll(".cp-review-comment")).toHaveLength(count);
    measurements.length = 0;
    const composer = h.getByRole("textbox", { name: "Comment" });
    const started = performance.now();
    fireEvent.change(composer, { target: { value: "A new note" } });
    const elapsed = performance.now() - started;
    expect(h.container.querySelectorAll(".cp-review-comment")).toHaveLength(count);
    console.info(JSON.stringify({ profile: "review-composer", comments: count, elapsedMs: elapsed,
      reactRenderMs: measurements.reduce((total, m) => total + m.duration, 0) }));
    // Updating the composer must not accidentally dispatch review operations.
    expect(onSessionOp).not.toHaveBeenCalled();
  }, 60000);
});
