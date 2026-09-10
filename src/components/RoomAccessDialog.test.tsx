// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { RoomAccessDialog } from "./RoomAccessDialog";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "review_code") return "SAUC-HOST";
    if (command === "list_review_grants") return [];
    if (command === "review_invited_only") return true;
    if (command === "create_review_grant") return { label: "Test reviewer", secret: "fixture-secret" };
    if (command === "set_review_invited_only") throw new Error("Policy write failed");
    return null;
  });
});
afterEach(cleanup);

it("is reachable outside a hidden setup rail and retains its one-time invitation across close and room changes", async () => {
  const props = { open: false, sessionCode: "SAUC-HOST", onClose: vi.fn() };
  const { rerender } = render(<div hidden><RoomAccessDialog {...props} /></div>);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  expect(document.querySelector('.cp-modal')).toBeNull();
  rerender(<div hidden><RoomAccessDialog {...props} open /></div>);
  expect(screen.getByRole("dialog", { name: "Invite reviewers" })).toBeTruthy();
  await waitFor(() => expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true));
  expect(screen.queryByRole("button", { name: "Copy open join link" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Who is this for" }), { target: { value: "Test reviewer" } });
  fireEvent.click(screen.getByRole("button", { name: "Make a link" }));
  await screen.findByRole("button", { name: "Copy link" });
  const panel = document.querySelector(".cp-grants");
  for (const sessionCode of ["SAUC-HOST", null, "SAUC-NEXT"]) {
    rerender(<div hidden><RoomAccessDialog {...props} sessionCode={sessionCode} /></div>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".cp-grants")).toBe(panel);
  }
  rerender(<div hidden><RoomAccessDialog {...props} open /></div>);
  expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "create_review_grant")).toHaveLength(1);
  expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "review_code")).toHaveLength(1);
  expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "set_review_invited_only")).toBe(false);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(props.onClose).toHaveBeenCalledOnce();
});

it("keeps the confirmed invitation-only policy after a failed change", async () => {
  render(<RoomAccessDialog open sessionCode="SAUC-HOST" onClose={() => {}} />);
  const toggle = screen.getByRole("checkbox") as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  await screen.findByText("Policy write failed");
  expect(toggle.checked).toBe(true);
  expect(screen.queryByRole("button", { name: "Copy open join link" })).toBeNull();
});
