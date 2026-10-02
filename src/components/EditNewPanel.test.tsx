// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";

const calls: { cmd: string; args: Record<string, unknown> }[] = [];
const answers: Record<string, unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd in answers) return answers[cmd];
    throw new Error(`unexpected ${cmd}`);
  }),
}));

import { EditNewPanel } from "./EditNewPanel";
import { EditPage } from "./EditPage";
import { LAST_STRING_OUT } from "../lib/last-open";

afterEach(cleanup);
beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  for (const key of Object.keys(answers)) delete answers[key];
  answers.edit_list = [];
  answers.aaf_list = [];
  answers.edit_create = {};
});

it("creates an empty string out at 23.976 from one hour and opens it", async () => {
  const onOpen = vi.fn();
  render(<EditNewPanel onOpen={onOpen} onCancel={null} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Rosa stringout" } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(onOpen).toHaveBeenCalled());
  const create = calls.find((call) => call.cmd === "edit_create")!;
  const document = create.args.document as EditDocument;
  expect(document.title).toBe("Rosa stringout");
  expect(document.edit_rate).toEqual({ numerator: 24000, denominator: 1001 });
  expect(document.start_timecode_frames).toBe(86400);
  expect(document.segments).toEqual([]);
  expect(onOpen).toHaveBeenCalledWith(create.args.id);
});

it("shows why a string out could not be created and stays open", async () => {
  delete answers.edit_create;
  const onOpen = vi.fn();
  render(<EditNewPanel onOpen={onOpen} onCancel={null} />);
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/edit_create/);
  expect(onOpen).not.toHaveBeenCalled();
});

it("welcomes a first-time user, and lists their work once there is any", async () => {
  const first = render(<EditPage active onOpenSettings={() => undefined} />);
  expect(await screen.findByRole("heading", { name: "Pull the story out, bite by bite" })).toBeTruthy();
  first.unmount();
  answers.edit_list = [{ id: "e1", title: "First pass", created_at: 1, updated_at: 2, head: 3, states: 3 }];
  render(<EditPage active onOpenSettings={() => undefined} />);
  expect(await screen.findByRole("button", { name: /First pass/ })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Pull the story out, bite by bite" })).toBeNull();
});

it("forgets a remembered string out that no longer exists instead of failing to open it", async () => {
  localStorage.setItem(LAST_STRING_OUT, "gone");
  answers.edit_list = [{ id: "e1", title: "First pass", created_at: 1, updated_at: 2, head: 3, states: 3 }];
  render(<EditPage active onOpenSettings={() => undefined} />);
  expect(await screen.findByRole("button", { name: /First pass/ })).toBeTruthy();
  expect(localStorage.getItem(LAST_STRING_OUT)).toBeNull();
});
