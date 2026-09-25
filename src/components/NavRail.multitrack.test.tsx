// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavRail } from "./NavRail";

afterEach(cleanup);

describe("Multitrack navigation", () => {
  it("opens its own workspace and exposes the active page", () => {
    const navigate = vi.fn();
    render(<NavRail active="multitrack" onNavigate={navigate} onOpenSettings={vi.fn()} sessionActive={false} multitrackShortcut="⌘6" />);
    const button = screen.getByRole("button", { name: "AAF Audio" });
    expect(button.getAttribute("aria-current")).toBe("page");
    expect(button.title).toBe("AAF Audio (⌘6)");
    expect(screen.getByRole("button", { name: "Transcripts" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(button);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("multitrack");
  });
});
