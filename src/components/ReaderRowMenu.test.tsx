// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReaderRowMenu } from "./ReaderRowMenu";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "/lib/New") }));
afterEach(cleanup);

const entry = { srtPath: "/lib/Talk.srt" } as never;

function open(onRename = vi.fn(async () => {})) {
  render(
    <ReaderRowMenu
      target={{ entry, title: "Talk", x: 10, y: 10 }}
      onClose={() => {}}
      folderOptions={[{ label: "Library root", dir: "/lib" }]}
      libraryPath="/lib"
      onRename={onRename}
      onMove={vi.fn(async () => {})}
    />,
  );
  return onRename;
}

describe("the transcript reader's row menu", () => {
  it("offers Rename, and opens its dialog", () => {
    open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Talk");
  });

  it("renames with the typed name", async () => {
    const onRename = open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Ada interview" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith(entry, "Ada interview"));
  });

  it("surfaces a backend refusal instead of closing silently", async () => {
    // A rename that fails must SAY so. Closing on failure is how "I can't
    // rename" happens with nothing on screen to explain it.
    const onRename = vi.fn(async () => { throw new Error("A file named that already exists."); });
    open(onRename as never);
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy());
  });

  it("renders into a portal, like every other menu in the app", () => {
    // CueSelectionMenu and LibraryCardMenu both portal to <body>. This one did
    // not, so it drew inside the reader's own stacking context at z-index 401
    // while the app stacks layers up to 10002 — a menu that is present in the
    // DOM, and underneath something.
    // Rendered INSIDE a reader-shaped host on purpose. RTL mounts into its own
    // div on <body>, so a naive "parent is body" check passes whether or not
    // the component portals - it was a false pass the first time I wrote it.
    // Escaping a host that is not body is the thing that actually distinguishes
    // the two.
    const host = document.createElement("div");
    host.className = "cp-view-reader";
    document.body.appendChild(host);
    render(
      <ReaderRowMenu
        target={{ entry, title: "Talk", x: 10, y: 10 }}
        onClose={() => {}}
        folderOptions={[{ label: "Library root", dir: "/lib" }]}
        libraryPath="/lib"
        onRename={vi.fn(async () => {})}
        onMove={vi.fn(async () => {})}
      />,
      { container: host },
    );
    const menu = screen.getByRole("menu");
    expect(menu.closest(".cp-view-reader"), "still inside the reader's stacking context").toBeNull();
  });
});
