// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantAccess } from "./AssistantAccess";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const setup = { command: "/Applications/Sauce Bunny.app/Contents/MacOS/sauce-bunny",
  claude_code: "claude mcp add sauce-bunny -- '/Applications/Sauce Bunny.app/Contents/MacOS/sauce-bunny' --mcp", desktop_config: "{}" };

it("shows the Claude Code command, copies it, and says where what Claude reads goes", async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "mcp_setup" ? setup : undefined);
  const writeText = vi.fn(async () => undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  render(<AssistantAccess />);
  const field = await screen.findByDisplayValue(setup.claude_code);
  expect(field.getAttribute("readonly")).not.toBeNull();
  expect(screen.getByText(/Claude sends it to Anthropic/)).toBeTruthy();
  fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[0]);
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(setup.claude_code));
  expect((await screen.findByRole("status")).textContent).toContain("Copied the Claude Code command.");
});

it("saves the Claude Desktop extension where the editor chooses", async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "mcp_setup" ? setup : "/Users/me/Desktop/Sauce Bunny.mcpb");
  mocks.save.mockResolvedValue("/Users/me/Desktop/Sauce Bunny.mcpb");
  render(<AssistantAccess />);
  fireEvent.click(await screen.findByRole("button", { name: "Save extension…" }));
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("mcp_save_extension", { path: "/Users/me/Desktop/Sauce Bunny.mcpb" }));
  expect((await screen.findByRole("status")).textContent).toContain("Open it to install Sauce Bunny in Claude Desktop.");
});
