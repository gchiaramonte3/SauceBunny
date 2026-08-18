/**
 * The one system message every local-model feature sends, byte for byte.
 *
 * WHY THIS FILE EXISTS. On this machine a feature-length transcript is ~10,000
 * tokens and llama.cpp ingests it at ~180 tok/s — 56 seconds before a single
 * token of answer comes back. That cost is payable once: llama-server keeps a
 * KV cache and reuses whatever PREFIX a new prompt shares with the last one, so
 * a second question about the same video should be nearly instant.
 *
 * It never was, because all three features built a system message shaped like
 *
 *     <task rules, different per feature>
 *     === TRANSCRIPT ===
 *     <10,000 tokens, identical>
 *
 * Prefix matching starts at token 0. The rules diverge inside the first fifty,
 * so the transcript underneath them counted as new every time: 56 seconds for
 * the summary, 56 again for chapters, 56 again for the first chat question, and
 * 56 again if you switched the summary from bullets to prose — because the
 * style string sat in that header too.
 *
 * So the expensive part goes FIRST and is identical everywhere, and everything
 * task-shaped moves into the user turn. One ingestion now serves the summary,
 * the chapters, the analysis, and every chat turn after them.
 *
 * THE RULE THIS FILE IMPOSES: nothing that varies may enter the prefix. Not the
 * summary style, not the source description, not a timestamp, not the question.
 * `prompt-prefix-contract.test.ts` fails if a caller reintroduces one, because
 * the failure is invisible — everything still works, it is just slow again, and
 * "slow again" is indistinguishable from "local models are slow".
 */

/** Rough bytes-per-token for English transcript text. */
export const CHARS_PER_TOKEN = 3.5;
/** Share of the context window the transcript may occupy. The rest is the task
 *  instruction, the chat history, and the answer. */
export const TRANSCRIPT_CTX_FRACTION = 0.65;

/** Characters of transcript that fit a given context window. */
export function transcriptBudget(ctx: number): number {
  return Math.floor(ctx * CHARS_PER_TOKEN * TRANSCRIPT_CTX_FRACTION);
}

/**
 * Fit `lines` into the budget by sampling EVENLY across the whole runtime.
 *
 * Head-truncation was what the summary used, and on anything feature-length it
 * silently answered from the first hour of a two-hour video — the model cannot
 * say a topic is missing when it was never shown the end. Even sampling keeps
 * the shape of the whole thing. Chapters already worked this way; making both
 * do it is also what lets them share a prefix at all, since two different
 * windowings of one transcript are two different prompts.
 */
export function fitTranscript(lines: string[], budget: number): { text: string; sampled: boolean } {
  const joined = lines.join("\n");
  if (joined.length <= budget) return { text: joined, sampled: false };
  if (lines.length === 0 || budget <= 0) return { text: "", sampled: true };

  // Keep every Nth line, chosen so the kept set lands just under the budget.
  const avg = Math.max(1, Math.floor(joined.length / lines.length));
  const keep = Math.max(1, Math.floor(budget / avg));
  const stride = Math.max(1, Math.ceil(lines.length / keep));
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < lines.length; i += stride) {
    const l = lines[i];
    if (used + l.length + 1 > budget) break;
    out.push(l);
    used += l.length + 1;
  }
  return { text: out.join("\n"), sampled: true };
}

/**
 * The stable system message. Same source + same context window → same bytes.
 *
 * The header is deliberately generic: it frames the material and says nothing
 * about what will be asked, because the moment it mentions the task it stops
 * being shared.
 */
export function buildSourcePrefix(lines: string[], ctx: number): { system: string; sampled: boolean } {
  const { text, sampled } = fitTranscript(lines, transcriptBudget(ctx));
  const system = [
    "You are given the transcript of a video. Answer only from it.",
    sampled
      ? "NOTE: the transcript is sampled evenly across the full runtime; some lines are omitted."
      : "",
    "",
    "=== TRANSCRIPT ===",
    text,
    "=== END TRANSCRIPT ===",
  ].filter(Boolean).join("\n");
  return { system, sampled };
}
