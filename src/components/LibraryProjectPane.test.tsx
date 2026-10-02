// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LibraryProjectPane } from "./LibraryProjectPane";
import { emptyOrganization } from "../lib/library-organization";
const ipc = vi.hoisted(() => ({ invoke: vi.fn(async (cmd: string, args?: { paths: string[] }) => {
  if (cmd === "library_reference_status") return args!.paths.map((path) => ({ path, exists: !path.includes("missing") }));
  if (cmd === "aaf_list") return [{ id: "sequence", name: "Microphones", transcribed_tracks: 1 }];
  return [];
}) }));
vi.mock("@tauri-apps/api/core", () => ipc);
afterEach(cleanup);
it("dispatches all four reference types to existing workflows and guards offline files", async () => {
  const assets = [
    { id: "file", kind: "file" as const, locator: "/picture.mov", title: "Picture" },
    { id: "web", kind: "web" as const, locator: "https://example.com/video", title: "Link" },
    { id: "text", kind: "transcript" as const, locator: "/words.srt", title: "Words" },
    { id: "multi", kind: "multitrack" as const, locator: "sequence", title: "Microphones" },
    { id: "offline", kind: "file" as const, locator: "/missing.mov", title: "Offline" },
  ];
  const local = vi.fn(), web = vi.fn(), transcript = vi.fn(), multi = vi.fn();
  render(<LibraryProjectPane data={{ ...emptyOrganization(), assets, folders: [{ id: "project", name: "Project", parentId: null, assetIds: assets.map((a) => a.id), rule: null }] }} selected="project" trees={[]} transcriptLibrary="" busy={false} treeOpen onShowTree={vi.fn()} onSelect={vi.fn()} onEdit={vi.fn()} onNew={vi.fn()} onOpenLocal={local} onOpenWeb={web} onOpenTranscript={transcript} onOpenMultitrack={multi} onDropOver={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh project items" }).hasAttribute("disabled")).toBe(false));
  for (const title of ["Picture", "Link", "Words", "Microphones", "Offline"]) fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${title}`) }));
  expect(local).toHaveBeenCalledExactlyOnceWith("/picture.mov");
  expect(web).toHaveBeenCalledExactlyOnceWith("https://example.com/video");
  expect(transcript).toHaveBeenCalledWith(expect.objectContaining({ srtPath: "/words.srt" }));
  expect(multi).toHaveBeenCalledExactlyOnceWith("sequence");
  expect(screen.getByRole("alert").textContent).toContain("Relink");
});
