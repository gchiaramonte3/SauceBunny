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

import { EditPicker } from "./EditPicker";

afterEach(cleanup);
beforeEach(() => {
  calls.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
  answers.edit_list = [{ id: "e1", title: "First pass", created_at: 1, updated_at: 2, head: 3, states: 3 }];
  answers.aaf_list = [];
  answers.edit_create = {};
});

it("lists edits and opens one", async () => {
  const onOpen = vi.fn();
  render(<EditPicker onOpen={onOpen} />);
  fireEvent.click(await screen.findByRole("button", { name: /First pass/ }));
  expect(onOpen).toHaveBeenCalledWith("e1");
  expect(screen.getByText(/2 changes/)).toBeTruthy();
});

it("creates an empty edit at 23.976 from one hour and opens it", async () => {
  const onOpen = vi.fn();
  render(<EditPicker onOpen={onOpen} />);
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Rosa stringout" } });
  fireEvent.click(screen.getByRole("button", { name: "New edit" }));
  await waitFor(() => expect(onOpen).toHaveBeenCalled());
  const create = calls.find((call) => call.cmd === "edit_create")!;
  const document = create.args.document as EditDocument;
  expect(document.title).toBe("Rosa stringout");
  expect(document.edit_rate).toEqual({ numerator: 24000, denominator: 1001 });
  expect(document.start_timecode_frames).toBe(Math.round(3600 * 24000 / 1001));
  expect(document.segments).toEqual([]);
  expect(onOpen).toHaveBeenCalledWith(create.args.id);
});

it("shows why an edit could not be created and stays on the list", async () => {
  delete answers.edit_create;
  const onOpen = vi.fn();
  render(<EditPicker onOpen={onOpen} />);
  fireEvent.click(await screen.findByRole("button", { name: "New edit" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/edit_create/);
  expect(onOpen).not.toHaveBeenCalled();
});
