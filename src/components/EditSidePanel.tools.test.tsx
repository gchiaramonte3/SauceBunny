// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditDocument } from "../bindings/EditDocument";
import type { TimelineWord } from "../lib/edit-model";

const created: { id: string; document: EditDocument }[] = [];
const sent: Record<string, unknown>[] = [];
const replies: string[] = [];
const cancelled: string[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "edit_create") { created.push({ id: args.id as string, document: args.document as EditDocument }); return {}; }
    if (cmd === "assistant_chat") { sent.push(args.args as Record<string, unknown>); return { text: replies.shift() ?? "{}", tools_used: ["search_transcripts"] }; }
    if (cmd === "cloud_chat_cancel") { cancelled.push(args.requestId as string); return null; }
    if (cmd === "has_api_key") return true;
    throw new Error(`unexpected ${cmd}`);
  }),
}));
vi.mock("../lib/string-out-model", async (original) => ({
  ...(await original<typeof import("../lib/string-out-model")>()),
  connectModel: vi.fn(async () => ({ kind: "cloud", provider: "anthropic", ctx: 32000, name: "Claude" })),
  chat: vi.fn(async () => { throw new Error("the tool path must not paste the transcript"); }),
}));

import { EditSidePanel } from "./EditSidePanel";
import { connectModel } from "../lib/string-out-model";
import { setCloudModel, setUltrafast } from "../lib/ai-provider";

// Rosa's line is cue r1 of AAF track 1 in document "doc", Dev's is cue d1 of track 2.
const word = (track: string, cue: string, index: number, text: string, start: number): TimelineWord =>
  ({ id: `s1:${track}:${cue}:${index}`, source: "s1", track, cue, text, start, end: start + 0.4 });
const words = [word("rosa", "r1", 0, "I", 1), word("rosa", "r1", 1, "moved", 1.5), word("dev", "d1", 0, "Door", 4)];
const document: EditDocument = { schema_version: 1, title: "Kitchen bites", edit_rate: { numerator: 24, denominator: 1 }, start_timecode_frames: 86400,
  sources: [{ id: "s1", name: "Kitchen", document_id: "doc" }],
  tracks: [{ id: "rosa", name: "Rosa", kind: "sound", source_tracks: { s1: "1" } }, { id: "dev", name: "Dev", kind: "sound", source_tracks: { s1: "2" } }],
  segments: [], mutes: [], markers: [] };
const lanes = [{ id: "rosa", name: "Rosa", track: 1 }, { id: "dev", name: "Dev", track: 2 }];
const ROSA = "saucebunny://sequence/doc/line/1/r1";

function setup() {
  const ws = { setMessage: vi.fn(), selected: [], placed: [], caret: 0, caretNow: () => 0, marks: { in: null, out: null } } as unknown as Parameters<typeof EditSidePanel>[0]["ws"];
  render(<EditSidePanel editId="e1" document={document} words={words} used={new Set()} lengths={{ s1: 60 }} lanes={lanes} colors={{}} ws={ws}
    tab="ask" onTab={vi.fn()} history={null} jump={vi.fn()} pin={vi.fn()} commit={vi.fn()} tc={String} sourceName={() => "Kitchen"} nameOf={(id) => id}
    where={() => "Kitchen"} onJump={vi.fn()} onOpenEdit={vi.fn()} onSettings={vi.fn()} appLocalModelId={null} />);
}

const ask = (text: string) => {
  const box = screen.getByRole("combobox", { name: /Ask anything/ });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
};

afterEach(cleanup);
beforeEach(() => { created.length = 0; sent.length = 0; replies.length = 0; cancelled.length = 0; localStorage.clear(); });

it("Claude looks things up with tools: told where it is, what is on screen and who was named, and never handed the transcript", async () => {
  replies.push(JSON.stringify({ answer: "Rosa moved.", lines: [ROSA], action: null }));
  setup();
  ask("where does @Rosa say she moved?");
  expect(await screen.findByText("Rosa moved.")).toBeTruthy();
  const args = sent[0];
  expect(args.provider).toBe("anthropic");
  expect(args.service_tier).toBeNull();
  expect(args.system).toContain('"Kitchen bites" (saucebunny://string-out/e1)');
  expect(args.system).toContain("saucebunny://sequence/doc");
  expect(args.system).not.toContain("moved");
  const messages = args.messages as { role: string; content: string }[];
  expect(messages[messages.length - 1].content).toContain("(The editor @-mentioned: Rosa (a person).)");
  expect((args.app_state as { string_out: { address: string } }).string_out.address).toBe("saucebunny://string-out/e1");
  // The cited address became Rosa's words here, shown as a line the editor can jump to.
  expect(screen.getByText(/I moved/)).toBeTruthy();
});

it("a build cited by address lands as a new string out of those words", async () => {
  replies.push(JSON.stringify({ answer: "One bite.", lines: [ROSA], action: { kind: "build", title: "Rosa moves", lines: [ROSA, "saucebunny://sequence/elsewhere/line/9/x"] } }));
  setup();
  ask("make a string out of Rosa moving");
  fireEvent.click(await screen.findByRole("button", { name: "Make new string out" }));
  await waitFor(() => expect(created).toHaveLength(1));
  expect(created[0].document.title).toBe("Rosa moves");
  // The address that names nothing in this string out is dropped, not guessed at.
  expect(created[0].document.segments.filter((segment) => segment.kind === "source")).toHaveLength(1);
});

it("a follow-up replays earlier citations as addresses, so they still mean the same lines", async () => {
  replies.push(JSON.stringify({ answer: "Rosa moved.", lines: [ROSA], action: null }), JSON.stringify({ answer: "Yes.", lines: [], action: null }));
  setup();
  ask("where does Rosa say she moved?");
  await screen.findByText("Rosa moved.");
  ask("is that the only time?");
  await screen.findByText("Yes.");
  const history = sent[1].messages as { role: string; content: string }[];
  expect(history.find((message) => message.role === "assistant")?.content).toContain(ROSA);
});

it("ChatGPT with Ultrafast on asks for the tier; the same question without it does not", async () => {
  const chatgpt = { kind: "cloud", provider: "openai", ctx: 32000, name: "ChatGPT" } as const;
  vi.mocked(connectModel).mockResolvedValueOnce(chatgpt).mockResolvedValueOnce(chatgpt);
  replies.push(JSON.stringify({ answer: "Fast.", lines: [], action: null }), JSON.stringify({ answer: "Standard.", lines: [], action: null }));
  // OpenAI offers the tier for gpt-6-astra; with gpt-4o it refuses the request, so the tier is not sent at all.
  setCloudModel("openai", "gpt-6-astra");
  setUltrafast(true);
  setup();
  ask("who is tired?");
  await screen.findByText("Fast.");
  setUltrafast(false);
  ask("who is tired?");
  await screen.findByText("Standard.");
  expect(sent.map((args) => [args.provider, args.service_tier])).toEqual([["openai", "ultrafast"], ["openai", null]]);
});
