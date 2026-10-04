// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import type { TimelineWord } from "../lib/edit-model";

const created: { id: string; document: EditDocument }[] = [];
const replies: string[] = [];
const asked: { system: string; user: string }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "edit_create") { created.push({ id: args.id as string, document: args.document as EditDocument }); return {}; }
    if (cmd === "list_llm_models") return [];
    if (cmd === "has_api_key") return false;
    throw new Error(`unexpected ${cmd}`);
  }),
}));
vi.mock("../lib/string-out-model", async (original) => ({
  ...(await original<typeof import("../lib/string-out-model")>()),
  // A small local model that cannot call tools: Ask reads it the transcript as records.
  connectModel: vi.fn(async () => ({ kind: "local", server: { base_url: "http://127.0.0.1:1", api_key: "k", model_id: "llama-3.2-3b-instruct", ctx: 32000 }, name: "Llama" })),
  chat: vi.fn(async (_model: unknown, system: string, messages: { content: string }[]) => {
    asked.push({ system, user: messages[messages.length - 1].content });
    return replies.shift() ?? "{}";
  }),
}));

import { EditSidePanel } from "./EditSidePanel";

const word = (id: string, track: string, start: number): TimelineWord => ({ id, source: "s1", track, text: id, start, end: start + 0.4 });
const words = [word("moved", "rosa", 1), word("here", "rosa", 1.5), word("door", "dev", 4)];
const document: EditDocument = { schema_version: 1, title: "First", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86400,
  sources: [{ id: "s1", name: "Kitchen", document_id: "d" }],
  tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }, { id: "dev", name: "Dev", kind: "sound", source_tracks: { s1: "2" } }],
  segments: [], mutes: [], markers: [] };
const lanes = [{ id: "rosa", name: "Rosa", track: 1 }, { id: "dev", name: "Dev", track: 2 }];

function setup(onOpenEdit = vi.fn()) {
  const ws = { setMessage: vi.fn() } as unknown as Parameters<typeof EditSidePanel>[0]["ws"];
  render(<EditSidePanel editId="e1" document={document} words={words} used={new Set()} lengths={{ s1: 60 }} lanes={lanes} colors={{}} ws={ws}
    tab="ask" onTab={vi.fn()} history={null} jump={vi.fn()} pin={vi.fn()} commit={vi.fn()} tc={String} sourceName={() => "Kitchen"} nameOf={(id) => id}
    where={() => "Kitchen"} onJump={vi.fn()} onOpenEdit={onOpenEdit} onSettings={vi.fn()} appLocalModelId={null} />);
  return { onOpenEdit };
}

afterEach(cleanup);
beforeEach(() => { created.length = 0; replies.length = 0; asked.length = 0; localStorage.clear(); });

it("asks with the transcript as the prefix, and a build lands as a new string out", async () => {
  replies.push('{"answer":"Rosa talks about moving.","lines":[0],"action":{"kind":"build","title":"Rosa moves","lines":[0]}}');
  const { onOpenEdit } = setup();
  const box = screen.getByRole("combobox", { name: /Ask anything/ });
  expect((box as HTMLTextAreaElement).placeholder).toBe("Ask anything");
  fireEvent.change(box, { target: { value: "pull @Rosa moving" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await screen.findByText("Rosa talks about moving.")).toBeTruthy();
  // Only Rosa's line was sent: the @ mention narrowed what the model reads.
  expect(asked[0].system).toContain("moved here");
  expect(asked[0].system).not.toContain("door");
  fireEvent.click(screen.getByRole("button", { name: "Make new string out" }));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0].document.title).toBe("Rosa moves");
  expect(created[0].document.segments[0]).toMatchObject({ kind: "source", source: "s1" });
  fireEvent.click(await screen.findByRole("button", { name: "Open it" }));
  expect(onOpenEdit).toHaveBeenCalledWith(created[0].id);
});

it("keeps the conversation with the string out", async () => {
  replies.push('{"answer":"Two people.","lines":[],"action":null}');
  setup();
  const box = screen.getByRole("combobox", { name: /Ask anything/ });
  fireEvent.change(box, { target: { value: "who is here" } });
  await act(async () => { fireEvent.keyDown(box, { key: "Enter" }); });
  expect(await screen.findByText("Two people.")).toBeTruthy();
  cleanup();
  setup();
  expect(screen.getByText("Two people.")).toBeTruthy();
  expect(screen.getByText("who is here")).toBeTruthy();
});

it("shows a failure in the conversation rather than losing the question", async () => {
  const model = await import("../lib/string-out-model");
  vi.mocked(model.connectModel).mockRejectedValueOnce(new Error("No local AI model is installed."));
  setup();
  const box = screen.getByRole("combobox", { name: /Ask anything/ });
  fireEvent.change(box, { target: { value: "anything" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect((await screen.findByRole("alert")).textContent).toMatch(/No local AI model/);
});

it("a proposal made into a new string out stays applied though opening it unmounts this editor", async () => {
  replies.push('{"answer":"Rosa talks about moving.","lines":[0],"action":{"kind":"build","title":"Rosa moves","lines":[0]}}');
  // Opening the new string out switches tabs, which remounts the editor in the same render.
  setup(vi.fn(() => cleanup()));
  const box = screen.getByRole("combobox", { name: /Ask anything/ });
  fireEvent.change(box, { target: { value: "pull @Rosa moving" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.click(await screen.findByRole("button", { name: "Make new string out" }));
  await waitFor(() => expect(created).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole("combobox", { name: /Ask anything/ })).toBeNull());
  setup();
  expect(await screen.findByText("Rosa talks about moving.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Make new string out" })).toBeNull();
});

it("removing lines ignores overtalk from a group angle nobody hears", async () => {
  replies.push('{"answer":"That line.","lines":[0],"action":{"kind":"remove","lines":[0]}}');
  const cut: EditDocument = { ...document, segments: [{ kind: "source", id: "whole", source: "s1", in_frame: 0, out_frame: 240 }],
    tracks: [...document.tracks, { id: "ana", name: "Ana", kind: "sound", source_tracks: { s1: "branch-a" }, featured: false }] };
  const { fromDocument } = await import("../lib/edit-document");
  const changes: unknown[] = [];
  const commit = vi.fn(async (_label: string, change: (state: ReturnType<typeof fromDocument>) => unknown) => { changes.push(change(fromDocument(cut))); return true; });
  const ws = { setMessage: vi.fn() } as unknown as Parameters<typeof EditSidePanel>[0]["ws"];
  // Ana, an angle without a track, murmurs under Rosa's "moved".
  const heardAndNot = [...words, word("mm", "ana", 1.1)];
  render(<EditSidePanel editId="e2" document={cut} words={heardAndNot} used={new Set()} lengths={{ s1: 10 }} lanes={[...lanes, { id: "ana", name: "Ana", track: 0 }]} colors={{}} ws={ws}
    tab="ask" onTab={vi.fn()} history={null} jump={vi.fn()} pin={vi.fn()} commit={commit} tc={String} sourceName={() => "Kitchen"} nameOf={(id) => id}
    where={() => "Kitchen"} onJump={vi.fn()} onOpenEdit={vi.fn()} onSettings={vi.fn()} appLocalModelId={null} />);
  const box = screen.getByRole("combobox", { name: /Ask anything/ });
  fireEvent.change(box, { target: { value: "cut @Rosa moving" } });
  fireEvent.keyDown(box, { key: "Enter" });
  fireEvent.click(await screen.findByRole("button", { name: "Remove here" }));
  await waitFor(() => expect(changes).toHaveLength(1));
  const timeline = (changes[0] as { timeline: { segments: unknown[]; mutes: unknown[] } }).timeline;
  // Cut out for everyone, not silenced on Rosa's track as if Ana were talking over her.
  expect(timeline.mutes).toEqual([]);
  expect(timeline.segments.length).toBeGreaterThan(1);
});

it("reads a transcript too long for the model in parts, then answers from the lines they found", async () => {
  const models = await import("../lib/string-out-model");
  // A context this small holds one line at a time, so each line is its own part.
  vi.mocked(models.connectModel).mockResolvedValueOnce({ kind: "local", server: { base_url: "http://127.0.0.1:1", api_key: "k", model_id: "llama-3.2-3b-instruct", ctx: 40 }, name: "Llama" });
  replies.push('{"lines":[0]}', '{"lines":[]}', '{"answer":"Rosa says it.","lines":[0],"action":{"kind":"build","title":"Rosa moves","lines":"same"}}');
  setup();
  const box = screen.getByRole("combobox", { name: /Ask anything/ });
  fireEvent.change(box, { target: { value: "who talks about moving" } });
  fireEvent.keyDown(box, { key: "Enter" });
  expect(await screen.findByText("Rosa says it.")).toBeTruthy();
  expect(asked).toHaveLength(3);
  // Each part was asked which of its lines answer; the answer saw only what they found.
  expect(asked[0].user).toContain("Find every record");
  expect(asked[1].system).toContain("door");
  expect(asked[2].system).toContain("moved here");
  expect(asked[2].system).not.toContain("door");
  expect(screen.getByRole("button", { name: "Make new string out" })).toBeTruthy();
});
