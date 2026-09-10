/** Bounded diagnostics without signed source URLs, local paths or credentials. */
export function mediaDiagnostic(message: string): string {
  return message.split(/\r?\n/).map((line) => /cookie:|authorization:/i.test(line) ? "[credentials redacted]"
    : line.replace(/https?:\/\/\S+/gi, "[source]").replace(/\/(?:Users|private)\/\S+/g, "[local file]")).join(" · ").slice(0, 1200);
}
