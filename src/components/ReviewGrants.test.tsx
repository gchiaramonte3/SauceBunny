// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RoomAccessDialog } from "./RoomAccessDialog";
import { ReviewGrants } from "./ReviewGrants";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
let identity: string;
let revoked: boolean;
let policy: boolean;
const clipboard = vi.fn(async (_text: string) => {});
beforeEach(() => {
  identity = "SAUC-OLD"; revoked = false; policy = false;
  clipboard.mockReset(); clipboard.mockResolvedValue();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async command => {
    if (command === "review_code") return identity;
    if (command === "reset_review_identity") { identity = "SAUC-NEW"; return null; }
    if (command === "review_invited_only") return policy;
    if (command === "list_review_grants") return [
      { id: "grant", label: "Test reviewer", revoked, lastSeenAt: null },
      { id: "other", label: "Other reviewer", revoked: false, lastSeenAt: null },
    ];
    if (command === "create_review_grant") return { id: "grant", label: "Test reviewer", secret: "test-secret" };
    if (command === "revoke_review_grant") { revoked = true; return 0; }
    return null;
  });
});
afterEach(cleanup);
const props = { open: true, sessionCode: "SAUC-OLD", onClose: () => {} };
async function makeLink() {
  fireEvent.change(screen.getByRole("textbox", { name: "Who is this for" }), { target: { value: "Test reviewer" } });
  fireEvent.click(screen.getByRole("button", { name: "Make a link" }));
  await screen.findByRole("button", { name: "Copy link" });
}

it.each([false, true])("copies the live identity after reset and a new room (named=%s)", async named => {
  const { rerender } = render(<RoomAccessDialog {...props} />);
  await screen.findByRole("button", { name: "Copy open join link" });
  if (named) await makeLink();
  rerender(<RoomAccessDialog {...props} open={false} sessionCode={null} />);
  await act(async () => { await invoke("reset_review_identity"); });
  rerender(<RoomAccessDialog {...props} sessionCode="SAUC-NEW" />);
  fireEvent.click(screen.getByRole("button", { name: named ? "Copy link" : "Copy open join link" }));
  await waitFor(() => expect(clipboard).toHaveBeenCalled());
  expect(clipboard.mock.calls.at(-1)?.[0]).toContain("SAUC-NEW");
  expect(clipboard.mock.calls.at(-1)?.[0]).not.toContain("SAUC-OLD");
  if (named) expect(clipboard.mock.calls.at(-1)?.[0]).toContain("test-secret");
});

it("reads the current offline identity for each copy, without starting a room", async () => {
  render(<ReviewGrants sessionCode={null} />);
  await makeLink();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
  expect(clipboard.mock.calls[0][0]).toContain("SAUC-OLD");
  await act(async () => { await invoke("reset_review_identity"); });
  fireEvent.click(screen.getByRole("button", { name: "Copied" }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledTimes(2));
  expect(clipboard.mock.calls[1][0]).toContain("SAUC-NEW");
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "session_start")).toBe(false);
});

it("discards a pending offline identity read when a new live room replaces it", async () => {
  let resolve!: (code: string) => void;
  const { rerender } = render(<ReviewGrants sessionCode={null} />);
  await makeLink();
  vi.mocked(invoke).mockImplementationOnce(() => new Promise<string>(r => { resolve = r; }));
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  rerender(<ReviewGrants sessionCode="SAUC-NEW" />);
  await act(async () => { resolve("SAUC-OLD"); });
  expect(clipboard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(clipboard).toHaveBeenCalledOnce());
  expect(clipboard.mock.calls[0][0]).toContain("SAUC-NEW");
});

it("clears the matching one-time link and copy feedback after withdrawal", async () => {
  render(<RoomAccessDialog {...props} />);
  await makeLink();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await screen.findByRole("button", { name: "Copied" });
  fireEvent.click(screen.getByRole("button", { name: "Withdraw the link for Test reviewer" }));
  await screen.findByText("withdrawn");
  expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
});

it.each(["failed", "other"])("retains the one-time link after a %s withdrawal", async mode => {
  render(<RoomAccessDialog {...props} />);
  await makeLink();
  if (mode === "failed") vi.mocked(invoke).mockRejectedValueOnce(new Error("Withdrawal failed"));
  fireEvent.click(screen.getByRole("button", { name: `Withdraw the link for ${mode === "other" ? "Other reviewer" : "Test reviewer"}` }));
  if (mode === "failed") await screen.findByRole("alert");
  else await screen.findByText("Other reviewer's link no longer works.");
  expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
});

it("reports clipboard failure without claiming success", async () => {
  render(<RoomAccessDialog {...props} />);
  await makeLink();
  clipboard.mockRejectedValueOnce(new Error("Clipboard denied"));
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Clipboard denied");
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
});

it("does not present policy read failure as an open room", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("Invitation settings are damaged"));
  render(<RoomAccessDialog {...props} />);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Copy open join link" })).toBeNull();
  expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
});

it("ignores late copy success after the matching invitation is withdrawn", async () => {
  let finish!: () => void;
  clipboard.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  render(<RoomAccessDialog {...props} />);
  await makeLink();
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  fireEvent.click(screen.getByRole("button", { name: "Withdraw the link for Test reviewer" }));
  await screen.findByText("withdrawn");
  await act(async () => { finish(); });
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
});

it("does not treat an unexpected policy reply as public access", async () => {
  vi.mocked(invoke).mockImplementation(async command => command === "list_review_grants" ? [] : null);
  render(<RoomAccessDialog {...props} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not read the invitation policy");
  expect(screen.queryByRole("button", { name: "Copy open join link" })).toBeNull();
});
