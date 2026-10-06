import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

/**
 * A clipboard write never waits on anything in the click that asked for it.
 *
 * WebKit allows `navigator.clipboard.writeText` only inside the click, and an
 * `await` before it ends that window: the write is refused ("The request is
 * not allowed by the user agent…"). Two buttons shipped that way, the
 * Pipeline's Copy (it built the report first) and the review grant's one-time
 * Copy link (it asked Rust for the code first), and no test saw either,
 * because the Playwright suite runs Chromium, which keeps the window open
 * across awaits. Text that is not ready yet goes through `copyText`
 * (lib/clipboard), which starts the write in the click with a promise.
 */
const ROOT = resolve(__dirname, "..");
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const isWriteText = (node: ts.Node) => ts.isCallExpression(node) && node.expression.getText() === "navigator.clipboard.writeText";
const isFunction = (node: ts.Node) => ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node);

describe("clipboard writes from a click", () => {
  const writes: { file: string; line: number; awaitedBefore: boolean }[] = [];
  for (const file of walk(ROOT)) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("navigator.clipboard.writeText")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node) => {
      if (isWriteText(node)) {
        let owner: ts.Node | undefined = node.parent;
        while (owner && !isFunction(owner)) owner = owner.parent;
        let awaitedBefore = false;
        // An await anywhere in the same function before this call, not counting nested functions or the call's own arguments.
        const scan = (inner: ts.Node) => {
          if (inner !== owner && isFunction(inner)) return;
          if (ts.isAwaitExpression(inner) && inner.getEnd() <= node.getStart()) awaitedBefore = true;
          if (inner.getStart() < node.getStart()) ts.forEachChild(inner, scan);
        };
        if (owner) ts.forEachChild(owner, scan);
        // `writeText(await …)` waits too.
        if ((node as ts.CallExpression).arguments.some((argument) => ts.isAwaitExpression(argument))) awaitedBefore = true;
        writes.push({ file: file.slice(ROOT.length + 1), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, awaitedBefore });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  it("finds the app's clipboard writes", () => {
    expect(writes.length, "no clipboard writes found: the scan is looking in the wrong place").toBeGreaterThan(5);
  });

  it("never awaits anything before writing, in the same function", () => {
    const offenders = writes.filter((write) => write.awaitedBefore).map((write) => `${write.file}:${write.line}`);
    expect(offenders, "Build the text after the click has started the write: copyText(promise) from lib/clipboard").toEqual([]);
  });
});
