import { afterEach, describe, expect, it, vi } from "vitest";
import { streamChat } from "./ai-chat";

/**
 * The SSE reader behind the AI Summary tab.
 *
 * Everything interesting here is buffering, and buffering bugs in a token
 * stream are invisible in the worst way: the answer just stops, and a truncated
 * summary reads exactly like a finished one. So the tests are mostly about
 * chunk boundaries falling in hostile places — mid-JSON, mid-line, mid-emoji.
 *
 * `fetch` is stubbed to a byte stream and nothing else is. The assertions are
 * about what text comes out of a given sequence of bytes, which is this
 * module's entire job.
 */

const enc = new TextEncoder();

/** A response whose body yields exactly these byte chunks, in order. */
function streamOf(chunks: Array<string | Uint8Array>, init: { ok?: boolean; status?: number } = {}) {
  let i = 0;
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    text: async () => "server said no",
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          const c = chunks[i++];
          return { done: false, value: typeof c === "string" ? enc.encode(c) : c };
        },
        cancel: async () => {},
      }),
    },
  };
}

function install(resp: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return resp;
  });
  return calls;
}

const SERVER = { base_url: "http://127.0.0.1:8080", api_key: "k-123" };
const MSGS = [{ role: "user" as const, content: "hi" }];
const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

afterEach(() => vi.unstubAllGlobals());

async function collect(chunks: Array<string | Uint8Array>) {
  install(streamOf(chunks));
  const tokens: string[] = [];
  const full = await streamChat(SERVER, MSGS, (t) => tokens.push(t), new AbortController().signal);
  return { full, tokens };
}

describe("the ordinary stream", () => {
  it("assembles tokens in order and returns the whole text", async () => {
    // The canary: every boundary case below is meaningless if the simple case
    // does not work.
    const { full, tokens } = await collect([frame("Hello"), frame(" there"), "data: [DONE]\n\n"]);
    expect(full).toBe("Hello there");
    expect(tokens).toEqual(["Hello", " there"]);
  });

  it("ignores the [DONE] sentinel rather than appending it", async () => {
    const { full } = await collect([frame("done"), "data: [DONE]\n\n"]);
    expect(full).toBe("done");
  });

  it("ignores keepalive comments and blank lines", async () => {
    // llama-server and proxies both emit these; a naive parser turns them into
    // tokens or throws.
    const { full } = await collect([": keepalive\n\n", "\n", frame("x"), "\n\n"]);
    expect(full).toBe("x");
  });

  it("survives a malformed JSON frame without losing the stream", async () => {
    // One bad frame must not abort the answer — the catch is there for partial
    // and keepalive frames, and this proves it does not swallow the rest.
    const { full } = await collect([frame("a"), "data: {not json\n\n", frame("b")]);
    expect(full).toBe("ab");
  });

  it("tolerates CRLF line endings", async () => {
    // SSE permits CRLF. The \r is absorbed by trim(); without that, every
    // payload would end in a stray carriage return and JSON.parse would fail.
    const f = (t: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\r\n\r\n`;
    const { full } = await collect([f("crlf"), "data: [DONE]\r\n\r\n"]);
    expect(full).toBe("crlf");
  });
});

describe("chunk boundaries in hostile places", () => {
  it("reassembles a frame split MID-JSON across two reads", async () => {
    // The classic SSE bug. The buffer must hold the partial line rather than
    // handing half an object to JSON.parse and dropping the token.
    const whole = frame("split me");
    const at = Math.floor(whole.length / 2);
    const { full } = await collect([whole.slice(0, at), whole.slice(at)]);
    expect(full).toBe("split me");
  });

  it("reassembles a frame split one byte at a time", async () => {
    // The pathological version: every chunk is a single character, so the
    // buffer is exercised at every possible boundary at once.
    const whole = frame("drip");
    const { full } = await collect([...whole]);
    expect(full).toBe("drip");
  });

  it("reassembles a frame split right after 'data:'", async () => {
    const whole = frame("edge");
    const at = whole.indexOf(":") + 1;
    const { full } = await collect([whole.slice(0, at), whole.slice(at)]);
    expect(full).toBe("edge");
  });

  it("keeps a multi-byte character split across reads intact", async () => {
    // The decoder's `{ stream: true }` earns its keep here: an emoji is four
    // UTF-8 bytes, and splitting them without a streaming decoder yields
    // replacement characters instead. Real for any non-ASCII summary.
    const bytes = enc.encode(frame("hi 🎬 there"));
    const cut = bytes.indexOf(0xf0) + 2;   // mid-emoji
    const { full } = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(full).toBe("hi 🎬 there");
    expect(full).not.toContain("�");
  });
});

describe("the end of the stream", () => {
  it("does NOT drop a final frame that lacks a trailing newline", async () => {
    // The bug. `buffer` holds the trailing partial line by design, and the loop
    // used to break on `done` and discard it — so a stream ending without a
    // newline lost its last token, and the answer read as complete.
    const noNewline = `data: ${JSON.stringify({ choices: [{ delta: { content: "last word" } }] })}`;
    const { full, tokens } = await collect([frame("first "), noNewline]);
    expect(full, "the final frame was discarded").toBe("first last word");
    expect(tokens).toEqual(["first ", "last word"]);
  });

  it("does not drop a trailing multi-byte character at the very end", async () => {
    // Same flush, other half: the decoder holds an incomplete sequence, and
    // calling decode() with no argument is what releases it.
    const payload = `data: ${JSON.stringify({ choices: [{ delta: { content: "café 🎬" } }] })}`;
    const bytes = enc.encode(payload);
    const cut = bytes.length - 2;
    const { full } = await collect([bytes.slice(0, cut), bytes.slice(cut)]);
    expect(full).toBe("café 🎬");
  });

  it("returns an empty string for a stream that says nothing", async () => {
    const { full, tokens } = await collect([]);
    expect(full).toBe("");
    expect(tokens).toEqual([]);
  });

  it("does not emit a token for an empty delta", async () => {
    // Providers send role-only and finish_reason frames with content "". Those
    // must not fire onToken, or the UI flickers a cursor for nothing.
    const { full, tokens } = await collect([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      frame(""),
      frame("real"),
    ]);
    expect(full).toBe("real");
    expect(tokens).toEqual(["real"]);
  });
});

describe("the request and its failures", () => {
  it("sends the bearer key and asks for a stream", async () => {
    const calls = install(streamOf([frame("x")]));
    await streamChat(SERVER, MSGS, () => {}, new AbortController().signal);
    expect(calls[0].url).toBe("http://127.0.0.1:8080/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k-123");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual(MSGS);
  });

  it("defaults to a low temperature, and lets a caller override it", async () => {
    // Low on purpose: the module's own comment says grounded and factual. A
    // silent change here changes every summary in the app.
    let calls = install(streamOf([frame("x")]));
    await streamChat(SERVER, MSGS, () => {}, new AbortController().signal);
    expect(JSON.parse(calls[0].init.body as string).temperature).toBe(0.3);

    calls = install(streamOf([frame("x")]));
    await streamChat(SERVER, MSGS, () => {}, new AbortController().signal, { temperature: 0 });
    expect(JSON.parse(calls[0].init.body as string).temperature).toBe(0);
  });

  it("throws with the status and the server's own words on a bad response", async () => {
    // The user needs to see why. A bare "request failed" sends them to the
    // wrong place — usually the model picker rather than the server log.
    install(streamOf([], { ok: false, status: 503 }));
    await expect(streamChat(SERVER, MSGS, () => {}, new AbortController().signal))
      .rejects.toThrow(/HTTP 503.*server said no/);
  });

  it("throws rather than hanging when the response has no body", async () => {
    install({ ok: true, status: 200, body: null, text: async () => "" });
    await expect(streamChat(SERVER, MSGS, () => {}, new AbortController().signal))
      .rejects.toThrow(/HTTP 200/);
  });
});
