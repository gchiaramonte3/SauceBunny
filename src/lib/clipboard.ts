/**
 * Write text to the clipboard from a click, even when the text is still being
 * worked out. WebKit allows a clipboard write only within the click that asked
 * for it, and an `await` before `writeText` (building a report, asking Rust
 * for a code) ends that window: the write is refused with "The request is not
 * allowed by the user agent or the platform in the current context". Chromium
 * keeps the window open across awaits, so the Playwright suite never saw it.
 *
 * So the write starts synchronously, in the click, with a ClipboardItem whose
 * content is the promise. Call this before any `await` in the handler. A
 * promise that rejects writes nothing.
 */
export function copyText(text: string | Promise<string>): Promise<void> {
  if (typeof text === "string") return navigator.clipboard.writeText(text);
  if (typeof ClipboardItem !== "undefined" && typeof navigator.clipboard.write === "function") {
    return navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) })]);
  }
  return text.then((value) => navigator.clipboard.writeText(value));
}
