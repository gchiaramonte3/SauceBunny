// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenEdit } from "../lib/edit-document";
import { EditStripSilence } from "./EditStripSilence";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ track_id: "t", peaks: [] })) }));
afterEach(() => { cleanup(); localStorage.clear(); });

const open = { document: { sources: [], tracks: [] }, timeline: { segments: [], mutes: [] }, markers: [] } as unknown as OpenEdit;
const base = { open, documents: new Map(), words: [], commit: vi.fn(async () => true), nameOf: (id: string) => id, scope: "A1 Rosa · the whole string out",
  request: { from: 0, to: 10, lanes: ["rosa"], sourceLanes: { s: ["rosa"] } } };

it("says why it cannot run until the mics are measured, and Escape closes it", () => {
  const onClose = vi.fn();
  render(<EditStripSilence {...base} hint="Turn on View ▸ Waveforms to measure each mic first" onDone={vi.fn()} onClose={onClose} />);
  expect(screen.getByRole("note").textContent).toBe("Turn on View ▸ Waveforms to measure each mic first");
  expect((screen.getByRole("button", { name: "Strip" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog", { name: "Strip Silence" }), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it("shows Avid's four settings in their units and remembers what was used", async () => {
  const onDone = vi.fn();
  render(<EditStripSilence {...base} onDone={onDone} onClose={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Threshold (dB)"), { target: { value: "-50" } });
  fireEvent.change(screen.getByLabelText("Pad end (ms)"), { target: { value: "300" } });
  fireEvent.click(screen.getByRole("button", { name: "Strip" }));
  await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(JSON.parse(localStorage.getItem("saucebunny.stringOuts.stripSilence")!)).toMatchObject({ thresholdDb: -50, padEnd: 0.3 });
  cleanup();
  render(<EditStripSilence {...base} onDone={vi.fn()} onClose={vi.fn()} />);
  expect((screen.getByLabelText("Threshold (dB)") as HTMLInputElement).value).toBe("-50");
});
