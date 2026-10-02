// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueueDrawer } from "./QueueDrawer";
import { loadActiveTab, loadTabOrder, saveActiveTab, saveTabOrder, TAB_IDS } from "../lib/tab-state";
import { createReviewSession } from "../lib/review-session";
import { createPlaybackSessionController } from "../lib/playback-session-controller";
import type { PlayerHandle } from "./player-handle";

// Exercise the actual drawer's focus, persistence and keep-alive boundaries;
// its content fixtures never invoke native jobs, read media or start capture.
vi.mock("./TranscriptViewer", () => ({ TranscriptViewer: () => <input aria-label="Transcript fixture draft"/> }));
vi.mock("./AiSummary", () => ({ AiSummary: ({ onSeek }: { onSeek: (seconds: number) => void }) => <>
  <input aria-label="AI fixture draft"/>
  <button onClick={() => onSeek(1.001)}>Seek fractional shot fixture</button>
</> }));
vi.mock("./ReviewPanel", () => ({ ReviewPanel: () => <input aria-label="Review fixture draft"/> }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));

type Props = ComponentProps<typeof QueueDrawer>;
function props(overrides: Partial<Props> = {}): Props {
  return {
    open: true, onClose: vi.fn(), queue: [], fps: 25, running: false, hasFolder: false,
    onRemove: vi.fn(), onRetry: vi.fn(), onClearAll: vi.fn(), onExportAll: vi.fn(), onStop: vi.fn(),
    transcriptPath: null, transcriptOrigin: "unknown", playheadAvailable: false,
    onTranscriptSeek: vi.fn(), transcriptArrivedTick: 0, onClearTranscript: vi.fn(),
    onLoadFromHistory: vi.fn(), onRegenerateTranscript: vi.fn(), regenerateBusy: false,
    canRegenerate: false, onImportTranscript: vi.fn(), ...overrides,
  };
}
const tabs = () => within(screen.getByRole("tablist", { name: "Right panel sections" })).getAllByRole("tab");
const tab = (name: string) => screen.getByRole("tab", { name });
function expectSelection(name: string) {
  expect(tab(name).getAttribute("aria-selected")).toBe("true");
  expect(tab(name).tabIndex).toBe(0);
  expect(tabs().filter(item => item.tabIndex === 0)).toEqual([tab(name)]);
  const panelId = tab(name).getAttribute("aria-controls")!;
  const panel = document.getElementById(panelId)!;
  expect(panel.hidden).toBe(false);
  expect(panel.getAttribute("aria-labelledby")).toBe(tab(name).id);
}
function navigate(from: string, key: string, to: string) {
  tab(from).focus();
  expect(fireEvent.keyDown(tab(from), { key })).toBe(false);
  expect(document.activeElement).toBe(tab(to));
  expectSelection(to);
}
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.classList.remove("cp-tab-dragging"); });

describe("AI source-time seeks", () => {
  it("preserves a 23.976 cut's exact PTS through the drawer, session and player controller", () => {
    const seekTo = vi.fn(async (seconds: number) => ({
      requestedSeconds: seconds, presentedSeconds: seconds, status: "presented" as const,
    }));
    const player = { seekTo, isReady: () => true, isPlaying: () => false } as unknown as PlayerHandle;
    const controller = createPlaybackSessionController(() => player);
    controller.setSource("generated-colors", 2.002);
    const session = createReviewSession(controller);
    session.setSourceIdentity("generated-colors");
    const nominalFrameSeek = vi.fn();
    saveActiveTab("ai");
    render(<QueueDrawer {...props({ fps: 24000 / 1001, reviewSession: session, onTranscriptSeek: nominalFrameSeek })}/>);
    fireEvent.click(screen.getByRole("button", { name: "Seek fractional shot fixture" }));
    // The legacy nominal-frame path rounds this down to 1.000s: still red.
    expect(seekTo).toHaveBeenCalledExactlyOnceWith(1.001);
    expect(nominalFrameSeek).not.toHaveBeenCalled();

    // A hidden file must remain protected when live/private inspection owns the monitor.
    session.setInspectionBlock("Return to room");
    fireEvent.click(screen.getByRole("button", { name: "Seek fractional shot fixture" }));
    expect(seekTo).toHaveBeenCalledOnce();
  });

  it("keeps exact-second relay callbacks working in detached panels", () => {
    const relay = vi.fn();
    saveActiveTab("ai");
    render(<QueueDrawer {...props({ embedded: true, onTranscriptSeek: relay })}/>);
    fireEvent.click(screen.getByRole("button", { name: "Seek fractional shot fixture" }));
    expect(relay).toHaveBeenCalledExactlyOnceWith(1.001);
  });
});

describe("drawer keyboard tabs", () => {
  it("has one tab stop and arrows wrap while Home/End select and focus the edges", () => {
    render(<QueueDrawer {...props()}/>);
    expectSelection("Queue");
    navigate("Queue", "ArrowRight", "Transcript");
    navigate("Transcript", "End", "Review");
    navigate("Review", "ArrowRight", "Queue");
    navigate("Queue", "ArrowLeft", "Review");
    navigate("Review", "Home", "Queue");
    expect(loadActiveTab()).toBe("queue");
  });

  it("follows persisted visual order without rewriting it and restores selection after remount", () => {
    saveTabOrder(["review", "queue", "ai", "transcript"]); saveActiveTab("ai");
    const view = render(<QueueDrawer {...props()}/>);
    expect(tabs().map(item => item.getAttribute("aria-label"))).toEqual(["Review", "Queue", "AI Summary", "Transcript"]);
    expectSelection("AI Summary");
    navigate("AI Summary", "ArrowRight", "Transcript");
    expect(loadActiveTab()).toBe("transcript");
    expect(loadTabOrder(TAB_IDS)).toEqual(["review", "queue", "ai", "transcript"]);
    view.unmount(); render(<QueueDrawer {...props()}/>);
    expectSelection("Transcript");
  });

  it("keeps Review's transient choice separate from Clip's persisted choice", () => {
    saveActiveTab("ai");
    const base = props(); const view = render(<QueueDrawer {...base} roomFace/>);
    expectSelection("Review"); navigate("Review", "Home", "Queue");
    expect(loadActiveTab()).toBe("ai");
    view.rerender(<QueueDrawer {...base} roomFace={false}/>);
    expectSelection("AI Summary");
    view.rerender(<QueueDrawer {...base} roomFace/>);
    expectSelection("Queue");
  });

  it("omits unavailable detached Review and navigates only the remaining tabs", () => {
    saveActiveTab("review"); saveTabOrder(["review", "ai", "queue", "transcript"]);
    render(<QueueDrawer {...props({ embedded: true })}/>);
    expect(screen.queryByRole("tab", { name: "Review" })).toBeNull();
    expect(screen.queryByLabelText("Review fixture draft")).toBeNull();
    expectSelection("Transcript"); navigate("Transcript", "ArrowRight", "AI Summary");
    navigate("AI Summary", "End", "Transcript");
    expect(loadActiveTab()).toBe("transcript");
    expect(screen.getByRole("button", { name: "Close panel window" })).not.toBeNull();
  });

  it("retains visited content and ignores unrelated keys without moving focus or selection", () => {
    saveActiveTab("review"); render(<QueueDrawer {...props()}/>);
    const draft = screen.getByRole("textbox", { name: "Review fixture draft" });
    fireEvent.change(draft, { target: { value: "Unsent note" } });
    navigate("Review", "ArrowLeft", "AI Summary"); navigate("AI Summary", "ArrowRight", "Review");
    expect(screen.getByRole("textbox", { name: "Review fixture draft" })).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("Unsent note");
    for (const key of ["ArrowUp", "ArrowDown", "Tab", " ", "Enter"]) {
      expect(fireEvent.keyDown(tab("Review"), { key })).toBe(true);
      expectSelection("Review");
    }
    expect(fireEvent.keyDown(tab("Review"), { key: "Home", metaKey: true })).toBe(true);
    expectSelection("Review");
  });

  it("keeps pointer drag reorder persistent and keyboard navigation follows the new order", () => {
    render(<QueueDrawer {...props()}/>);
    tabs().forEach((item, index) => vi.spyOn(item, "getBoundingClientRect").mockReturnValue({
      x: index * 100, y: 0, left: index * 100, right: (index + 1) * 100, top: 0, bottom: 30,
      width: 100, height: 30, toJSON: () => ({}),
    }));
    // jsdom lacks PointerEvent; use real bubbling events with its fields,
    // keeping the production pointer handlers and persisted write intact.
    const pointer = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 1 }, clientX: { value: x } });
      fireEvent(tab("Queue"), event);
    };
    pointer("pointerdown", 50); pointer("pointermove", 270); pointer("pointerup", 270);
    expect(loadTabOrder(TAB_IDS)).toEqual(["transcript", "ai", "queue", "review"]);
    expect(tabs().map(item => item.getAttribute("aria-label"))).toEqual(["Transcript", "AI Summary", "Queue", "Review"]);
    expectSelection("Queue"); navigate("Queue", "ArrowLeft", "AI Summary");
    expect(loadTabOrder(TAB_IDS)).toEqual(["transcript", "ai", "queue", "review"]);
  });
});
