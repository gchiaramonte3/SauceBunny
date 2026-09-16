import { beforeEach, expect, it, vi } from "vitest";
import { streamChat } from "./ai-chat";
import { parseSearchMatches, searchSections, searchTranscriptWithAi } from "./ai-transcript-search";
import { buildSourcePrefix, transcriptBudget } from "./prompt-prefix";

vi.mock("./ai-chat", () => ({ streamChat: vi.fn() }));
beforeEach(() => { vi.mocked(streamChat).mockReset(); });
const server = { base_url: "http://127.0.0.1:1234", api_key: "test", model_id: "qwen", ctx: 8192 };
it("covers every character through the last long Unicode passage without sampling or exceeding the section budget", () => {
  const passages = Array.from({ length: 180 }, (_, i) => ({ key: String(i), text: `Person ${i}: ` + "A long passage 日本語 🎥 \"\n".repeat(100) }));
  const sections = searchSections(passages, 4096), restored = passages.map(() => "");
  expect(sections.length).toBeGreaterThan(1);
  for (const section of sections) {
    expect(section.lines.length).toBeLessThanOrEqual(64);
    expect(new TextEncoder().encode(section.lines.join("\n")).length).toBeLessThanOrEqual(Math.floor(transcriptBudget(4096) / 3));
    expect(buildSourcePrefix(section.lines, 4096).sampled).toBe(false);
    for (const line of section.lines) { const row = JSON.parse(line) as { id: number; text: string }; restored[row.id] += row.text; }
  }
  expect(restored).toEqual(passages.map((passage) => passage.text));
});
it("accepts only existing integer IDs, deduplicates them, and distinguishes malformed output from no matches", () => {
  expect(parseSearchMatches('```json\n{"matches":[1,1,2]}\n```', new Set([1, 2]))).toEqual([1, 2]);
  expect(parseSearchMatches('{"matches":[]}', new Set([1]))).toEqual([]);
  for (const reply of ['{"matches":[99]}', '{"matches":["1"]}', '{"matches":[1.5]}', '[]', 'No matches', '{"matches":null}']) expect(() => parseSearchMatches(reply, new Set([1]))).toThrow();
});
it("reuses the source prefix and streaming client, returning only original keys across all sections", async () => {
  const passages = Array.from({ length: 130 }, (_, i) => ({ key: `track-${i}:cue`, text: `Person ${i}: A discussion about rain.` }));
  vi.mocked(streamChat).mockImplementation(async (_server, messages) => {
    const ids = [...messages[0].content.matchAll(/"id":(\d+)/g)].map((match) => Number(match[1]));
    return JSON.stringify({ matches: ids });
  });
  const progress = vi.fn(); const ctrl = new AbortController();
  const matches = await searchTranscriptWithAi(passages, "bad weather", server, ctrl.signal, progress);
  expect([...matches]).toEqual(passages.map((passage) => passage.key));
  expect(streamChat).toHaveBeenCalledTimes(searchSections(passages, server.ctx).length);
  expect(vi.mocked(streamChat).mock.calls[0][1][0].content).toBe(buildSourcePrefix(searchSections(passages, server.ctx)[0].lines, server.ctx).system);
  expect(vi.mocked(streamChat).mock.calls[0][1][1].content).toContain('Search query: "bad weather"');
  expect(vi.mocked(streamChat).mock.calls[0][4]).toEqual({ temperature: 0, maxTokens: 600 });
});
it("cancellation rejects a late completion before publishing results or starting another section", async () => {
  const ctrl = new AbortController(), progress = vi.fn();
  vi.mocked(streamChat).mockImplementation(async () => { ctrl.abort(); return '{"matches":[0]}'; });
  await expect(searchTranscriptWithAi(Array.from({ length: 100 }, (_, i) => ({ key: String(i), text: "Long text ".repeat(100) })), "text", server, ctrl.signal, progress)).rejects.toMatchObject({ name: "AbortError" });
  expect(progress).not.toHaveBeenCalled(); expect(streamChat).toHaveBeenCalledTimes(1);
});
