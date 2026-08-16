// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

/**
 * The export CTA, which had a state where it went silently dead.
 *
 * Three conditions disable the queue button, and until now only one of them
 * changed the label. The invisible one was `status === "exporting"`: a single
 * clip export was already running, holding the shared local-export cancel
 * token, so the queue had to wait. Nothing said so. That branch REPLACES the
 * single export's own button (the queue is the source of truth once it has
 * items), and `exporting` also suppresses the "No output folder set" nudge
 * below, so the entire panel went quiet — leaving a full-strength primary
 * button reading "Export 3 clips" that did nothing at all when clicked.
 *
 * It is reachable the ordinary way: start one export, add clips to the queue
 * while it runs.
 *
 * This is the app's most important button and it had no test of any kind,
 * which is why the prop factory below is worth its length.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

type Props = Parameters<typeof Sidebar>[0];

function base(over: Partial<Props> = {}): Props {
  const noop = vi.fn();
  return {
    status: "loaded",
    // Every field the component actually reads. A partial stub here does not
    // fail as a missing prop; it throws inside the render (`webpage_url` is
    // non-optional in Rust and read unguarded) and surfaces as an unrelated
    // assertion, which is exactly how an hour went missing on another test.
    metadata: {
      title: "A film", duration: 120, thumbnail: null, uploader: null,
      upload_date: null, view_count: null, webpage_url: "https://example.com/w",
      width: 1920, height: 1080, fps: 25, vcodec: "h264", acodec: "aac",
      ext: "mp4", has_subs: false,
    },
    metadataLoading: false,
    exportOpts: { folder: "/Users/x/Movies", filename: "cut", format: "video", inTc: "", outTc: "", reencode: false },
    setExportOpts: noop,
    exportPhase: "idle",
    onExport: noop, onExportResolved: noop, onReveal: noop,
    queueCount: 0, queueRunning: false, onExportQueue: noop, onAddToQueue: noop,
    recents: [], onPickRecent: noop, onClearRecents: noop,
    reviewStatus: null,
    captionsState: "idle", captionsError: null, onDownloadCaptions: noop,
    onGenerateTranscript: noop, transcriptState: "idle", transcriptResolution: null,
    onTranscriptResolved: noop, transcriptError: null, transcriptProgress: 0, transcriptPhase: null,
    whisperModelReady: true, whisperModelLabel: "small",
    onOpenTranscriptionSettings: noop, onOpenGeneralSettings: noop,
    detectSpeakers: false, setDetectSpeakers: noop, diarizerReady: true,
    expectedSpeakers: 2, setExpectedSpeakers: noop,
    onLog: noop, fps: 25, durationTc: "00:02:00:00",
    ...over,
  } as unknown as Props;
}

const queueBtn = () => screen.getByRole("button",
  { name: /Export \d+ clip|Waiting for the current|Exporting…/ }) as HTMLButtonElement;

afterEach(cleanup);

describe("the queue export button", () => {
  it("offers the queue by name when nothing is in the way", () => {
    // The canary: if the button stops rendering, every assertion below would
    // pass vacuously on a query that found nothing.
    render(<Sidebar {...base({ queueCount: 3 })} />);
    const b = queueBtn();
    expect(b.textContent).toContain("Export 3 clips");
    expect(b.disabled).toBe(false);
  });

  it("says a single export is in the way, instead of going quiet", () => {
    // The defect. Disabled is correct; disabled AND still claiming to be an
    // export button is what left the user clicking a dead control.
    render(<Sidebar {...base({ queueCount: 3, status: "exporting" })} />);
    const b = queueBtn();
    expect(b.disabled).toBe(true);
    expect(b.textContent).toContain("Waiting for the current export");
    expect(b.getAttribute("title")).toContain("single clip export is running");
  });

  it("still reports its own run as Exporting…", () => {
    // The one reason that was always visible. Kept so the fix cannot swallow
    // it: queueRunning wins over exporting, because it is the more specific
    // statement about what this button is doing.
    render(<Sidebar {...base({ queueCount: 3, queueRunning: true, status: "exporting" })} />);
    expect(queueBtn().textContent).toContain("Exporting…");
  });

  it("leaves the missing-folder case to the nudge, which is on screen", () => {
    // Not every disabled state needs the label. This one already has a
    // visible sentence with a deep link into Settings, so the button stays
    // named and the explanation lives where it can be acted on.
    render(<Sidebar {...base({ queueCount: 3, exportOpts: { ...base().exportOpts, folder: null } })} />);
    expect(queueBtn().disabled).toBe(true);
    expect(screen.getByText(/No output folder set/)).toBeTruthy();
  });

  it("singularises one clip", () => {
    render(<Sidebar {...base({ queueCount: 1 })} />);
    expect(queueBtn().textContent).toContain("Export 1 clip");
  });
});
