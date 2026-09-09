// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Monitor } from "./Monitor";

vi.mock("./LocalMediaPlayer", () => ({ LocalMediaPlayer: () => <video data-testid="file-player" autoPlay src="/published.mp4"/> }));
vi.mock("./MediaBunnyPlayer", () => ({ MediaBunnyPlayer: () => null }));
vi.mock("./MSEStreamPlayer", () => ({ MSEStreamPlayer: () => null }));
vi.mock("./ProxyPresentationPlayer", () => ({ ProxyPresentationPlayer: () => null }));
vi.mock("./CaptionOverlay", () => ({ CaptionOverlay: () => null }));
vi.mock("./AnnotationOverlay", () => ({ AnnotationOverlay: () => null }));
const base = { status: "empty" as const, metadata: null, errorDetail: null, aspect: "off" as const,
  sourceKind: "file" as const, localFilePath: null, initialVolume: 1, toast: null, onToastDismiss: () => {}, fps: 24 };
beforeEach(() => vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("removes covered file actions from accessibility without hiding program controls", () => {
  const props = { ...base, resumeTitle: "Saved edit", onResume: vi.fn(), stageOverlay: <button>Program audio</button> };
  const h = render(<Monitor {...props}/>);
  expect(screen.getByRole("button", { name: "Resume Saved edit" })).toBeTruthy();
  h.rerender(<Monitor {...props} pictureCovered/>);
  expect(screen.queryByRole("button", { name: "Resume Saved edit" })).toBeNull();
  expect(h.container.querySelector(".cp-empty")?.hasAttribute("inert")).toBe(true);
  expect(screen.getByRole("button", { name: "Program audio" }).closest("[inert]")).toBeNull();
  h.rerender(<Monitor {...props}/>);
  expect(screen.getByRole("button", { name: "Resume Saved edit" })).toBeTruthy();
  expect(h.container.querySelector(".cp-empty")?.hasAttribute("inert")).toBe(false);
});

it("keeps the same published file player mounted when a private picture covers it", () => {
  const props = { ...base, status: "loaded" as const, localFilePath: "/published.mp4" };
  const h = render(<Monitor {...props}/>), player = screen.getByTestId("file-player");
  h.rerender(<Monitor {...props} pictureCovered stageOverlay={<button>Program audio</button>}/>);
  expect(screen.getByTestId("file-player")).toBe(player);
  expect(player.getAttribute("src")).toBe("/published.mp4");
  expect(player.closest("[inert]")).not.toBeNull();
  expect(player.closest("[hidden]")).toBeNull();
  h.rerender(<Monitor {...props}/>);
  expect(screen.getByTestId("file-player")).toBe(player);
  expect(player.closest("[inert]")).toBeNull();
});
