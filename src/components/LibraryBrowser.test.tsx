// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LibraryBrowser } from "./LibraryBrowser";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("./LibraryTree", () => ({ LibraryTree: ({ onSelectShelf }: { onSelectShelf: (s: "web" | "sessions" | null) => void }) => <nav aria-label="Library shelves">
  <button onClick={() => onSelectShelf(null)}>All files</button>
  <button onClick={() => onSelectShelf("web")}>Web shelf</button>
  <button onClick={() => onSelectShelf("sessions")}>Session shelf</button>
</nav> }));
vi.mock("./ReviewSessionsPane", () => ({ ReviewSessionsPane: () => <section aria-label="Session history" /> }));
vi.mock("./CachedWebPane", () => ({ CachedWebPane: () => <section aria-label="Cached web" /> }));
vi.mock("./LibraryBrowserPane", () => ({ LibraryBrowserPane: () => <section aria-label="Files" /> }));
vi.mock("./LibraryBrowserBar", () => ({ LibraryBrowserBar: ({ query, onQuery }: { query: string; onQuery: (q: string) => void }) => <input aria-label="Library search" value={query} onChange={(e) => onQuery(e.target.value)} /> }));

afterEach(() => { cleanup(); localStorage.clear(); });
const props: Parameters<typeof LibraryBrowser>[0] = {
  roots: ["/e2e-mock/Library"], scans: {}, scanning: false, addFolder: async () => {}, removeRoot: vi.fn(),
  onOpenWebUrl: vi.fn(), rescanAll: vi.fn(), requestThumb: async () => null,
  invalidateThumb: vi.fn(), posterVersions: {}, bumpPoster: vi.fn(), resetPoster: vi.fn(),
  selection: null, selectionTick: 0, onOpenLocalPath: vi.fn(), onOpenTranscriptHistory: vi.fn(),
};

describe("Review's Library history handoff", () => {
  it("opens session history even when no media folders have been added", () => {
    const { rerender } = render(<LibraryBrowser {...props} roots={[]} />);
    expect(screen.getByText("Add a folder to build your library.")).toBeTruthy();
    rerender(<LibraryBrowser {...props} roots={[]} sessionsRequestTick={1} />);
    expect(screen.getByRole("region", { name: "Session history" })).toBeTruthy();
  });
  it("does not redirect ordinary Library navigation without a request", () => {
    const { rerender } = render(<LibraryBrowser {...props} />);
    expect(screen.getByRole("region", { name: "Files" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Web shelf" }));
    rerender(<LibraryBrowser {...props} sessionsRequestTick={0} />);
    expect(screen.getByRole("region", { name: "Cached web" })).toBeTruthy();
  });
  it("selects session history on each new request and clears the old scoped query", () => {
    const { rerender } = render(<LibraryBrowser {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Library search" }), { target: { value: "Old filter" } });
    rerender(<LibraryBrowser {...props} sessionsRequestTick={1} />);
    expect(screen.getByRole("region", { name: "Session history" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect((screen.getByRole("textbox", { name: "Library search" }) as HTMLInputElement).value).toBe("");
    rerender(<LibraryBrowser {...props} sessionsRequestTick={1} />);
    expect(screen.getByRole("region", { name: "Files" })).toBeTruthy();
    rerender(<LibraryBrowser {...props} sessionsRequestTick={2} />);
    expect(screen.getByRole("region", { name: "Session history" })).toBeTruthy();
  });
});
