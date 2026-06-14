import type { ReactNode } from "react";

/**
 * Tiny, dependency-free Markdown renderer for AI-summary output.
 *
 * The model is prompted to emit GitHub-flavoured markdown using `-` bullets and
 * `1.` numbered lists, blank lines between blocks, and NO `**`/`*` emphasis.
 * This line-oriented block parser turns that into real <ul>/<ol>/<p>/<h*> with
 * proper spacing (the user wanted bullets + numbers, not raw asterisks). It
 * renders `**bold**` as <strong> and strips any stray lone `*`/`_` so leaked
 * emphasis never reaches the screen as literal characters.
 *
 * Deliberately small: we control the input, so a full CommonMark parser (and
 * its dependency graph) would be overkill — see the constitution.
 */

// Drop leftover asterisks (stray emphasis markers), keep the words. We only
// strip `*` — not `_` — so snake_case words survive. No lookbehind (keeps the
// regex valid on older WebKit / macOS 13.0–13.2).
function plain(s: string, key: number): ReactNode {
  return <span key={key}>{s.replace(/\*/g, "")}</span>;
}

// Split a line into text + <strong> spans (bold first, then de-emphasise rest).
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(plain(text.slice(last, m.index), k++));
    out.push(<strong key={k++}>{m[1]}</strong>);
    last = re.lastIndex;
  }
  out.push(plain(text.slice(last), k++));
  return out;
}

const isHeading = (l: string) => /^(#{1,3})\s+/.test(l);
const isBullet = (l: string) => /^\s*[-*+]\s+/.test(l);
const isNumbered = (l: string) => /^\s*\d+\.\s+/.test(l);

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; } // blank → block separator

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const level = Math.min(4, h[1].length + 1); // # → h2, so no h1 inside a card
      const Tag = `h${level}` as "h2" | "h3" | "h4";
      blocks.push(<Tag key={key++} className="cp-md-h">{renderInline(h[2])}</Tag>);
      i++;
      continue;
    }

    if (isBullet(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isBullet(lines[i])) {
        items.push(<li key={key++}>{renderInline(lines[i].replace(/^\s*[-*+]\s+/, ""))}</li>);
        i++;
      }
      blocks.push(<ul key={key++} className="cp-md-ul">{items}</ul>);
      continue;
    }

    if (isNumbered(line)) {
      const items: ReactNode[] = [];
      while (i < lines.length && isNumbered(lines[i])) {
        items.push(<li key={key++}>{renderInline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>);
        i++;
      }
      blocks.push(<ol key={key++} className="cp-md-ol">{items}</ol>);
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isHeading(lines[i]) && !isBullet(lines[i]) && !isNumbered(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(<p key={key++} className="cp-md-p">{renderInline(para.join(" "))}</p>);
  }

  return <div className="cp-md">{blocks}</div>;
}
