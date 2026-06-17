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
 * Stream a chat completion. Calls `onToken` with each delta chunk as it
 * arrives; resolves with the full text when done. Abort via `signal`.
 */
export async function streamChat(
  server: ChatServer,
  messages: ChatMessage[],
  onToken: (delta: string) => void,
  signal: AbortSignal,
  opts: { temperature?: number } = {},
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
    }),
    signal,
  });

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`AI server HTTP ${resp.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank lines; each "data: <json>" line is one chunk.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep the trailing partial line
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const delta: string = json?.choices?.[0]?.delta?.content ?? "";
        if (delta) { full += delta; onToken(delta); }
      } catch { /* partial/keepalive frame — ignore */ }
    }
  }
  return full;
}
