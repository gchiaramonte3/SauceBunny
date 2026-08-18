// Streaming client for the local llama-server (the AI Summary tab).
//
// llama-server (started by the Rust `start_llm_server` command) exposes an
// OpenAI-compatible `/v1/chat/completions` on 127.0.0.1, gated by a per-session
// bearer key. We stream tokens via fetch() + a ReadableStream reader — the same
// mechanism MSEStreamPlayer uses, so it works in WKWebView. No cloud, no SDK.

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export type ChatServer = { base_url: string; api_key: string };

/**
 * Ceiling when a caller does not set one. ~1,200 words, which is far more than
 * any answer here should need and still bounded: without a cap the same
 * question can cost thirty seconds or six minutes with nothing to say which.
 */
export const DEFAULT_MAX_TOKENS = 1600;

/**
 * Stream a chat completion. Calls `onToken` with each delta chunk as it
 * arrives; resolves with the full text when done. Abort via `signal`.
 */
export async function streamChat(
  server: ChatServer,
  messages: ChatMessage[],
  onToken: (delta: string) => void,
  signal: AbortSignal,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const resp = await fetch(`${server.base_url}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${server.api_key}`,
    },
    body: JSON.stringify({
      messages,
      stream: true,
      temperature: opts.temperature ?? 0.3, // low: we want grounded, factual answers
      cache_prompt: true,                    // reuse the transcript prefix across turns (fast)
      // A CEILING ON THE ANSWER. There was none, so generation ran until the
      // model chose to stop: "give me the best quotes" produced 4,989 tokens,
      // and at a 27B's ~15 tok/s that is five and a half minutes of watching
      // text arrive. The prompt was already cached by then — the wait was
      // entirely the answer's own length.
      //
      // The cap is per-caller because the right length is a property of the
      // task, not of the server. It is generous by design: it exists to stop a
      // runaway, not to trim a good answer.
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`AI server HTTP ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  /** One SSE line. `.trim()` also absorbs the \r of a CRLF stream. */
  const handleLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const payload = t.slice(5).trim();
    if (payload === "[DONE]") return;
    try {
      const json = JSON.parse(payload);
      const delta: string = json?.choices?.[0]?.delta?.content ?? "";
      if (delta) { full += delta; onToken(delta); }
    } catch { /* partial/keepalive frame — ignore */ }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank lines; each "data: <json>" line is one chunk.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line
    for (const line of lines) handleLine(line);
  }

  // Flush what the loop cannot see. Two things are held back by design and were
  // then thrown away: `buffer` keeps the trailing partial line, which is the
  // WHOLE last frame when a stream does not end with a newline, and the decoder
  // holds any incomplete multi-byte character. Dropping either silently
  // truncates the answer - the worst shape for a summary, because it reads as
  // finished. llama-server ends with "data: [DONE]\n\n" so this is empty in
  // practice today; it stops being empty the moment this points at anything else.
  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);
  return full;
}
